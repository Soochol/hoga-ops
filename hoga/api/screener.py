from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path

import polars as pl
from fastapi import APIRouter, HTTPException

from hoga.api import screener_saves, screener_scan, screener_store
from hoga.api.screener_store import DailyBar
from hoga.api.calendar import trading_days_in_range
from hoga.api.models import (
    SavedScreener,
    SavedScreenersFile,
    ScanRequest,
    ScreenerResponse,
    ScreenerSaveWriteRequest,
)
from hoga.api.symbols import _RefreshCoordinator
from hoga.collector.orchestrator import next_kst_day, now_kst
from hoga.live import kis_runtime
from hoga.live.kis_client import KIS_KST, KisAuthError

log = logging.getLogger(__name__)

# Single-flight coordinator shared by all 3 triggers (scheduler EOD,
# startup recovery, manual POST) so concurrent triggers run ONE catch-up.
_update_coordinator: _RefreshCoordinator[int] = _RefreshCoordinator()


def _gap_trading_days(last_raw_date: str, today: str) -> list[str]:
    """last_raw_date 다음날부터 today(KST)까지의 거래일 목록. 갭 없으면 [].
    trading_days_in_range 예외(KIS 거래일 먹통)는 전파 — 호출자가 0/None 으로 다르게 매핑한다.
    trigger_update(갭 캐치업)와 status(days_behind)가 공유하는 단일 갭 규칙."""
    start = next_kst_day(last_raw_date)
    if start > today:
        return []
    return trading_days_in_range(start, today)


async def _kis_fetch_one(client, code: str, frm: str, to: str) -> list[DailyBar]:
    res = await client.fetch_past_daily_candles(code, frm, to, adjust=False)  # 원주가
    if res.violations:
        log.warning("screener daily violations %s: %d", code, len(res.violations))
    return [DailyBar(code=code,
                     date=datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(),
                     open=float(c.open), high=float(c.high),
                     low=float(c.low), close=float(c.close), volume=c.volume)
            for c in res.candles]


async def trigger_update(data_dir: Path, *, bus=None) -> int:
    """Single-flight EOD gap catch-up. Returns # of trading days appended.

    Short-circuits to 0 when the archive isn't seeded (no
    daily_unadjusted.parquet) — this is the FIRST thing checked so no
    calendar/KIS work runs in unseeded test/boot data dirs.
    """
    sdir = data_dir / "screener"
    # 동기 duckdb/polars read 는 to_thread 로 — 이벤트 루프 블로킹 방지(_commit 과 동일 규칙).
    last = await asyncio.to_thread(
        screener_store.last_raw_date, sdir / "daily_unadjusted.parquet")
    if last is None:
        return 0  # not seeded — nothing to catch up

    today = now_kst().strftime("%Y%m%d")
    try:
        # to_thread: 콜드 월이면 KIS chk-holiday sync HTTP — duckdb read 와 같은
        # 규칙으로 이벤트 루프 밖에서.
        days = await asyncio.to_thread(_gap_trading_days, last, today)
    except Exception:  # noqa: BLE001 — TradingDayUnavailableError or worse
        log.warning("screener update: trading-day list unavailable")
        return 0
    if not days:
        return 0  # no gap (normal no-gap day) or empty range

    stocks_df = await asyncio.to_thread(pl.read_parquet, sdir / "stocks.parquet")
    codes = stocks_df["code"].to_list()   # 무거운 read 는 스레드로; 인메모리 추출만 루프

    # EOD 갭 캐치업은 배경 배치(장 마감 후, 종목 다수 daily fetch) → background 계정으로
    # 라우팅(계정 분리 2026-06-09): N=2면 account 1(유휴 REST 버킷)을 써서, 마감 후
    # 사용자가 차트를 보면(account 0 foreground) 경합하지 않게 한다. N=1/저하면 account 0.
    # 게이트: creds 존재만 확인(없으면 skip). 실제 client는 fetch_one이 per-code로 재해결.
    if kis_runtime.kis_for_role("background", data_dir) is None:
        log.warning("screener update: KIS creds missing, skipping")
        return 0

    async def fetch_one(c: str, f: str, t: str) -> list[DailyBar]:
        # FM5: account 1 토큰 발급 실패 시 첫 코드에서 provider 콜백이 latch를 켜고
        # KisAuthError가 난다. run_update는 gather(return_exceptions 없음)라 한 코드
        # 실패가 배치 전체를 중단시키므로, 여기서 account 0로 재해결해 재시도한다(latch
        # 덕에 재해결이 account 0을 반환 → 배치가 끝까지 진행). account 0 자체가 실패하거나
        # N=1(재해결이 동일 client)이면 전파해 run_update가 실패를 표면화(침묵 사망 금지).
        client = kis_runtime.kis_for_role("background", data_dir)
        if client is None:
            raise KisAuthError("screener: no background KIS client available")
        try:
            return await _kis_fetch_one(client, c, f, t)
        except KisAuthError:
            client0 = kis_runtime.kis_for_role("background", data_dir)
            if client0 is None or client0 is client:
                raise
            log.warning("screener update: background account auth failed, retrying on account 0")
            return await _kis_fetch_one(client0, c, f, t)

    async def _do() -> int:
        n = await screener_store.run_update(
            sdir, codes=codes, fetch_one=fetch_one, trading_days=days,
            now_ms=int(time.time() * 1000))
        if bus is not None:
            bus.publish({"type": "screener.update", "done": len(codes), "total": len(codes)})
        return n

    return await _update_coordinator.coalesce(lambda: asyncio.create_task(_do()))


def _save_not_found(save_id: str) -> HTTPException:
    return HTTPException(
        404, {"code": "save_not_found", "message": f"No saved screener {save_id}"})


def build_router(*, data_dir: Path, bus=None) -> APIRouter:
    router = APIRouter(prefix="/api/screener", tags=["screener"])
    sdir = data_dir / "screener"

    @router.post("/scan")
    def scan(req: ScanRequest) -> ScreenerResponse:
        if not (sdir / "status.json").exists():
            return ScreenerResponse(status="not_seeded", rows=[])
        rows = screener_scan.run_scan(
            sdir / "daily_adjusted.parquet", sdir / "stocks.parquet",
            conditions=req.conditions, universe=req.universe, limit=req.limit)
        return ScreenerResponse(status="ok", rows=rows)

    @router.get("/status")
    def status() -> dict:
        s = screener_store.read_status(sdir / "status.json")
        if s is None:
            return {"status": "not_seeded"}
        # TRADING-day freshness for the frontend StalenessChip: count trading
        # days from the day AFTER last_raw_date through today KST. A calendar-
        # day proxy shows false-amber on weekends. Mirror trigger_update's gap
        # logic (same next_kst_day + start>today short-circuit) so the
        # inverted-range ValueError never fires. KRX outage → None (frontend
        # treats None as unknown), never crash the status route.
        today = now_kst().strftime("%Y%m%d")
        if s.last_raw_date is None:
            days_behind = None  # 유효 거래일 없음(빈/NULL-date 아카이브) → 신선도 불명
        else:
            try:
                days_behind = len(_gap_trading_days(s.last_raw_date, today))
            except Exception:  # noqa: BLE001 — TradingDayUnavailableError or worse
                days_behind = None
        return {**s.model_dump(), "status": "ok", "days_behind": days_behind}

    @router.post("/update")
    async def update() -> dict:
        n = await trigger_update(data_dir, bus=bus)
        return {"updated": n}

    @router.post("/saves", status_code=201, response_model=SavedScreener)
    async def create_save(req: ScreenerSaveWriteRequest) -> SavedScreener:
        return await screener_saves.create_save(
            data_dir, req=req, id=uuid.uuid4().hex, now_ms=int(time.time() * 1000))

    @router.get("/saves", response_model=SavedScreenersFile)
    async def list_saves() -> SavedScreenersFile:
        # Return the whole file so schema_version comes from the single
        # source of truth (the model default) and can't drift from a
        # hardcoded literal. Response shape stays {schema_version, saves}.
        return screener_saves.load_saves(data_dir)

    @router.get("/saves/{save_id}", response_model=SavedScreener)
    async def get_save(save_id: str) -> SavedScreener:
        try:
            return await screener_saves.get_save(data_dir, id=save_id)
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise _save_not_found(save_id) from e

    @router.put("/saves/{save_id}", response_model=SavedScreener)
    async def update_save(save_id: str, req: ScreenerSaveWriteRequest) -> SavedScreener:
        try:
            return await screener_saves.update_save(
                data_dir, id=save_id, req=req, now_ms=int(time.time() * 1000))
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise _save_not_found(save_id) from e

    @router.delete("/saves/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await screener_saves.delete_save(data_dir, id=save_id)
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise _save_not_found(save_id) from e

    return router

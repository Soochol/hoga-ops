from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import polars as pl
from fastapi import APIRouter, HTTPException

from hoga.api import screener_runner, screener_saves, screener_store
from hoga.api.screener_store import DailyBar
from hoga.api.calendar import trading_days_in_range
from hoga.api.models import (
    SavedScreener,
    SavedScreenersFile,
    ScanRequest,
    ScreenerResponse,
    ScreenerSaveWriteRequest,
)
from hoga.collector.orchestrator import next_kst_day, now_kst
from hoga.live import kis_access
from hoga.live.kis_capacity_runtime import ensure_kis_capacity_scheduler
from hoga.live.kis_client import KIS_KST

log = logging.getLogger(__name__)


@dataclass
class _UpdateProgress:
    done: int
    total: int
    started_ms: int


@dataclass
class _UpdatePlan:
    sdir: Path
    codes: list[str]
    days: list[str]


# 서버-소유 갱신 job. 요청·스케줄러 어느 쪽 awaiter가 취소돼도 job은 살아남는다 —
# 이전 _RefreshCoordinator 는 임의 waiter 의 취소가 공유 future 를 취소시켜
# flight 전체(스케줄러 몫 포함)를 죽였다(브라우저 disconnect → 전량 유실).
# 슬롯 갱신은 전부 단일 이벤트 루프에서 await 없이 일어나므로 락 불필요.
_progress: _UpdateProgress | None = None
_job_task: asyncio.Task[int] | None = None
_module_bus = None  # EventBus | None — build_router 가 주입(스케줄러발 job 도 이벤트 발행)
_PROGRESS_MIN_INTERVAL_S = 1.0  # 진행 이벤트 스로틀(테스트는 0으로 monkeypatch)


# 스펙 D6 — 스크리너 EOD ingest 컷오프 = 16:00 KST. 정규장 종가(15:30) 확정 +
# After-Hours(15:30–16:00) 버퍼. 이 시각 전의 "오늘" 일봉은 KIS가 줘도 미확정이므로
# 갭에서 제외한다 — 장중 미확정 행이 아카이브에 박제되는 것을 막는다(그렇게 박제되면
# last_raw_date 가 오늘로 올라가 이후 no_gap 으로 재fetch까지 차단되어, 확정값으로
# 자가 교체되지 않는 오염이 된다). captures 경로의 16:30 is_today_too_early(hogaplay
# 집계 lag 버퍼)와는 목적·값이 다르다.
_SCREENER_EOD_CUTOFF_HOUR = 16


def _gap_trading_days(last_raw_date: str, today: str, *, now: datetime) -> list[str]:
    """last_raw_date 다음날부터 today(KST)까지의 거래일 목록. 갭 없으면 [].
    trading_days_in_range 예외(KIS 거래일 먹통)는 전파 — 호출자가 0/None 으로 다르게 매핑한다.
    now < 16:00 KST 면 오늘(미확정)을 제외(스펙 D6). trigger_update(갭 캐치업)와
    status(days_behind)가 공유하는 단일 갭 규칙."""
    start = next_kst_day(last_raw_date)
    if start > today:
        return []
    days = trading_days_in_range(start, today)
    if now.hour < _SCREENER_EOD_CUTOFF_HOUR:
        days = [d for d in days if d < today]
    return days


async def _kis_fetch_one(client, code: str, frm: str, to: str) -> list[DailyBar]:
    res = await client.fetch_past_daily_candles(code, frm, to, adjust=False)  # 원주가
    if res.violations:
        log.warning("screener daily violations %s: %d", code, len(res.violations))
    return [DailyBar(code=code,
                     date=datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(),
                     open=float(c.open), high=float(c.high),
                     low=float(c.low), close=float(c.close), volume=c.volume)
            for c in res.candles]


async def _plan_update(data_dir: Path) -> _UpdatePlan | str:
    """갱신 사전 체크. 작업이 없으면 skip reason 문자열을 반환한다.

    unseeded 체크가 가장 먼저 — 시드되지 않은 테스트/부트 데이터 디렉토리에서
    calendar/KIS 작업이 돌지 않는 기존 계약 유지.
    """
    sdir = data_dir / "screener"
    # 동기 duckdb/polars read 는 to_thread 로 — 이벤트 루프 블로킹 방지(_commit 과 동일 규칙).
    last = await asyncio.to_thread(
        screener_store.last_raw_date, sdir / "daily_unadjusted.parquet")
    if last is None:
        return "not_seeded"

    now = now_kst()
    today = now.strftime("%Y%m%d")
    try:
        # to_thread: 콜드 월이면 KIS chk-holiday sync HTTP — duckdb read 와 같은
        # 규칙으로 이벤트 루프 밖에서.
        days = await asyncio.to_thread(_gap_trading_days, last, today, now=now)
    except Exception:  # noqa: BLE001 — TradingDayUnavailableError or worse
        log.warning("screener update: trading-day list unavailable")
        return "calendar_unavailable"
    if not days:
        return "no_gap"

    # EOD 갭 캐치업은 배경 배치(종목 다수 daily fetch)이므로 Capacity Scheduler에 맡긴다.
    # creds가 없으면 기존처럼 skip하고, 있으면 per-code 요청이 계정풀/쿨다운/예약용량 정책을 탄다.
    if not kis_access.has_rest_capacity(data_dir):
        log.warning("screener update: KIS creds missing, skipping")
        return "kis_creds_missing"

    stocks_df = await asyncio.to_thread(pl.read_parquet, sdir / "stocks.parquet")
    codes = stocks_df["code"].to_list()   # 무거운 read 는 스레드로; 인메모리 추출만 루프
    return _UpdatePlan(sdir=sdir, codes=codes, days=days)


def _ensure_job(data_dir: Path, plan: _UpdatePlan, *, bus) -> asyncio.Task[int]:
    """살아있는 job 이 있으면 join, 없으면 스폰. await 없는 동기 함수라 race-free."""
    global _job_task, _progress  # noqa: PLW0603
    if _job_task is not None and not _job_task.done():
        return _job_task
    _progress = _UpdateProgress(
        done=0, total=len(plan.codes), started_ms=int(time.time() * 1000))
    _job_task = asyncio.create_task(
        _run_update_job(data_dir, plan, bus=bus), name="screener-update")
    return _job_task


async def _run_update_job(data_dir: Path, plan: _UpdatePlan, *, bus) -> int:
    global _job_task, _progress  # noqa: PLW0603
    total = len(plan.codes)
    try:
        scheduler = ensure_kis_capacity_scheduler(data_dir)

        async def fetch_one(c: str, f: str, t: str) -> list[DailyBar]:
            return await kis_access.run_with_capacity(
                scheduler,
                data_dir=data_dir,
                key=("screener-update", c, f, t),
                endpoint=kis_access.KisRestEndpoint.SCREENER_DAILY,
                priority="background",
                cooldown_scope="screener-daily",
                fetch_fn=lambda client: _kis_fetch_one(client, c, f, t),
            )

        last_pub = 0.0

        async def counting_fetch_one(c: str, f: str, t: str) -> list[DailyBar]:
            nonlocal last_pub
            try:
                return await fetch_one(c, f, t)
            finally:
                if _progress is not None:
                    _progress.done += 1
                    now_mono = time.monotonic()
                    if bus is not None and (
                            now_mono - last_pub >= _PROGRESS_MIN_INTERVAL_S
                            or _progress.done == total):
                        last_pub = now_mono
                        bus.publish({"type": "screener_update_progress",
                                     "done": _progress.done, "total": total})

        if bus is not None:  # 시작 즉시 0/total — 클릭하지 않은 서피스도 바로 표시 전환
            bus.publish({"type": "screener_update_progress", "done": 0, "total": total})
        n = await screener_store.run_update(
            plan.sdir, codes=plan.codes, fetch_one=counting_fetch_one,
            trading_days=plan.days, now_ms=int(time.time() * 1000))
        if bus is not None:
            bus.publish({"type": "screener_update_finished",
                         "updated": n, "total": total, "reason": None})
        return n
    except asyncio.CancelledError:
        if bus is not None:
            bus.publish({"type": "screener_update_finished",
                         "updated": 0, "total": total, "reason": "cancelled"})
        raise
    except Exception:
        log.exception("screener update job failed")
        if bus is not None:
            bus.publish({"type": "screener_update_finished",
                         "updated": 0, "total": total, "reason": "error"})
        raise
    finally:
        _progress = None
        _job_task = None


async def trigger_update(data_dir: Path, *, bus=None) -> int:
    """스케줄러 경로 — EOD 갭 캐치업을 실제 완료까지 await. 추가된 거래일 수 반환.

    작업이 없으면(unseeded/no-gap/creds/calendar) 0 — 기존 계약 유지. 동시
    트리거(스케줄러 EOD + 수동 POST)는 _ensure_job 이 단일 job 으로 join 한다.
    """
    plan = await _plan_update(data_dir)
    if isinstance(plan, str):
        return 0
    task = _ensure_job(data_dir, plan, bus=bus if bus is not None else _module_bus)
    # shield: awaiter(스케줄러 셧다운, 버려진 caller) 취소가 공유 job 을 죽이지
    # 않는다. job 자체의 예외는 그대로 전파 — 스케줄러 try/except 로깅 의미론 유지.
    return await asyncio.shield(task)


async def start_update(data_dir: Path, *, bus=None) -> dict:
    """엔드포인트 경로 — job 을 스폰만 하고 즉시 반환(완료를 await 하지 않음).

    핸들러가 job 을 await 하지 않으므로 클라이언트 disconnect 로 인한 핸들러
    취소가 job 에 닿지 않는다. 진행/완료는 bus 이벤트와 status.updating 으로 전달.
    """
    if _job_task is not None and not _job_task.done() and _progress is not None:
        return {"running": True, "done": _progress.done, "total": _progress.total}
    plan = await _plan_update(data_dir)
    if isinstance(plan, str):
        return {"running": False, "updated": 0, "reason": plan}
    _ensure_job(data_dir, plan, bus=bus if bus is not None else _module_bus)
    return {"running": True, "done": 0, "total": len(plan.codes)}


async def shutdown_update_job() -> None:
    """lifespan 셧다운: KIS 클라이언트 teardown 전에 detached job 을 cancel+await."""
    task = _job_task
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


def reset_update_job_for_tests() -> None:
    global _job_task, _progress, _module_bus  # noqa: PLW0603
    if _job_task is not None and not _job_task.done():
        # 이전 테스트의 (이미 닫힌) 루프에 속한 태스크면 cancel 이 RuntimeError.
        with contextlib.suppress(RuntimeError):
            _job_task.cancel()
    _job_task = None
    _progress = None
    _module_bus = None


def _save_not_found(save_id: str) -> HTTPException:
    return HTTPException(
        404, {"code": "save_not_found", "message": f"No saved screener {save_id}"})


def build_router(*, data_dir: Path, bus=None) -> APIRouter:
    global _module_bus  # noqa: PLW0603
    _module_bus = bus   # 스케줄러발 trigger_update(bus 미전달)도 같은 버스로 발행
    router = APIRouter(prefix="/api/screener", tags=["screener"])
    sdir = data_dir / "screener"

    @router.post("/scan")
    async def scan(req: ScanRequest) -> ScreenerResponse:
        return await screener_runner.run_screener_scan(data_dir=data_dir, req=req)

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
        now = now_kst()
        today = now.strftime("%Y%m%d")
        if s.last_raw_date is None:
            days_behind = None  # 유효 거래일 없음(빈/NULL-date 아카이브) → 신선도 불명
        else:
            try:
                days_behind = len(_gap_trading_days(s.last_raw_date, today, now=now))
            except Exception:  # noqa: BLE001 — TradingDayUnavailableError or worse
                days_behind = None
        return {
            **s.model_dump(),
            "status": "ok",
            "days_behind": days_behind,
            # 진행 중 갱신 job — 재진입/드로어가 WS 이벤트 없이도 상태를 복원한다.
            "updating": (
                {"done": _progress.done, "total": _progress.total,
                 "started_ms": _progress.started_ms}
                if _progress is not None else None
            ),
        }

    @router.post("/update")
    async def update() -> dict:
        return await start_update(data_dir, bus=bus)

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

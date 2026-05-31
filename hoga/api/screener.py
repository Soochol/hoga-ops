from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import polars as pl
from fastapi import APIRouter

from hoga.api import screener_scan, screener_store
from hoga.api.calendar import trading_days_in_range
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.api.symbols import _RefreshCoordinator
from hoga.live import lifecycle
from hoga.live.kis_client import KIS_KST, KisCredentials

log = logging.getLogger(__name__)

# Single-flight coordinator shared by all 3 triggers (scheduler EOD,
# startup recovery, manual POST) so concurrent triggers run ONE catch-up.
_update_coordinator: _RefreshCoordinator[int] = _RefreshCoordinator()


def _next_kst_day(yyyymmdd: str) -> str:
    d = date(int(yyyymmdd[0:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]))
    return (d + timedelta(days=1)).strftime("%Y%m%d")


async def _kis_fetch_one(client, code: str, frm: str, to: str) -> list[dict]:
    res = await client.fetch_past_daily_candles(code, frm, to, adjust=False)  # 원주가
    if res.violations:
        log.warning("screener daily violations %s: %d", code, len(res.violations))
    return [{"code": code,
             "date": datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).date(),
             "open": float(c.open), "high": float(c.high),
             "low": float(c.low), "close": float(c.close), "volume": c.volume}
            for c in res.candles]


async def trigger_update(data_dir: Path, *, bus=None) -> int:
    """Single-flight EOD gap catch-up. Returns # of trading days appended.

    Short-circuits to 0 when the archive isn't seeded (no
    daily_unadjusted.parquet) — this is the FIRST thing checked so no
    calendar/KIS work runs in unseeded test/boot data dirs.
    """
    sdir = data_dir / "screener"
    last = screener_store.last_raw_date(sdir / "daily_unadjusted.parquet")
    if last is None:
        return 0  # not seeded — nothing to catch up

    today = datetime.now(KIS_KST).strftime("%Y%m%d")
    start = _next_kst_day(last)
    if start > today:
        return 0  # no gap (normal no-gap day) — avoid ValueError + warning noise
    try:
        days = trading_days_in_range(start, today)
    except Exception:  # noqa: BLE001 — KrxUnavailableError or worse
        log.warning("screener update: trading-day list unavailable")
        return 0
    if not days:
        return 0

    codes = pl.read_parquet(sdir / "stocks.parquet")["code"].to_list()

    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        log.warning("screener update: KIS creds missing, skipping")
        return 0
    creds = KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
    client = lifecycle.ensure_kis_client(data_dir / ".local" / "kis-token.json", creds)

    async def fetch_one(c: str, f: str, t: str) -> list[dict]:
        return await _kis_fetch_one(client, c, f, t)

    async def _do() -> int:
        n = await screener_store.run_update(
            sdir, codes=codes, fetch_one=fetch_one, trading_days=days,
            now_ms=int(time.time() * 1000))
        if bus is not None:
            bus.publish({"type": "screener.update", "done": len(codes), "total": len(codes)})
        return n

    return await _update_coordinator.coalesce(lambda: asyncio.create_task(_do()))


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
        # logic (same _next_kst_day + start>today short-circuit) so the
        # inverted-range ValueError never fires. KRX outage → None (frontend
        # treats None as unknown), never crash the status route.
        today = datetime.now(KIS_KST).strftime("%Y%m%d")
        start = _next_kst_day(s.last_raw_date)
        try:
            days_behind = 0 if start > today else len(trading_days_in_range(start, today))
        except Exception:  # noqa: BLE001 — KrxUnavailableError or worse
            days_behind = None
        return {**s.model_dump(), "status": "ok", "days_behind": days_behind}

    @router.post("/update")
    async def update() -> dict:
        n = await trigger_update(data_dir, bus=bus)
        return {"updated": n}

    return router

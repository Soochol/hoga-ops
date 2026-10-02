"""Observed seconds from live aggregates or original historical executions."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from hoga.api.error_codes import LiveErrorCode
from hoga.api.models import SecondAggregatesResponse, SecondTradeDatesResponse
from hoga.api.params import CODE_PATTERN
from hoga.util.timeenc import KST

from .second_trade_agg import SecondTradeBar
from .second_trade_delta import SecondResponseRevisions
from .second_trade_history import historical_second_rows
from .second_trade_projection import _project_response
from .second_trade_store import second_trade_store


def build_router(*, data_dir: Path) -> APIRouter:  # noqa: PLR0915 — two projection routes
    router = APIRouter(prefix="/api/live", tags=["live"])
    store = second_trade_store(data_dir)
    revisions = SecondResponseRevisions()

    async def collector_snapshot(code, venue, date=None):
        from .lifecycle import get_capture_session  # noqa: PLC0415 — injected lifecycle owner
        if date is not None and date != datetime.now(KST).strftime("%Y%m%d"):
            return None  # Historical disk reads do not depend on a live child.
        owner = get_capture_session()
        remote = getattr(owner, "seconds_snapshot", None)
        if remote is None:
            return None
        try:
            return await remote(code, venue, date)
        except (ConnectionError, TimeoutError) as exc:
            raise HTTPException(503, {"code": LiveErrorCode.NOT_WIRED,
                                      "message": "Live Capture process unavailable"}) from exc

    @router.get("/second-trade-dates", response_model=SecondTradeDatesResponse)
    async def get_dates(
        code: str = Query(pattern=CODE_PATTERN),
        venue: Literal["KRX", "NXT", "UN"] = "KRX",
    ) -> SecondTradeDatesResponse:
        def disk_dates() -> set[str]:
            found: set[str] = set()
            for root in (store.root, data_dir / "parquet"):
                if not root.exists():
                    continue
                for path in root.iterdir():
                    if not path.is_dir() or not re.fullmatch(r"\d{8}", path.name):
                        continue
                    journal = store.path(code, venue, path.name)
                    original = path / code / "hogaplay" / "trades.parquet"
                    if ((journal.is_file() and journal.stat().st_size > 0)
                            or (store.root / path.name / venue / code / "manifest.json").is_file()
                            or (root.name == "parquet" and venue == "KRX" and original.is_file())):
                        found.add(path.name)
            return found

        snapshot = await collector_snapshot(code, venue)
        live_dates = set(snapshot["dates"]) if snapshot is not None else store.live_dates(code, venue)
        dates = await asyncio.to_thread(disk_dates)
        return SecondTradeDatesResponse(dates=sorted(dates | live_dates))

    @router.get("/second-aggregates", response_model=SecondAggregatesResponse)
    async def get_seconds(
        code: str = Query(pattern=CODE_PATTERN),
        date: str = Query(pattern=r"^\d{8}$"),
        venue: Literal["KRX", "NXT", "UN"] = "KRX",
        seconds: int = Query(default=10, json_schema_extra={"enum": [1, 5, 10, 30]}),
        from_ms: int | None = Query(default=None, ge=0),
        to_ms: int | None = Query(default=None, ge=0),
        include_prices: bool = False,
        regular_session_only: bool = False,
        incremental: bool = False,
        since_revision: str | None = Query(default=None, max_length=64),
    ) -> SecondAggregatesResponse:
        if seconds not in (1, 5, 10, 30):
            raise HTTPException(422, "Unsupported seconds timeframe")
        try:
            day_start = int(datetime.strptime(date, "%Y%m%d").replace(tzinfo=KST).timestamp() * 1000)
        except ValueError as exc:
            raise HTTPException(422, "Invalid trading date") from exc
        start = from_ms if from_ms is not None else day_start
        end = to_ms if to_ms is not None else day_start + 86_400_000
        if start >= end or start < day_start or end > day_start + 86_400_000:
            raise HTTPException(422, "Range must be within the requested trading date")
        # Copy live state on the event loop before yielding to disk workers. A
        # disk revision newer than this snapshot wins, preventing volume rollback.
        snapshot = await collector_snapshot(code, venue, date)
        live = snapshot["live"] if snapshot is not None else store.live_rows(code, venue, date)
        pending = snapshot["pending"] if snapshot is not None else store.pending_corrections(code, venue, date)
        storage_error = snapshot["error"] if snapshot is not None else store.storage_error
        disk = await asyncio.to_thread(store.disk_rows, code, venue, date)
        merged = {row["t_ms"]: row for row in disk}
        for row in live:
            old = merged.get(row["t_ms"])
            if old is None or row["revision"] >= old["revision"]:
                merged[row["t_ms"]] = row
        for correction in pending:
            trade, seq = correction["trade"], correction["seq"]
            t = trade["t_ms"] // 1000 * 1000
            bar = SecondTradeBar.restore(merged[t]) if t in merged else SecondTradeBar(t)
            if seq > bar.applied_late_seq:
                bar.ingest(seq=seq, **trade)
                bar.applied_late_seq = seq
                merged[t] = bar.record()
        source = "second_trades" if merged else None
        # Select one source for the entire day. Never add historical volumes to
        # overlapping live seconds or interpret 10s price bins as ordered ticks.
        if not merged:
            history = await asyncio.to_thread(historical_second_rows, data_dir, code, venue, date)
            if history:
                merged = {row["t_ms"]: row for row in history}
                source = "hogaplay"
        scope = (code, venue, date, seconds, start, end, include_prices, regular_session_only, day_start)
        if incremental:
            return await asyncio.to_thread(revisions.project_rows, scope, merged, source,
                                           storage_error, since_revision)
        return await asyncio.to_thread(_project_response, merged, scope, source, storage_error)

    return router

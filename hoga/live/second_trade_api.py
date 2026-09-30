"""Observed second bars and their shared price histogram (no legacy fallback)."""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from hoga.api.models import SecondAggregatesResponse, SecondBarModel, SecondPriceModel
from hoga.api.params import CODE_PATTERN
from hoga.util.timeenc import KST

from .second_trade_agg import SecondTradeBar, aggregate_bars
from .second_trade_store import second_trade_store


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/live", tags=["live"])
    store = second_trade_store(data_dir)

    @router.get("/second-aggregates", response_model=SecondAggregatesResponse)
    async def get_seconds(
        code: str = Query(pattern=CODE_PATTERN),
        date: str = Query(pattern=r"^\d{8}$"),
        venue: Literal["KRX", "NXT", "UN"] = "KRX",
        seconds: int = Query(default=10, json_schema_extra={"enum": [1, 5, 10, 30]}),
        from_ms: int | None = Query(default=None, ge=0),
        to_ms: int | None = Query(default=None, ge=0),
        include_prices: bool = False,
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
        live = store.live_rows(code, venue, date)
        pending = store.pending_corrections(code, venue, date)
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
        rows = sorted((row for t, row in merged.items() if start <= t < end), key=lambda r: r["t_ms"])
        bars = aggregate_bars(rows, seconds * 1000)
        return SecondAggregatesResponse(
            code=code, venue=venue, date=date, seconds=seconds,
            status="observed" if rows else "unavailable",
            coverage="unverified", storage_error=store.storage_error,
            first_observed_ms=min(row["first"][0] for row in merged.values()) if merged else None,
            last_observed_ms=max(row["last"][0] for row in merged.values()) if merged else None,
            bars=[SecondBarModel(**{k: row[k] for k in SecondBarModel.model_fields}) for row in bars],
            prices=[SecondPriceModel(t_ms=row["t_ms"], price=p, side=side, qty=qty, count=count)
                    for row in rows for p, side, qty, count in row["prices"]] if include_prices else [],
        )

    return router

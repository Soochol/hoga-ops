from __future__ import annotations

import asyncio
import datetime as dt
import time
from pathlib import Path

from hoga.api import screener_intraday, screener_scan, screener_universe
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.collector.orchestrator import now_kst


async def run_screener_scan(
    *,
    data_dir: Path,
    req: ScanRequest,
    now: dt.datetime | None = None,
) -> ScreenerResponse:
    sdir = data_dir / "screener"
    if not (sdir / "status.json").exists():
        return ScreenerResponse(status="not_seeded", rows=[])

    warnings: list[str] = []
    intraday_rows = None
    now_value = now or now_kst()
    if req.basis == "intraday":
        codes = await asyncio.to_thread(
            screener_universe.codes_for_universe,
            sdir / "stocks.parquet",
            req.universe,
        )
        overlay = await screener_intraday.build_intraday_overlay(
            data_dir=data_dir,
            codes=codes,
            today=now_value.strftime("%Y%m%d"),
            now_ms=int(time.time() * 1000),
        )
        intraday_rows = overlay.rows
        warnings.extend(overlay.warnings)
        if overlay.rows.height == 0:
            warnings.append("intraday_fallback_eod")

    rows = await asyncio.to_thread(
        screener_scan.run_scan,
        sdir / "daily_adjusted.parquet",
        sdir / "stocks.parquet",
        conditions=req.conditions,
        universe=req.universe,
        limit=req.limit,
        intraday_rows=intraday_rows,
    )
    return ScreenerResponse(status="ok", rows=rows, warnings=warnings)

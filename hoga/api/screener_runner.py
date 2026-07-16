from __future__ import annotations

import asyncio
import datetime as dt
import time
from pathlib import Path

from hoga.api import (
    screener_depth, screener_intraday, screener_scan, screener_universe,
)
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

    # 유니버스 스코프(관심∪히트맵) 1회 해석 — intraday overlay·depth·run_scan 세 경로가
    # 공유한다. None = 무제한(전체 시장). 빈 set = 스코프는 켰으나 대상 0종목 → 조건
    # 미충족과 구분되게 warning 을 붙인다(결과는 자연히 0행).
    scope = await asyncio.to_thread(
        screener_universe.scope_codes, data_dir, req.universe.scopes)
    if scope is not None and not scope:
        warnings.append("scope_universe_empty")

    if req.basis == "intraday":
        if screener_intraday.intraday_overlay_bypassed(data_dir):
            warnings.extend([
                "kis_rest_bypassed_intraday_overlay_skipped",
                "intraday_fallback_eod",
            ])
        else:
            codes = await asyncio.to_thread(
                screener_universe.codes_for_universe,
                sdir / "stocks.parquet",
                req.universe,
                scope=scope,
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

    depth_eval = None
    if screener_depth.has_depth_conditions(req.conditions):
        universe_codes = set(await asyncio.to_thread(
            screener_universe.codes_for_universe,
            sdir / "stocks.parquet",
            req.universe,
            scope=scope,
        ))
        depth_eval = await asyncio.to_thread(
            screener_depth.evaluate,
            data_dir=data_dir,
            sdir=sdir,
            conditions=req.conditions,
            universe_codes=universe_codes,
            basis=req.basis,
            today=now_value.strftime("%Y%m%d"),
        )
        warnings.extend(depth_eval.warnings)

    depth_pass = (
        {leaf_id: sorted(codes) for leaf_id, codes in depth_eval.passing.items()}
        if depth_eval is not None else None
    )
    rows = await asyncio.to_thread(
        screener_scan.run_scan,
        sdir / "daily_adjusted.parquet",
        sdir / "stocks.parquet",
        conditions=req.conditions,
        universe=req.universe,
        limit=req.limit,
        intraday_rows=intraday_rows,
        depth_pass=depth_pass,
        scope_codes=scope,
    )
    return ScreenerResponse(
        status="ok", rows=rows, warnings=warnings,
        depth_coverage=depth_eval.coverage if depth_eval is not None else None,
        depth_values=depth_eval.values if depth_eval is not None else None,
    )

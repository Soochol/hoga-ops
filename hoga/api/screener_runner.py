from __future__ import annotations

import asyncio
import datetime as dt
import time
from pathlib import Path

from hoga.api import (
    screener_depth,
    screener_exclusions,
    screener_history_coverage,
    screener_intraday,
    screener_scan,
    screener_universe,
    symbols,
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
    intraday_failure: dict | None = None
    intraday_rows = None
    now_value = now or now_kst()

    # 유니버스 스코프(관심∪히트맵) 1회 해석 — intraday overlay·depth·run_scan 세 경로가
    # 공유한다. None = 무제한(전체 시장). 빈 set = 스코프는 켰으나 대상 0종목 → 조건
    # 미충족과 구분되게 warning 을 붙인다(결과는 자연히 0행).
    scope = await asyncio.to_thread(
        screener_universe.scope_codes, data_dir, req.universe.scopes)
    if scope is not None and not scope:
        warnings.append("scope_universe_empty")

    # "ETF 제외"의 판정 소스 = 심볼 마스터(순위 패널과 동일). 여기서 1회 해석해
    # intraday overlay·depth·run_scan 세 경로에 같은 집합을 흘린다 — 경로마다 다른
    # 유니버스를 보면 depth 통과 코드가 최종 JOIN 에서 사라지는 식으로 어긋난다.
    # None = 마스터 미로드 → stocks.parquet 의 (낡았을 수 있는) is_etf 로 강등.
    etf_codes = symbols.all_etf_etn_codes() if req.universe.exclude_etf else None
    if req.universe.exclude_etf and etf_codes is None:
        warnings.append("etf_filter_stale_master_unavailable")

    history = screener_history_coverage.history_leaves(req.conditions)
    if req.basis == "intraday" and (not history or len(history) != len(req.conditions)):
        if screener_intraday.intraday_overlay_bypassed(data_dir):
            warnings.extend([
                "rest_bypassed_intraday_overlay_skipped",
                "intraday_fallback_eod",
            ])
        else:
            codes = await asyncio.to_thread(
                screener_universe.codes_for_universe,
                sdir / "stocks.parquet",
                req.universe,
                scope=scope,
                etf_codes=etf_codes,
            )
            overlay = await screener_intraday.build_intraday_overlay(
                data_dir=data_dir,
                codes=codes,
                today=now_value.strftime("%Y%m%d"),
                now_ms=int(time.time() * 1000),
            )
            intraday_rows = overlay.rows
            warnings.extend(overlay.warnings)
            # 사유는 상태 태그와 갈라 실어 보낸다(ADR-0143) — 접두 없이, kind 동반.
            intraday_failure = overlay.failure
            if overlay.rows.height == 0:
                warnings.append("intraday_fallback_eod")

    depth_eval = None
    if screener_depth.has_depth_conditions(req.conditions):
        universe_codes = set(await asyncio.to_thread(
            screener_universe.codes_for_universe,
            sdir / "stocks.parquet",
            req.universe,
            scope=scope,
            etf_codes=etf_codes,
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
    history_eval = None
    if history:
        codes = await asyncio.to_thread(
            screener_universe.codes_for_universe, sdir / "stocks.parquet", req.universe,
            scope=scope, etf_codes=etf_codes)
        history_eval = await asyncio.to_thread(
            screener_history_coverage.evaluate, data_dir, req.conditions, codes)
    excluded = screener_exclusions.exclusion_keys(
        await asyncio.to_thread(screener_exclusions.load_exclusions, data_dir))
    occurrence_dates = _occurrence_dates(depth_eval, history_eval)
    rows = await asyncio.to_thread(
        screener_scan.run_scan,
        sdir / "daily_adjusted.parquet",
        sdir / "stocks.parquet",
        conditions=req.conditions,
        universe=req.universe,
        limit=req.limit + 1,
        intraday_rows=intraday_rows,
        depth_pass=depth_pass,
        scope_codes=scope,
        etf_codes=etf_codes,
        history_pass=history_eval.passing if history_eval else None,
        occurrence_dates=occurrence_dates, excluded=excluded,
    )
    if history_eval:
        _attach_history(rows, history_eval)
    return ScreenerResponse(
        history_coverage=history_eval.coverage if history_eval else None,
        status="ok", rows=rows[:req.limit], has_more=len(rows) > req.limit, warnings=warnings,
        scanned_at_ms=int(time.time() * 1000),
        intraday_failure=intraday_failure,
        depth_coverage=depth_eval.coverage if depth_eval is not None else None,
        depth_values=depth_eval.values if depth_eval is not None else None,
    )


def _occurrence_dates(depth_eval, history_eval):
    dates = dict(depth_eval.occurrence_dates) if depth_eval else {}
    if history_eval:
        for code, matches in history_eval.all_matches.items():
            for match in matches:
                dates.setdefault(match.condition_id, {}).setdefault(code, []).append(match.date)
    return dates


def _attach_history(rows, history_eval):
    for row in rows:
        active = {(m.condition_id, m.date) for m in row.occurrences}
        evidence = {(m.condition_id, m.date): m for m in history_eval.all_matches.get(row.code, [])}
        for occurrence in row.occurrences:
            occurrence.history_match = evidence.get((occurrence.condition_id, occurrence.date))
        latest = {}
        for match in history_eval.all_matches.get(row.code, []):
            if (match.condition_id, match.date) in active:
                old = latest.get(match.condition_id)
                if old is None or match.date > old.date:
                    latest[match.condition_id] = match
        row.history_matches = list(latest.values())

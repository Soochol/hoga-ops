from __future__ import annotations

import asyncio
import datetime as dt
import time
from pathlib import Path

from hoga.api import (
    screener_bar_volume,
    screener_depth,
    screener_exclusions,
    screener_history_coverage,
    screener_intraday,
    screener_scan,
    screener_universe,
    symbols,
)
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.api.screener_expression import active_conditions
from hoga.collector.orchestrator import now_kst
from hoga.util.timeenc import KST


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
    now_value = now_value.astimezone(KST) if now_value.tzinfo else now_value.replace(tzinfo=KST)

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

    conditions = active_conditions(req.conditions, req.expression)
    history = screener_history_coverage.history_leaves(conditions)
    needs_overlay = req.basis == "intraday" and (not conditions or any(
        screener_bar_volume.needs_daily_overlay(leaf, now_value.date().isoformat()) for leaf in conditions))
    if needs_overlay:
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
                now_ms=int(now_value.timestamp() * 1000),
            )
            intraday_rows = overlay.rows
            warnings.extend(overlay.warnings)
            # 사유는 상태 태그와 갈라 실어 보낸다(ADR-0143) — 접두 없이, kind 동반.
            intraday_failure = overlay.failure
            if overlay.rows.height == 0:
                warnings.append("intraday_fallback_eod")

    depth_eval = None
    if screener_depth.has_depth_conditions(conditions):
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
            conditions=conditions,
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
            screener_history_coverage.evaluate, data_dir, conditions, codes)
    bar_eval = None
    if screener_bar_volume.leaves(conditions):
        codes = await asyncio.to_thread(
            screener_universe.codes_for_universe, sdir / "stocks.parquet", req.universe,
            scope=scope, etf_codes=etf_codes)
        live_codes = set(intraday_rows["code"].to_list()) if intraday_rows is not None else set()
        bar_eval = await screener_bar_volume.evaluate(
            data_dir=data_dir, conditions=conditions, codes=codes, basis=req.basis,
            now=now_value, overlay=intraday_rows,
            daily_fallback_codes=set(codes) - live_codes if needs_overlay else None)
        if bar_eval.coverage.incomplete:
            warnings.append("bar_volume_partial")
    excluded = screener_exclusions.exclusion_keys(
        await asyncio.to_thread(screener_exclusions.load_exclusions, data_dir))
    occurrence_dates = _occurrence_dates(depth_eval, history_eval)
    rows = await asyncio.to_thread(
        screener_scan.run_scan,
        sdir / "daily_adjusted.parquet",
        sdir / "stocks.parquet",
        conditions=req.conditions,
        expression=req.expression,
        universe=req.universe,
        limit=req.limit + 1,
        intraday_rows=intraday_rows,
        depth_pass=depth_pass,
        scope_codes=scope,
        etf_codes=etf_codes,
        history_pass=history_eval.passing if history_eval else None,
        bar_events=bar_eval.events if bar_eval else None,
        occurrence_dates=occurrence_dates, excluded=excluded,
    )
    if history_eval:
        _attach_history(rows, history_eval)
    return ScreenerResponse(
        history_coverage=history_eval.coverage if history_eval else None,
        bar_coverage=bar_eval.coverage if bar_eval else None,
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

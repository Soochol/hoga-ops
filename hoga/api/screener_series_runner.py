"""Pinned v2 scans. Prices, quantities and amounts have independent evidence."""

from __future__ import annotations

import asyncio
import datetime as dt
import time
from pathlib import Path

import polars as pl

from hoga.api import (
    screener_bar_volume,
    screener_basis,
    screener_depth,
    screener_exclusions,
    screener_intraday,
    screener_series_eval as evaluation,
    screener_series_store as store,
    screener_series_values as values,
    screener_universe,
)
from hoga.api.models import (
    BarVolumeCoverage,
    BarVolumeCoverageItem,
    ScanRequest,
    ScreenerCalculation,
    ScreenerOccurrence,
    ScreenerResponse,
    ScreenerRow,
)
from hoga.api.screener_calendar import EOD_CUTOFF_HOUR
from hoga.api.screener_expression import active_conditions, parse_expression
from hoga.util.timeenc import KST


def _matches(tokens, passing: set[str], conditions) -> bool:
    stack = []
    for token in tokens:
        if isinstance(token, int):
            stack.append(conditions[token].id in passing)
        else:
            right, left = stack.pop(), stack.pop()
            stack.append(left and right if token == "AND" else left or right)
    return stack[0] if stack else True


def calendar_evaluate(data_dir, req, pinned, codes, clock, overlay=None, fallback_clock=None):
    _, manifest = pinned
    days = [dt.datetime.strptime(day, "%Y%m%d").date() for day in store.snapshot_calendar(data_dir, manifest)]
    selected = [
        leaf
        for leaf in active_conditions(req.conditions, req.expression)
        if not getattr(leaf.params, "timeframe", "D").endswith("m") and leaf.type not in screener_depth.DEPTH_TYPES
    ]
    plans = {leaf.id: evaluation._windows(leaf, days, clock) for leaf in selected}
    fallback_plans = (
        {leaf.id: evaluation._windows(leaf, days, fallback_clock) for leaf in selected}
        if fallback_clock is not None
        else plans
    )
    required = [
        day
        for windows in [*plans.values(), *fallback_plans.values()]
        for window, _ in windows
        for bucket, _, _ in window
        for day in bucket
    ]
    first = min(required, default=clock.date())
    prior = [day for day in days if day < first]
    series = values.load_series(data_dir, manifest, codes, first=prior[-1] if prior else first, last=clock.date())
    events, failures = {leaf.id: [] for leaf in selected}, []
    if overlay is not None:
        for row in overlay.iter_rows(named=True):
            day, code = row["date"], row["code"]
            candidate = {**row, "date": day.isoformat()}
            if code in series and day <= clock.date() and values.valid_row(candidate):
                series[code].original[day] = candidate
                if manifest["adjusted_as_of"] == clock.date().isoformat():
                    series[code].prices[day] = candidate
    live_codes = set(overlay["code"].to_list()) if overlay is not None else set()
    for code in codes:
        chosen_clock = fallback_clock if fallback_clock is not None and code not in live_codes else clock
        chosen_plans = fallback_plans if chosen_clock != clock else plans
        for leaf in selected:
            found, absent = evaluation.evaluate_leaf(
                leaf, code, series[code], days, chosen_clock, windows=chosen_plans[leaf.id]
            )
            events[leaf.id].extend((code, event) for event in found)
            failures.extend(absent)
    return series, events, failures


def _confirmed_at(data_dir, manifest, codes, cutoff):
    days = []
    for code in codes:
        identity = manifest["observations"].get(code)
        if identity:
            observation = store.read_object(data_dir, identity)
            if observation["adjusted_as_of"] != manifest["adjusted_as_of"]:
                continue
            days.extend(
                row["date"]
                for row in observation["adjusted"]
                if row["date"] <= cutoff.isoformat() and row.get("complete", True) and values.valid_price(row)
            )
    return (
        int(dt.datetime.combine(dt.date.fromisoformat(max(days)), dt.time(15, 30), KST).timestamp() * 1000)
        if days
        else None
    )


def _eod_clock(now, confirmed):
    cutoff = now.date() - dt.timedelta(days=now.hour < EOD_CUTOFF_HOUR)
    if confirmed is not None:
        cutoff = min(cutoff, dt.datetime.fromtimestamp(confirmed / 1000, KST).date())
    return dt.datetime.combine(cutoff, dt.time(15, 30), KST)


async def _inputs(data_dir, req, manifest, now, replay):
    if replay is not None:
        return replay
    roster = pl.DataFrame(await asyncio.to_thread(store.read_object, data_dir, manifest["roster"]))
    scope = await asyncio.to_thread(screener_universe.scope_codes, data_dir, req.universe.scopes)
    roster = screener_universe.filter_stocks_df(roster, req.universe, scope=scope)
    codes = roster["code"].to_list()
    confirmed = await asyncio.to_thread(_confirmed_at, data_dir, manifest, codes, now.date())
    basis = screener_basis.choose_basis(req.basis, now, confirmed, data_dir)
    clock = now if basis == "intraday" else _eod_clock(now, confirmed)
    excluded = screener_exclusions.exclusion_keys(
        await asyncio.to_thread(
            screener_exclusions.load_exclusions, data_dir, calculation_policy=req.calculation_policy
        )
    )
    warnings = ["scope_universe_empty"] if scope is not None and not scope else []
    if req.universe.exclude_etf and manifest.get("etf_classification") != "master":
        warnings.append("etf_filter_stale_master_unavailable")
    return {
        "codes": codes,
        "labels": roster.to_dicts(),
        "clock": clock.isoformat(),
        "basis": basis,
        "confirmed_at": confirmed,
        "excluded": [list(key) for key in sorted(excluded, key=str)],
        "warnings": warnings,
    }


async def _overlay(data_dir, req, inputs, now):
    warnings = list(inputs["warnings"])
    if inputs["basis"] != "intraday" or req.snapshot_id is not None:
        return None, warnings, None, None
    if screener_intraday.intraday_overlay_bypassed(data_dir):
        return None, [*warnings, "rest_bypassed_intraday_overlay_skipped", "intraday_fallback_eod"], None, None
    observed = await screener_intraday.build_intraday_overlay(
        data_dir=data_dir, codes=inputs["codes"], now_ms=int(now.timestamp() * 1000)
    )
    warnings.extend(observed.warnings)
    if observed.rows.is_empty():
        warnings.append("intraday_fallback_eod")
        return None, warnings, None, observed.failure
    return observed.rows, warnings, observed.fetched_at_ms, observed.failure


async def _auxiliary(data_dir, req, inputs, now, volume_runtime, events, failures):
    selected = active_conditions(req.conditions, req.expression)
    minutes = [leaf for leaf in selected if getattr(leaf.params, "timeframe", "D").endswith("m")]
    if minutes:
        result = await screener_bar_volume.evaluate(
            data_dir=data_dir,
            conditions=minutes,
            codes=inputs["codes"],
            basis=inputs["basis"],
            now=now,
            volume_runtime=volume_runtime,
        )
        events.update(result.events)
        failures.extend(result.coverage.incomplete)
    if not screener_depth.has_depth_conditions(selected):
        return None
    depth = await asyncio.to_thread(
        screener_depth.evaluate,
        data_dir=data_dir,
        sdir=data_dir / "screener",
        conditions=selected,
        universe_codes=set(inputs["codes"]),
        basis=inputs["basis"],
        today=now.strftime("%Y%m%d"),
    )
    for leaf in selected:
        if leaf.type in screener_depth.DEPTH_TYPES:
            events[leaf.id] = [
                (code, ScreenerOccurrence(condition_id=leaf.id, condition_key="", date=day))
                for code in depth.passing.get(leaf.id, [])
                for day in depth.occurrence_dates.get(leaf.id, {}).get(code, [now.date().isoformat()])
            ]
    return depth


def _occurrences(req, inputs, events):
    excluded = {tuple(key) for key in inputs["excluded"]}
    by_code = {code: [] for code in inputs["codes"]}
    for leaf in active_conditions(req.conditions, req.expression):
        key = screener_exclusions.condition_key(leaf, calculation_policy=req.calculation_policy)
        for code, event in events.get(leaf.id, []):
            event.condition_key = key
            if (key, code, event.date) not in excluded and (key, code, event.date, event.bar_start_ms) not in excluded:
                by_code[code].append(event)
    return by_code


def _rows(req, inputs, series, events, failures, days, clock):
    by_code = _occurrences(req, inputs, events)
    tokens = parse_expression(req.expression, len(req.conditions))
    labels = {row["code"]: row for row in inputs["labels"]}
    rows = []
    for code, occurrences in by_code.items():
        if not _matches(tokens, {event.condition_id for event in occurrences}, req.conditions):
            continue
        item = series[code]
        available = sorted(day for day in item.prices if day <= clock.date())
        if not available:
            failures.append(
                BarVolumeCoverageItem(code=code, condition_id="display_price", reason="vendor_price_unavailable")
            )
            continue
        day = available[-1]
        amount = item.amount(day)
        if amount is None:
            failures.append(
                BarVolumeCoverageItem(code=code, condition_id="display_amount", reason="invalid_daily_rows")
            )
            continue
        prior = days[days.index(day) - 1] if day in days and days.index(day) > 0 else None
        previous = item.prices.get(prior, {}).get("close")
        price = item.prices[day]["close"]
        rows.append(
            ScreenerRow(
                code=code,
                name=labels[code]["name"],
                market=labels[code]["market"],
                price=int(price),
                price_date=day.isoformat(),
                trade_value_won=int(amount),
                trade_value_method="provider_actual"
                if item.original[day].get("trade_value_won") is not None
                else "ohlcv_estimate",
                change_pct=round((price / previous - 1) * 100, 2) if previous else None,
                occurrences=occurrences,
            )
        )
    return sorted(rows, key=lambda row: (-row.trade_value_won, row.code))


async def run_scan(
    *, data_dir: Path, req: ScanRequest, now: dt.datetime, volume_runtime=None, record=False, replay=None
) -> ScreenerResponse:
    now = now.astimezone(KST) if now.tzinfo else now.replace(tzinfo=KST)
    pinned = await asyncio.to_thread(store.load_snapshot, data_dir, req.snapshot_id)
    if pinned is None:
        return ScreenerResponse(
            status="ok",
            rows=[],
            warnings=["separate_bases_not_prepared"],
            calculation=ScreenerCalculation(policy=req.calculation_policy, price_basis="vendor_adjusted"),
        )
    identity, manifest = pinned
    inputs = await _inputs(data_dir, req, manifest, now, replay)
    clock = dt.datetime.fromisoformat(inputs["clock"])
    overlay, warnings, overlay_at, intraday_failure = await _overlay(data_dir, req, inputs, now)
    fallback_clock = _eod_clock(now, inputs["confirmed_at"]) if inputs["basis"] == "intraday" else None
    series, events, failures = await asyncio.to_thread(
        calendar_evaluate, data_dir, req, pinned, inputs["codes"], clock, overlay, fallback_clock
    )
    depth = await _auxiliary(data_dir, req, inputs, now, volume_runtime, events, failures)
    days = [dt.datetime.strptime(day, "%Y%m%d").date() for day in store.snapshot_calendar(data_dir, manifest)]
    rows = await asyncio.to_thread(_rows, req, inputs, series, events, failures, days, clock)
    if failures:
        warnings.append("separate_bases_partial")
    response = ScreenerResponse(
        status="ok",
        rows=rows[: req.limit],
        has_more=len(rows) > req.limit,
        warnings=warnings + (depth.warnings if depth else []),
        scanned_at_ms=int(time.time() * 1000),
        **screener_basis.evaluation_times(
            inputs["confirmed_at"],
            now,
            live_conditions=inputs["basis"] == "intraday"
            and any(
                leaf.type in screener_depth.DEPTH_TYPES or getattr(leaf.params, "timeframe", "D").endswith("m")
                for leaf in active_conditions(req.conditions, req.expression)
            ),
            overlay_at=overlay_at,
            partial=overlay is not None and overlay.height < len(inputs["codes"]),
        ),
        intraday_failure=intraday_failure,
        calculation=ScreenerCalculation(
            policy=req.calculation_policy,
            snapshot_id=identity,
            adjusted_as_of=manifest["adjusted_as_of"],
            price_basis="vendor_adjusted",
            event_revision=store.digest(manifest["quantity"]),
        ),
        bar_coverage=BarVolumeCoverage(
            total=len(inputs["codes"]),
            complete=len(inputs["codes"]) - len({failure.code for failure in failures}),
            incomplete=failures,
        ),
        depth_coverage=depth.coverage if depth else None,
        depth_values=depth.values if depth else None,
    )
    if record:
        from hoga.api.screener_series_execution import archive  # noqa: PLC0415 — optional explicit archive

        await asyncio.to_thread(archive, data_dir, req, inputs, response)
    return response

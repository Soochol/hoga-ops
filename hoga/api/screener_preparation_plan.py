"""Compute daily input requirements independently of quantity-evidence availability."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from hoga.api import (
    screener_series_eval as evaluation,
    screener_series_store as store,
    screener_series_values as values,
)
from hoga.api.models import BarVolumeCoverageItem, ScanRequest
from hoga.api.screener_bar_policy import RANK_TYPES, TRADE_VALUE_TYPES, VOLUME_TYPES
from hoga.api.screener_depth import DEPTH_TYPES
from hoga.api.screener_expression import active_conditions


def daily_leaves(req: ScanRequest):
    return [leaf for leaf in active_conditions(req.conditions, req.expression)
            if leaf.type not in RANK_TYPES and leaf.type not in DEPTH_TYPES
            and not getattr(leaf.params, "timeframe", "D").endswith("m")]


@dataclass
class DailyPlan:
    targets: dict[str, tuple[dt.date, dt.date]]
    blocked: list[BarVolumeCoverageItem]


def _requirements(req, days, clock):
    return [(leaf, {day for window, valid in evaluation._windows(leaf, days, clock) if valid
                    for bucket, _, _ in window for day in bucket}) for leaf in daily_leaves(req)]


def _code_requirements(code, item, requirements, latest, clock):
    prices, original, blocked = set(), set(), []
    for leaf, dates in requirements:
        if not dates:
            continue
        if leaf.type in VOLUME_TYPES and getattr(leaf.params, "volume_basis", None) != "raw":
            evidence = item.evidence
            if (evidence is None or evidence.verified_from > min(dates) or evidence.verified_to < max(dates)
                    or any(event.kind == "unsupported" and min(dates) < event.effective_date <= max(dates)
                           for event in evidence.events)):
                blocked.append(BarVolumeCoverageItem(code=code, condition_id=leaf.id,
                                                     reason="share_evidence_unavailable"))
                continue
        needed = original if leaf.type in VOLUME_TYPES | TRADE_VALUE_TYPES else prices
        needed.update(day for day in dates if day < clock.date())
        prices.add(latest)  # display price is needed only for an evaluable leaf
    return prices, original, blocked


def _extend_confirmed_spans(data_dir, manifest, gaps, clock):
    # Confirmation describes the entire candidate. Extending a same-basis chunk
    # must retain its earlier proof instead of making earlier rows unconfirmed.
    for code, (first, last) in list(gaps.items()):
        identity = manifest["observations"].get(code)
        if identity:
            observation = store.read_object(data_dir, identity)
            if observation["adjusted_as_of"] == clock.date().isoformat():
                dates = [dt.date.fromisoformat(row["date"]) for row in observation["adjusted"]]
                if dates:
                    gaps[code] = min(first, *dates), max(last, *dates)


def plan(data_dir, req, codes, clock, evaluation_clock=None):
    """Only fetch gaps that observations can resolve, not missing quantity proof."""
    pinned = store.load_snapshot(data_dir)
    if not pinned or not codes:
        return DailyPlan({}, [])
    _, manifest = pinned
    days = [dt.datetime.strptime(day, "%Y%m%d").date() for day in store.snapshot_calendar(data_dir, manifest)]
    evaluation_clock = evaluation_clock or clock
    completed = [day for day in days if day < clock.date() and day <= evaluation_clock.date()]
    if not completed:
        return DailyPlan({}, [])
    requirements = _requirements(req, days, evaluation_clock)
    all_days = {day for _, dates in requirements for day in dates if day < clock.date()} | {completed[-1]}
    series = values.load_series(data_dir, manifest, codes, first=min(all_days), last=max(all_days))
    gaps, bounds, blocked = {}, {}, []
    for code in codes:
        item = series[code]
        prices, original, unknown = _code_requirements(code, item, requirements, completed[-1], clock)
        blocked.extend(unknown)
        needed = prices | original
        if needed:
            bounds[code] = min(needed), max(needed)
            if not prices <= item.prices.keys() or not original <= item.original.keys():
                gaps[code] = bounds[code]
    # A new basis/confirmation contract invalidates older price objects. Rebase
    # every evaluable requested code, while leaving blocked-only codes unfetched.
    if (manifest["adjusted_as_of"] != clock.date().isoformat()
            or not manifest.get("daily_contract_required")):
        gaps.update(bounds)
    _extend_confirmed_spans(data_dir, manifest, gaps, clock)
    return DailyPlan(gaps, blocked)

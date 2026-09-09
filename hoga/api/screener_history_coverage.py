"""Historical condition evaluation and collection planning over the same disk snapshot."""
from __future__ import annotations

import bisect
import copy
import datetime as dt
import json
from collections import deque
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import polars as pl

from hoga.api import trading_days
from hoga.api.models import (
    HistoryCoverage,
    HistoryCoverageItem,
    HistoryDateRangeParams,
    HistoryMatch,
    HistoryTradeValueMatch,
    HistoryTradeValueParams,
    HistoryVolumeParams,
    ScanRequest,
)
from hoga.api.screener_trade_value import TRADE_VALUE_SQL, WON_PER_EOK


def history_leaves(conditions):
    return [leaf for leaf in conditions if isinstance(leaf.params, HistoryDateRangeParams)]


def subtract_years(day: dt.date, years: int) -> dt.date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:
        return day.replace(year=day.year - years, day=28)


@dataclass
class HistoryEvaluation:
    coverage: HistoryCoverage
    passing: dict[str, list[str]] = field(default_factory=dict)
    matches: dict[str, list[HistoryMatch | HistoryTradeValueMatch]] = field(default_factory=dict)
    all_matches: dict[str, list[HistoryMatch | HistoryTradeValueMatch]] = field(default_factory=dict)
    collection_starts: dict[str, dt.date] = field(default_factory=dict)


@dataclass(frozen=True)
class WindowPlan:
    condition_id: str
    lower: dt.date
    end: dt.date
    dates: tuple[dt.date, ...]
    left_indices: tuple[int, ...]
    eligible: tuple[bool, ...]
    calendar_complete: bool
    collection_days: tuple[dt.date, ...]


def plan_windows(leaf, calendar: list[dt.date]) -> WindowPlan:
    """Date-only work is shared by every code evaluated for this condition."""
    p = leaf.params
    start, end = dt.date.fromisoformat(p.start_date), dt.date.fromisoformat(p.end_date)
    volume_condition = isinstance(p, HistoryVolumeParams)
    n = p.record_period.value if volume_condition else 1
    years = volume_condition and p.record_period.unit == "years"
    lower = required_start(p, calendar)
    dates = tuple(d for d in calendar if d <= end and
                  (d > lower if years else d >= lower))
    calendar_complete = bool(calendar) and lower >= calendar[0] and end <= calendar[-1]
    if not years and bisect.bisect_left(calendar, start) < n - 1:
        calendar_complete = False
    known_lower = max(lower, calendar[0]) if calendar else lower
    left, lefts, eligible = 0, [], []
    for right, day in enumerate(dates):
        if years:
            boundary = subtract_years(day, n)
            while left <= right and dates[left] <= boundary:
                left += 1
            full = boundary >= known_lower
        else:
            left = max(0, right - n + 1)
            full = right - left + 1 == n
        lefts.append(left)
        eligible.append(day >= start and full)
    candidates = [i for i, valid in enumerate(eligible) if valid]
    collection_days = dates[lefts[candidates[0]]:candidates[-1] + 1] if candidates else ()
    return WindowPlan(leaf.id, lower, end, dates, tuple(lefts), tuple(eligible),
                      calendar_complete, collection_days)


def all_volume_matches(plan: WindowPlan, values: dict[dt.date, int]) -> list[HistoryMatch]:
    peak: deque[int] = deque()
    left, absent = 0, 0
    matches = []
    for right, day in enumerate(plan.dates):
        volume = values.get(day)
        absent += volume is None
        while left < plan.left_indices[right]:
            absent -= plan.dates[left] not in values
            left += 1
        while peak and peak[0] < left:
            peak.popleft()
        if volume is not None:
            while peak and values[plan.dates[peak[-1]]] <= volume:
                peak.pop()
            peak.append(right)
        if not plan.eligible[right] or absent or volume is None or volume <= 0:
            continue
        maximum = values[plan.dates[peak[0]]]
        if volume == maximum:
            matches.append(HistoryMatch(condition_id=plan.condition_id, date=day.isoformat(),
                  volume=volume, maximum=maximum,
                  window_start=plan.dates[left].isoformat(), window_end=day.isoformat()))
    return matches


def latest_match(plan: WindowPlan, values: dict[dt.date, int]) -> HistoryMatch | None:
    matches = all_volume_matches(plan, values)
    return matches[-1] if matches else None


def all_trade_value_matches(plan: WindowPlan, values: dict[dt.date, float], min_eok: float):
    threshold = int(min_eok * WON_PER_EOK)
    return [HistoryTradeValueMatch(condition_id=plan.condition_id, date=day.isoformat(),
                                   trade_value_won=values[day])
            for day, eligible in zip(plan.dates, plan.eligible, strict=True)
            if eligible and values.get(day, -1) >= threshold]


def latest_trade_value_match(plan: WindowPlan, values: dict[dt.date, float], min_eok: float):
    matches = all_trade_value_matches(plan, values, min_eok)
    return matches[-1] if matches else None


def evaluate(data_dir: Path, conditions, codes: list[str]) -> HistoryEvaluation:
    versions = []
    for name in ("daily_adjusted.parquet", "factors.parquet"):
        path = data_dir / "screener" / name
        stat = path.stat() if path.exists() else None
        versions.append((stat.st_ino, stat.st_mtime_ns, stat.st_size) if stat else None)
    calendar = tuple(sorted(trading_days.trading_days(data_dir)))
    encoded = json.dumps([leaf.model_dump(mode="json") for leaf in history_leaves(conditions)], sort_keys=True)
    return copy.deepcopy(_cached_evaluate(str(data_dir), encoded, tuple(codes), tuple(versions), calendar))


@lru_cache(maxsize=4)
def _cached_evaluate(directory, encoded, codes, version, calendar_days):
    data_dir = Path(directory)
    conditions = ScanRequest.model_validate({"conditions": json.loads(encoded)}).conditions
    return _evaluate(data_dir, conditions, codes, calendar_days)


def required_start(params, calendar):
    start = dt.date.fromisoformat(params.start_date)
    if isinstance(params, HistoryTradeValueParams):
        return start
    if params.record_period.unit == "years":
        return subtract_years(start, params.record_period.value)
    first = bisect.bisect_left(calendar, start)
    index = max(0, first - params.record_period.value + 1)
    return calendar[index] if index < len(calendar) else start


def _factor_codes(path: Path) -> set[str]:
    """Read coverage without the writer-side quarantine behavior of read_factors."""
    if not path.exists():
        return set()
    try:
        if not {"code", "seg_start", "factor"} <= set(pl.read_parquet_schema(path)):
            return set()
        return set(pl.scan_parquet(path)
                   .filter(pl.col("factor").is_finite(), pl.col("factor") > 0)
                   .select("code").unique().collect()["code"])
    except (OSError, pl.exceptions.PolarsError):
        return set()


def _evaluate(data_dir, conditions, codes, calendar_days) -> HistoryEvaluation:
    leaves = history_leaves(conditions)
    calendar = sorted(dt.datetime.strptime(d, "%Y%m%d").date()
                      for d in calendar_days)
    plans = [plan_windows(leaf, calendar) for leaf in leaves]
    path = data_dir / "screener" / "daily_adjusted.parquet"
    factors_path = data_dir / "screener" / "factors.parquet"
    # The adjusted store can also contain heuristic split corrections. Historical
    # evidence requires a code covered by the authoritative factor store.
    factor_codes = _factor_codes(factors_path)
    records: dict[str, dict[dt.date, int]] = {}
    trade_values: dict[str, dict[dt.date, float]] = {}
    need_trade_values = any(isinstance(leaf.params, HistoryTradeValueParams) for leaf in leaves)
    columns: list[str | pl.Expr] = ["code", "date", "volume"]
    if need_trade_values:
        columns.append(pl.sql_expr(TRADE_VALUE_SQL).alias("trade_value_won"))
    if path.exists() and codes and plans:
        frame = (pl.scan_parquet(path).filter(pl.col("code").is_in(codes),
                           pl.col("date") <= max(plan.end for plan in plans),
                           pl.col("date") >= min(plan.lower for plan in plans))
                 .select(columns).collect())
        for row in frame.iter_rows():
            code, day, volume = row[:3]
            records.setdefault(code, {})[day] = int(volume)
            if need_trade_values:
                trade_values.setdefault(code, {})[day] = float(row[3])
    result = HistoryEvaluation(HistoryCoverage(total=len(codes), complete=0))
    incomplete_codes = set()
    for leaf, plan in zip(leaves, plans, strict=True):
        result.passing[plan.condition_id] = []
        for code in codes:
            values = records.get(code, {})
            missing = sum(d not in values for d in plan.dates)
            factor_ok = code in factor_codes
            if missing or not plan.calendar_complete or not factor_ok:
                incomplete_codes.add(code)
                result.coverage.incomplete.append(HistoryCoverageItem(
                    code=code, condition_id=plan.condition_id, required_from=plan.lower.isoformat(),
                    required_to=plan.end.isoformat(), missing_days=missing,
                    reason=("calendar_unavailable" if not plan.calendar_complete else
                            "factor_unavailable" if not factor_ok else "missing_history")))
            if plan.collection_days and (not factor_ok or any(d not in values for d in plan.collection_days)):
                needed = plan.collection_days[0]
                result.collection_starts[code] = min(needed, result.collection_starts.get(code, needed))
            if not factor_ok:
                continue
            matches = (all_trade_value_matches(plan, trade_values.get(code, {}), leaf.params.min_eok)
                       if isinstance(leaf.params, HistoryTradeValueParams) else all_volume_matches(plan, values))
            if matches:
                result.passing[plan.condition_id].append(code)
                result.matches.setdefault(code, []).append(matches[-1])
                result.all_matches.setdefault(code, []).extend(matches)
    result.coverage.complete = len(codes) - len(incomplete_codes)
    return result

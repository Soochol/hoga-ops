"""Historical volume evaluation and collection planning over the same disk snapshot."""
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
    HistoryMatch,
    HistoryVolumeParams,
    ScanRequest,
)


def history_leaves(conditions):
    return [leaf for leaf in conditions if isinstance(leaf.params, HistoryVolumeParams)]


def subtract_years(day: dt.date, years: int) -> dt.date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:
        return day.replace(year=day.year - years, day=28)


@dataclass
class HistoryEvaluation:
    coverage: HistoryCoverage
    passing: dict[str, list[str]] = field(default_factory=dict)
    matches: dict[str, list[HistoryMatch]] = field(default_factory=dict)


def latest_match(leaf, values, required, lower, start):
    p = leaf.params
    n = p.record_period.value
    # Calendar-indexed windows prevent missing rows from silently shortening history.
    peak: deque[int] = deque()
    left, absent = 0, 0
    latest = None
    for right, day in enumerate(required):
        volume = values.get(day)
        absent += volume is None
        if p.record_period.unit == "years":
            boundary = subtract_years(day, n)
            while left <= right and required[left] <= boundary:
                absent -= required[left] not in values
                left += 1
            full = boundary >= lower
        else:
            while right - left + 1 > n:
                absent -= required[left] not in values
                left += 1
            full = right - left + 1 == n
        while peak and peak[0] < left:
            peak.popleft()
        if volume is not None:
            while peak and values[required[peak[-1]]] <= volume:
                peak.pop()
            peak.append(right)
        if day < start or not full or absent or volume is None or volume <= 0:
            continue
        maximum = values[required[peak[0]]]
        if volume == maximum:
            latest = HistoryMatch(condition_id=leaf.id, date=day.isoformat(),
                  volume=volume, maximum=maximum,
                  window_start=required[left].isoformat(), window_end=day.isoformat())
    return latest


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
    path = data_dir / "screener" / "daily_adjusted.parquet"
    factors_path = data_dir / "screener" / "factors.parquet"
    # The adjusted store can also contain heuristic split corrections. Historical
    # evidence requires a code covered by the authoritative factor store.
    factor_codes = _factor_codes(factors_path)
    records: dict[str, dict[dt.date, int]] = {}
    if path.exists() and codes:
        frame = (pl.scan_parquet(path).filter(pl.col("code").is_in(codes),
                           pl.col("date") <= max(dt.date.fromisoformat(leaf.params.end_date) for leaf in leaves),
                           pl.col("date") >= min(required_start(leaf.params, calendar) for leaf in leaves))
                 .select("code", "date", "volume").collect())
        for code, day, volume in frame.iter_rows():
            records.setdefault(code, {})[day] = int(volume)
    result = HistoryEvaluation(HistoryCoverage(total=len(codes), complete=0))
    incomplete_codes = set()
    for leaf in leaves:
        p = leaf.params
        start, end = dt.date.fromisoformat(p.start_date), dt.date.fromisoformat(p.end_date)
        n = p.record_period.value
        first = bisect.bisect_left(calendar, start)
        lower = required_start(p, calendar)
        required = [d for d in calendar if d <= end and
                    (d > lower if p.record_period.unit == "years" else d >= lower)]
        calendar_ok = bool(calendar) and lower >= calendar[0] and end <= calendar[-1]
        if p.record_period.unit == "trading_days" and first < n - 1:
            calendar_ok = False
        result.passing[leaf.id] = []
        for code in codes:
            values = records.get(code, {})
            missing = sum(d not in values for d in required)
            factor_ok = code in factor_codes
            if missing or not calendar_ok or not factor_ok:
                incomplete_codes.add(code)
                result.coverage.incomplete.append(HistoryCoverageItem(
                    code=code, condition_id=leaf.id, required_from=lower.isoformat(),
                    required_to=end.isoformat(), missing_days=missing,
                    reason=("calendar_unavailable" if not calendar_ok else
                            "factor_unavailable" if not factor_ok else "missing_history")))
            if not factor_ok:
                continue
            # Missing calendar coverage makes the whole range incomplete, but
            # later candidate windows can still be fully observed. For calendar
            # years, never let a window extend before the known calendar; the
            # trading-day path independently requires all N calendar entries.
            known_lower = max(lower, calendar[0]) if calendar else lower
            latest = latest_match(leaf, values, required, known_lower, start)
            if latest:
                result.passing[leaf.id].append(code)
                result.matches.setdefault(code, []).append(latest)
    result.coverage.complete = len(codes) - len(incomplete_codes)
    return result

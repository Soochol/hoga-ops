"""Date-scoped availability over the raw ingest ledger; v2 uses its pinned guard object."""

from __future__ import annotations

import datetime as dt
from functools import lru_cache
from pathlib import Path

from hoga.api import screener_daily_ingest as ingest
from hoga.api.models import BarVolumeCoverage, BarVolumeCoverageItem


@lru_cache(maxsize=8)
def _cached(path, stamp):
    return ingest.guard_payload(ingest.load(Path(path)))


def current_guard(data_dir):
    path = ingest.root(data_dir) / "current.json"
    if not path.exists():
        return None
    stat = path.stat()
    return _cached(str(data_dir), (stat.st_ino, stat.st_mtime_ns, stat.st_size))


def reason(guard, code, day):
    if not guard:
        return None
    key = f"{code}:{day}"
    entry = guard["blocked"].get(key)
    if entry:
        return "daily_observation_conflict" if entry["status"] == "quarantined" else "daily_observation_unconfirmed"
    start = guard.get("enabled_from")
    if start and str(day) >= start and str(day) > guard.get("confirmed_through", {}).get(code, ""):
        return "daily_observation_unconfirmed"
    return None


def legacy_coverage(data_dir, conditions, codes, clock, intraday=False):
    from hoga.api import screener_depth, screener_series_eval as evaluation, trading_days  # noqa: PLC0415

    guard = current_guard(data_dir)
    if guard is None:
        return None, set()
    calendar = [dt.datetime.strptime(d, "%Y%m%d").date() for d in sorted(trading_days.trading_days(data_dir))]
    previous = dict(zip(calendar[1:], calendar[:-1], strict=True))
    required = {}
    for leaf in conditions:
        if leaf.type in screener_depth.DEPTH_TYPES or getattr(leaf.params, "timeframe", "D").endswith("m"):
            continue
        windows = evaluation._windows(leaf, calendar, clock)
        dates = {day for window, _ in windows for bucket, _, _ in window for day in bucket}
        if leaf.type == "change_pct" and getattr(leaf.params, "change_reference", None) == "previous_day":
            anchors = {window[-1][0][-1] for window, _ in windows if window and window[-1][0]}
            dates |= {previous[day] for day in anchors if day in previous}
        required[leaf.id] = dates
    if not conditions:
        required["daily"] = {max((d for d in calendar if d <= clock.date()), default=clock.date())}
    price_only = {
        leaf.id for leaf in conditions if leaf.type not in evaluation.VOLUME_TYPES | evaluation.TRADE_VALUE_TYPES
    }
    failures = _failures(guard, required, codes, clock.date() if intraday else None, price_only)
    excluded = {item.code for item in failures}
    return BarVolumeCoverage(total=len(codes), complete=len(codes) - len(excluded), incomplete=failures), excluded


def _failures(guard, required, codes, live_day, price_only):
    by_code = {}
    for entry in guard["blocked"].values():
        by_code.setdefault(entry["code"], {})[entry["date"]] = entry
    start = guard.get("enabled_from")
    plans = {
        identity: (
            {str(day) for day in dates if day != live_day},
            {str(day) for day in dates if day != live_day and start and str(day) >= start},
        )
        for identity, dates in required.items()
    }
    failures = []
    for code in codes:
        blocked = by_code.get(code, {})
        watermark = guard.get("confirmed_through", {}).get(code, "")
        for identity, (dates, implicit) in plans.items():
            reasons = {
                "daily_observation_conflict"
                if blocked[day]["status"] == "quarantined"
                else "daily_observation_unconfirmed"
                for day in dates.intersection(blocked)
                if identity not in price_only or blocked[day].get("changed_fields") != ["volume"]
            }
            if any(day > watermark and day not in blocked for day in implicit):
                reasons.add("daily_observation_unconfirmed")
            failures.extend(
                BarVolumeCoverageItem(code=code, condition_id=identity, reason=why) for why in sorted(reasons)
            )
    return failures

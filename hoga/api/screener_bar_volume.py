"""Candle-count price/volume predicates with bounded, memory-only minute history.

Calendar bars use the screener's adjusted daily corpus; minute bars retain the
vendor's original volume, as the chart does. Minute scope is KRX regular session.
No snapshot volume is added to an already cumulative candle.
"""
from __future__ import annotations

import asyncio
import bisect
import calendar
import datetime as dt
import logging
import time
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

import polars as pl

from hoga.api import (
    screener_bar_price,
    screener_bar_threshold,
    screener_bollinger,
    screener_exclusions,
    screener_history_evidence,
    trading_days,
)
from hoga.api.models import (
    BarRealtimeCoverage,
    BarVolumeCoverage,
    BarVolumeCoverageItem,
    BarVolumeMatch,
    BarVolumeRangeParams,
    HistoryDateRangeParams,
    ScreenerOccurrence,
)
from hoga.api.screener_bar_policy import (
    BOLLINGER_TYPES,
    CANDLE_TYPES,
    RANGE_PARAMS,
    RANK_TYPES,
    TRADE_VALUE_TYPES,
    VOLUME_TYPES,
    comparison_period,
    lookback,
    needs_bars,
)
from hoga.api.screener_calendar import EOD_CUTOFF_HOUR
from hoga.api.screener_write_lock import screener_read_lock
from hoga.live import kiwoom_access, kiwoom_minute_candles, kiwoom_rest_runtime, settings
from hoga.live.error_policy import classify_live_error
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
MINUTE_TTL_MS = 15_000
MAX_MINUTE_PAGES = 8
MAX_MINUTE_CODES_PER_SCAN = 64
MAX_CACHE_ENTRIES = 512
MAX_CURSOR_ENTRIES = 8
MAX_CACHE_BARS = 250_000
WEEKEND_START = 5


def leaves(conditions):
    return [leaf for leaf in conditions if needs_bars(leaf)]


def needs_daily_overlay(leaf, today: str) -> bool:
    if leaf.type in RANK_TYPES:
        return False
    if leaf.type in CANDLE_TYPES and getattr(leaf.params, "timeframe", "D").endswith("m"):
        return False
    if isinstance(leaf.params, HistoryDateRangeParams):
        return isinstance(leaf.params, RANGE_PARAMS) and leaf.params.end_date >= today
    return True


@dataclass(frozen=True)
class VolumeBar:
    start_ms: int
    volume: int
    is_open: bool = False
    valid: bool = True
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None
    trade_value_won: float | None = None
    previous_day_close: float | None = None
    previous_day_ms: int | None = None


@dataclass
class Evaluation:
    coverage: BarVolumeCoverage
    events: dict[str, list[tuple[str, ScreenerOccurrence]]] = field(default_factory=dict)


_SPECIAL_RECORDS = {
    **dict.fromkeys(BOLLINGER_TYPES, screener_bollinger.records),
    **dict.fromkeys(TRADE_VALUE_TYPES, screener_bar_threshold.turnover_records),
    "change_pct": screener_bar_threshold.change_records,
}


def records(leaf, bars: list[VolumeBar], *, fetched_at_ms: int):
    """Each event uses its own trailing window; later bars never alter history."""
    if handler := _SPECIAL_RECORDS.get(leaf.type):
        return handler(leaf, bars, fetched_at_ms=fetched_at_ms)
    if leaf.type not in VOLUME_TYPES:
        return screener_bar_price.records(leaf, bars, fetched_at_ms=fetched_at_ms)
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    period = p.record_period.value if isinstance(p, BarVolumeRangeParams) else p.period
    start = max(0, len(bars) - lookback(leaf)) if not isinstance(p, BarVolumeRangeParams) else 0
    peaks: deque[int] = deque()
    invalid: deque[int] = deque()
    events = []
    complete = bool(bars) and (isinstance(p, BarVolumeRangeParams) or len(bars) >= lookback(leaf) + p.period - 1)
    key = screener_exclusions.condition_key(leaf)
    for i, bar in enumerate(bars):
        left = i - period + 1
        while peaks and peaks[0] < left:
            peaks.popleft()
        while invalid and invalid[0] < left:
            invalid.popleft()
        while peaks and bars[peaks[-1]].volume <= bar.volume:
            peaks.pop()
        peaks.append(i)
        if not bar.valid:
            invalid.append(i)
        day = dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat()
        eligible = (p.start_date <= day <= p.end_date) if isinstance(p, BarVolumeRangeParams) else i >= start
        if not eligible:
            continue
        if left < 0 or invalid:
            complete = False
            continue
        maximum = bars[peaks[0]].volume
        if bar.volume > 0 and bar.volume >= maximum:
            events.append(ScreenerOccurrence(
                condition_id=leaf.id, condition_key=key, date=day,
                bar_start_ms=bar.start_ms,
                bar_match=BarVolumeMatch(timeframe=p.timeframe, volume=bar.volume,
                    maximum=maximum, window_start_ms=bars[left].start_ms,
                    is_open=bar.is_open, fetched_at_ms=fetched_at_ms)))
    # An empty historical interval is unknown, not a complete no-match.
    if isinstance(p, BarVolumeRangeParams) and not any(
        p.start_date <= dt.datetime.fromtimestamp(b.start_ms / 1000, KST).date().isoformat() <= p.end_date
        for b in bars
    ):
        complete = False
    return events, complete


def _bounds(day: dt.date, timeframe: str) -> tuple[dt.date, dt.date]:
    if timeframe == "W":
        first = day - dt.timedelta(days=day.weekday())
        return first, first + dt.timedelta(days=6)
    if timeframe == "M":
        return day.replace(day=1), day.replace(day=calendar.monthrange(day.year, day.month)[1])
    return day, day


def _stamp(day: dt.date, hour=9, minute=0) -> int:
    return int(dt.datetime.combine(day, dt.time(hour, minute), KST).timestamp() * 1000)


def calendar_bars(values: dict[dt.date, int | VolumeBar], days: list[dt.date], *, timeframe: str,
                  as_of: dt.datetime, windows=None) -> list[VolumeBar]:
    if not values:
        return []
    first_day = min(values)
    windows = windows if windows is not None else _calendar_windows(days, timeframe, as_of)
    out = []
    for expected, is_open, calendar_valid in windows:
        if expected[-1] < first_day:
            continue
        valid = calendar_valid and all(day in values for day in expected)
        volume = sum((values[day].volume if isinstance(values[day], VolumeBar) else values[day])
                     for day in expected if day in values)
        rows = [values[day] for day in expected if day in values]
        prices = {}
        if rows and all(isinstance(row, VolumeBar) and screener_bar_price.valid_prices(row) for row in rows):
            prices = dict(open=rows[0].open, high=max(row.high for row in rows),
                          low=min(row.low for row in rows), close=rows[-1].close)
        estimates = [screener_bar_threshold.estimate(row) if isinstance(row, VolumeBar) else None for row in rows]
        turnover = sum(estimates) if estimates and all(value is not None for value in estimates) else None
        previous = bisect.bisect_left(days, expected[-1]) - 1
        prior = values.get(days[previous]) if previous >= 0 else None
        reference = (dict(previous_day_close=prior.close, previous_day_ms=_stamp(days[previous]))
                     if isinstance(prior, VolumeBar) and prior.valid and screener_bar_price.valid_prices(prior) else {})
        out.append(VolumeBar(_stamp(expected[0]), volume, is_open, valid, **prices,
                             trade_value_won=turnover, **reference))
    return out


def _calendar_windows(days, timeframe, as_of):
    grouped = defaultdict(list)
    for day in days:
        grouped[_bounds(day, timeframe)].append(day)
    out = []
    for (first, last), full_days in sorted(grouped.items()):
        expected = [day for day in full_days if day <= as_of.date()]
        if not expected:
            continue
        # Calendar coverage may stop today. A future portion of this week/month
        # is still open; a known full period closes at its last actual trading day.
        after_known = days[-1] + dt.timedelta(days=1)
        remaining_weekdays = any((after_known + dt.timedelta(days=i)).weekday() < WEEKEND_START
                                 for i in range(max(0, (last - after_known).days + 1)))
        known_end = days[-1] >= last or last < as_of.date() or not remaining_weekdays
        close_day = full_days[-1]
        is_open = (not known_end and last >= as_of.date()) or as_of.timestamp() * 1000 < _stamp(close_day, 15, 30)
        known_through = min(last, as_of.date())
        calendar_valid = (days[0] <= first and (days[-1] >= known_through or all(
            (after_known + dt.timedelta(days=i)).weekday() >= WEEKEND_START
            for i in range(max(0, (known_through - after_known).days + 1)))))
        out.append((expected, is_open, calendar_valid))
    return out


def _required_windows(leaf, days, as_of):
    p = leaf.params
    cutoff = (min(as_of, dt.datetime.combine(dt.date.fromisoformat(p.end_date), dt.time(15, 30), KST))
              if isinstance(p, RANGE_PARAMS) else as_of)
    windows = _calendar_windows(days, p.timeframe, cutoff)
    if isinstance(p, RANGE_PARAMS):
        candidates = [i for i, (expected, _, _) in enumerate(windows)
                      if p.start_date <= expected[0].isoformat() <= p.end_date]
        return windows[max(0, candidates[0] - comparison_period(leaf) + 1):candidates[-1] + 1] if candidates else []
    needed = lookback(leaf) + comparison_period(leaf) - 1 + (not p.include_open_bar)
    return windows[-needed:]


def _daily_values(data_dir, codes, overlay, as_of, selected):
    days = sorted(dt.datetime.strptime(day, "%Y%m%d").date()
                  for day in trading_days.trading_days(data_dir))
    windows = [window for leaf in selected for window in _required_windows(leaf, days, as_of)]
    lower = min((window[0][0] for window in windows), default=as_of.date())
    if any(getattr(leaf.params, "change_reference", None) == "previous_day" for leaf in selected):
        prior = bisect.bisect_left(days, lower) - 1
        if prior >= 0:
            lower = days[prior]
    with screener_read_lock(data_dir / "screener"):
        data = (pl.scan_parquet(data_dir / "screener/daily_adjusted.parquet")
                .filter(pl.col("code").is_in(codes) & (pl.col("date") <= as_of.date())
                        & (pl.col("date") >= lower))
                .select("code", "date", "volume", "open", "high", "low", "close").collect())
    values = defaultdict(dict)
    for row in data.iter_rows(named=True):
        values[row["code"]][row["date"]] = _daily_bar(row)
    if overlay is not None:
        for row in overlay.iter_rows(named=True):
            if row["date"] <= as_of.date():
                values[row["code"]][row["date"]] = _daily_bar(row)
    return values, days


def _daily_bar(row):
    return VolumeBar(_stamp(row["date"]), row["volume"],
                     **{source: row.get(source) for source in screener_bar_price.PRICE_FIELDS})


@dataclass
class MinuteSnapshot:
    bars: list[VolumeBar]
    fetched_at_ms: int
    reason: str | None = None


_CACHE: OrderedDict[tuple, MinuteSnapshot] = OrderedDict()
_FLIGHTS: dict[tuple, asyncio.Task] = {}
_CURSORS: OrderedDict[tuple, int] = OrderedDict()


async def _fetch_minutes(data_dir: Path, code: str, timeframe: str, needed: int,
                         lower: dt.date | None, as_of: dt.datetime) -> MinuteSnapshot:
    """One governor admission per page; bounded work and no persistent archive."""
    fetched_at = int(time.time() * 1000)
    client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
    if client is None:
        return MinuteSnapshot([], fetched_at, "credentials_missing")
    scheduler = kiwoom_rest_runtime.ensure_scheduler(data_dir)
    scope = timeframe.removesuffix("m")
    cursor = as_of.strftime("%Y%m%d")
    bars_by_ms = {}
    reason = None
    for page_index in range(MAX_MINUTE_PAGES):
        page = await kiwoom_access.run_with_capacity(scheduler,
            key=("screener-bars", code, timeframe, cursor, as_of.date().isoformat()),
            api_id="ka10080", priority="background", client=client,
            fetch_fn=lambda c, cur=cursor: c.call("ka10080", {
                "stk_cd": code, "tic_scope": scope, "upd_stkpc_tp": "0", "base_dt": cur}))
        parsed = [kiwoom_minute_candles.parse_row(row) for row in page.rows]
        if any(row is None for row in parsed) or any(
            not str(row.get("trde_qty", "")).strip().lstrip("+-").isdigit() for row in page.rows
        ):
            return MinuteSnapshot([], fetched_at, "invalid_rows")
        rows = [row for row in parsed if row is not None]
        if not rows:
            break
        oldest = min(day for day, _ in rows)
        for day, candle in rows:
            # The oldest day can be truncated. A directly requested latest KRX
            # regular day fits one 900-row page, including at the retention floor.
            if day == oldest and day != cursor:
                continue
            stamp = dt.datetime.fromtimestamp(candle.t_ms / 1000, KST)
            if not (dt.time(9) <= stamp.time() <= dt.time(15, 30)) or stamp > as_of:
                continue
            close_ms = min(candle.t_ms + int(scope) * 60_000, _stamp(stamp.date(), 15, 30))
            bars_by_ms[candle.t_ms] = VolumeBar(candle.t_ms, candle.volume,
                                               int(as_of.timestamp() * 1000) < close_ms,
                                               **{source: getattr(candle, source)
                                                  for source in screener_bar_price.PRICE_FIELDS})
        ordered = sorted(bars_by_ms)
        enough = (len(ordered) >= needed if lower is None else bool(ordered)
                  and dt.datetime.fromtimestamp(ordered[0] / 1000, KST).date() < lower
                  and sum(dt.datetime.fromtimestamp(ms / 1000, KST).date() < lower for ms in ordered) >= needed)
        if enough or oldest >= cursor:
            break
        cursor = oldest
        if page_index == MAX_MINUTE_PAGES - 1:
            reason = "fetch_budget_exhausted"
    return MinuteSnapshot([bars_by_ms[ms] for ms in sorted(bars_by_ms)], fetched_at, reason)


async def minute_snapshot(data_dir, code, timeframe, needed, lower, as_of):
    key = (data_dir, code, timeframe, needed, lower, as_of.date())
    cached = _CACHE.get(key)
    now_ms = int(time.time() * 1000)
    if cached is not None and now_ms - cached.fetched_at_ms < MINUTE_TTL_MS:
        _CACHE.move_to_end(key)
        return cached
    if settings.rest_bypass_enabled(data_dir):
        return MinuteSnapshot([], now_ms, "rest_bypassed")
    task = _FLIGHTS.get(key)
    if task is None:
        task = asyncio.create_task(_load_minutes(key, data_dir, code, timeframe, needed, lower, as_of))
        _FLIGHTS[key] = task

    return await asyncio.shield(task)


async def _load_minutes(key, data_dir, code, timeframe, needed, lower, as_of):
    try:
        result = await _fetch_minutes(data_dir, code, timeframe, needed, lower, as_of)
    except Exception as exc:
        policy = classify_live_error(exc)
        log.exception("분봉 신고거래량 평가 불가 → %s (%s)", code, policy.reason)
        return MinuteSnapshot([], int(time.time() * 1000), policy.reason)
    finally:
        _FLIGHTS.pop(key, None)
    _CACHE[key] = result
    _CACHE.move_to_end(key)
    while len(_CACHE) > MAX_CACHE_ENTRIES or sum(len(item.bars) for item in _CACHE.values()) > MAX_CACHE_BARS:
        _CACHE.popitem(last=False)
    return result


def _evaluate_calendar(result, selected, codes, values, days, as_of, data_dir=None):
    evidence = screener_history_evidence.load(data_dir) if data_dir is not None else {}
    incomplete = set()
    windows = {leaf.id: _required_windows(leaf, days, as_of) for leaf in selected}
    for leaf in selected:
        expected = sorted({day for window in windows[leaf.id] for day in window[0]})
        calendar_complete = _calendar_complete(leaf, windows[leaf.id], days, as_of)
        for code in codes:
            bars = calendar_bars(values.get(code, {}), days, timeframe=leaf.params.timeframe,
                                 as_of=as_of, windows=windows[leaf.id])
            events, complete = records(leaf, bars, fetched_at_ms=int(time.time() * 1000))
            result.events[leaf.id].extend((code, event) for event in events)
            if not complete or not calendar_complete:
                reasons = {}
                if not calendar_complete:
                    reasons["calendar_unavailable"] = []
                observations = values.get(code, {})
                fact = evidence.get(code)
                missing = [day for day in expected if day not in observations]
                reasons.update(screener_history_evidence.missing_reasons(missing, fact))
                if any(not screener_bar_price.valid_prices(observations[day])
                       for day in expected if day in observations) \
                        and leaf.type not in VOLUME_TYPES:
                    reasons["invalid_daily_rows"] = []
                if not reasons:
                    reasons["insufficient_history"] = []
                incomplete.add(code)
                for reason, absent in reasons.items():
                    result.coverage.incomplete.append(BarVolumeCoverageItem(
                        code=code, condition_id=leaf.id, reason=reason,
                        missing_days=len(absent) if absent else None,
                        required_from=(absent or expected)[0].isoformat() if absent or expected else None,
                        required_to=(absent or expected)[-1].isoformat() if absent or expected else None,
                        name=fact.name if fact and fact.name else None))
    return incomplete


def _calendar_complete(leaf, windows, days, as_of):
    if not days or any(not window[2] for window in windows):
        return False
    historical = isinstance(leaf.params, RANGE_PARAMS)
    end = dt.date.fromisoformat(leaf.params.end_date) if historical else as_of.date()
    # A known Friday also covers the immediately following weekend.
    while end.weekday() >= WEEKEND_START:
        end -= dt.timedelta(days=1)
    if days[-1] < end:
        return False
    if historical:
        return dt.date.fromisoformat(leaf.params.start_date) >= days[0]
    needed = lookback(leaf) + comparison_period(leaf) - 1 + (not leaf.params.include_open_bar)
    return len(windows) >= needed


async def _evaluate_minute_leaf(leaf, code, *, data_dir, as_of, now, basis, fetch_codes, sem, volume_runtime):
    p = leaf.params
    lower = dt.date.fromisoformat(p.start_date) if isinstance(p, RANGE_PARAMS) else None
    needed = comparison_period(leaf) + (0 if lower else lookback(leaf) - 1) + (not p.include_open_bar)
    cutoff = (min(as_of, dt.datetime.combine(dt.date.fromisoformat(p.end_date), dt.time(15, 30), KST))
              if lower else as_of)
    key = (data_dir, code, p.timeframe, needed, lower, cutoff.date())
    cached = _CACHE.get(key)
    realtime = (volume_runtime if basis == "intraday" and volume_runtime
                and volume_runtime.supports(leaf) else None)
    live = realtime.snapshot(leaf, code, int(time.time() * 1000)) if realtime else None
    lower_bounds = set()
    if not live and code not in fetch_codes and (cached is None
            or int(time.time() * 1000) - cached.fetched_at_ms >= MINUTE_TTL_MS):
        return leaf, code, [], False, "fetch_budget_exhausted"
    try:
        async with asyncio.timeout(20):
            async with sem:
                if live:
                    data, received_ms, lower_bounds = live
                    snapshot = MinuteSnapshot(data, received_ms,
                        volume_runtime.reason(code) if hasattr(volume_runtime, 'reason') else None)
                else:
                    snapshot = await minute_snapshot(data_dir, code, p.timeframe, needed, lower, cutoff)
                    if realtime:
                        realtime.seed(leaf, code, snapshot, int(time.time() * 1000))
                        merged = realtime.snapshot(leaf, code, int(time.time() * 1000))
                        if merged:
                            data, received_ms, lower_bounds = merged
                            snapshot = MinuteSnapshot(data, received_ms)
                data, adjustment_reason = snapshot.bars, None
                if leaf.type not in VOLUME_TYPES:
                    # Pages contain more bars than requested. Only the actual
                    # predicate window needs factors; today's window is factor 1.
                    data = [bar for bar in data if p.include_open_bar or not bar.is_open]
                    if lower is None:
                        data = data[-(comparison_period(leaf) + lookback(leaf) - 1):]
                    data, adjustment_reason = await screener_bar_threshold.prepare_minutes(
                        leaf, data, data_dir, code, (now.astimezone(KST) if now.tzinfo else
                                               now.replace(tzinfo=KST)).strftime("%Y%m%d"))
    except TimeoutError:
        return leaf, code, [], False, "fetch_timeout"
    events, complete = await asyncio.to_thread(records, leaf, data,
                                               fetched_at_ms=snapshot.fetched_at_ms)
    for event in events:
        if event.bar_match and event.bar_start_ms in lower_bounds:
            event.bar_match.volume_is_lower_bound = True
    reason = snapshot.reason or adjustment_reason
    if not reason and not complete and lower_bounds and any(not bar.valid for bar in data):
        reason = "live_bar_unconfirmed"
    return leaf, code, events, complete and reason is None, reason


async def evaluate(*, data_dir, conditions, codes, basis, now, overlay=None,
                   daily_fallback_codes: set[str] | None = None, volume_runtime=None) -> Evaluation:
    selected = leaves(conditions)
    result = Evaluation(BarVolumeCoverage(total=len(codes), complete=0),
                        {leaf.id: [] for leaf in selected})
    as_of = now.astimezone(KST) if now.tzinfo is not None else now.replace(tzinfo=KST)
    confirmed_as_of = dt.datetime.combine(
        as_of.date() - dt.timedelta(days=as_of.hour < EOD_CUTOFF_HOUR), dt.time(15, 30), KST)
    if basis == "eod":
        as_of = confirmed_as_of
    calendar_leaves = [leaf for leaf in selected if not leaf.params.timeframe.endswith("m")]
    incomplete = set()
    # SQL already keeps confirmed data for codes without an overlay. Calendar
    # predicates must do the same, rather than require an empty current day/week.
    # Minute predicates retain their live clock even when daily quotes failed.
    fallback = daily_fallback_codes or set()
    groups = [([code for code in codes if code not in fallback], as_of, overlay),
              ([code for code in codes if code in fallback], confirmed_as_of, None)]
    for group, cutoff, daily_overlay in groups:
        if not calendar_leaves or not group:
            continue
        values, days = await asyncio.to_thread(
            _daily_values, data_dir, group, daily_overlay, cutoff, calendar_leaves)
        incomplete.update(await asyncio.to_thread(
            _evaluate_calendar, result, calendar_leaves, group, values, days, cutoff, data_dir))
    minute_leaves = [leaf for leaf in selected if leaf.params.timeframe.endswith("m")]
    if minute_leaves:
        # Rotate the bounded REST batch so repeated monitoring covers the whole
        # requested universe. Cached fresh snapshots remain eligible on every scan.
        cursor_key = (data_dir, tuple(codes))
        offset = _CURSORS.get(cursor_key, 0)
        fetch_codes = set((codes + codes)[offset:offset + min(len(codes), MAX_MINUTE_CODES_PER_SCAN)])
        _CURSORS[cursor_key] = (offset + MAX_MINUTE_CODES_PER_SCAN) % max(1, len(codes))
        while len(_CURSORS) > MAX_CURSOR_ENTRIES:
            _CURSORS.popitem(last=False)
        sem = asyncio.Semaphore(4)

        evaluations = await asyncio.gather(*(_evaluate_minute_leaf(leaf, code, data_dir=data_dir, as_of=as_of, now=now,
            basis=basis, fetch_codes=fetch_codes, sem=sem, volume_runtime=volume_runtime)
            for leaf in minute_leaves for code in codes))
        for leaf, code, events, complete, reason in evaluations:
            result.events[leaf.id].extend((code, event) for event in events)
            if not complete:
                incomplete.add(code)
                result.coverage.incomplete.append(BarVolumeCoverageItem(
                    code=code, condition_id=leaf.id, reason=reason or "insufficient_minute_history"))
    result.coverage.complete = len(codes) - len(incomplete)
    if volume_runtime and basis == "intraday" and any(volume_runtime.supports(leaf) for leaf in selected):
        prepared, receiving = volume_runtime.counts(selected, codes, int(time.time() * 1000))
        detail = volume_runtime.coverage() if hasattr(volume_runtime, 'coverage') else {}
        detail.pop('prepared', None)
        detail.pop('receiving', None)
        result.coverage.realtime = BarRealtimeCoverage(prepared=prepared, receiving=receiving,
                                                      continuous=bool(detail), **detail)
    return result

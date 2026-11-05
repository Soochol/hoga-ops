"""Native W/M history with a separate, expiring forming period.

The adjustment basis belongs to the cache key. An older in-flight request can
never repopulate a new day's cache. Whole native pages provide left-pan headroom.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from time import monotonic

from hoga.live import kiwoom_access, kiwoom_rest_runtime
from hoga.live.candle_fetch_result import DailyInvariantViolation
from hoga.live.candle_models import LiveCandle
from hoga.live.data_warnings import make_data_warning, violation_to_warning
from hoga.live.error_policy import classify_live_error
from hoga.live.kiwoom_calendar_candles import (
    API_IDS,
    CalendarTimeframe,
    candle_date,
    fetch_calendar_candles,
    period_bounds,
)
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomAuthError, KiwoomRestError
from hoga.live.single_flight import SingleFlight
from hoga.live.venue import Venue
from hoga.util.cache_primitives import LruDict

_CURRENT_TTL_SECONDS = 60
_MAX_BARS_PER_KEY = 6000


@dataclass
class _History:
    candles: dict[int, LiveCandle] = field(default_factory=dict)
    covered_from: date | None = None
    current: LiveCandle | None = None
    checked_at: float | None = None
    violations: list[DailyInvariantViolation] = field(default_factory=list)


class LiveCalendarCandleBackfill:
    def __init__(self, *, data_dir, scheduler, daily_backfill) -> None:
        self._data_dir = data_dir
        self._scheduler = scheduler
        self._daily = daily_backfill
        self._history: LruDict[tuple[Venue, str, CalendarTimeframe, date], _History] = LruDict(64)
        self._inflight = SingleFlight()

    async def _load(
        self,
        *,
        code: str,
        venue: Venue,
        timeframe: CalendarTimeframe,
        frm: date,
        today: date,
        cache_only: bool,
    ) -> tuple[list[LiveCandle], list[dict], bool]:
        key = (venue, code, timeframe, today)
        label = f"{frm:%Y%m%d}__{today:%Y%m%d}"
        first_current = period_bounds(today, timeframe)[0]
        target = period_bounds(frm, timeframe)[0]
        warnings = []
        fresh = False
        # A stable lock key serializes same-instrument walks without retaining
        # one lock per adjustment day. Entries themselves remain basis-specific.
        async with self._inflight.acquire((venue, code, timeframe)):
            entry = self._history.setdefault(key, _History)
            self._history.move_to_end(key)
            self._history.trim()
            missing = entry.covered_from is None or entry.covered_from > target
            current_stale = entry.checked_at is None or monotonic() - entry.checked_at >= _CURRENT_TTL_SECONDS
            if missing or current_stale:
                if cache_only:
                    warnings.append(
                        make_data_warning(
                            "rest_bypassed",
                            "REST 우회: 보관된 주·월봉만 표시합니다",
                            batch=label,
                        )
                    )
                else:
                    client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
                    if client is None:
                        raise KiwoomAuthError("kiwoom client not initialized")
                    start = frm if missing else first_current

                    def run_page(fetch_fn, page_idx):
                        return kiwoom_access.run_with_capacity(
                            self._scheduler,
                            client=client,
                            api_id=API_IDS[timeframe],
                            priority="user_visible",
                            key=("calendar", *key, start, page_idx),
                            fetch_fn=fetch_fn,
                        )

                    fetched_at = monotonic()
                    try:
                        result = await fetch_calendar_candles(
                            client,
                            code,
                            timeframe=timeframe,
                            frm=start,
                            as_of=today,
                            venue=venue,
                            run_page=run_page,
                        )
                    except (KiwoomRestError, KiwoomCapacityOverloaded) as exc:
                        policy = classify_live_error(exc)
                        warnings.append(make_data_warning(policy.reason, policy.message, batch=label))
                    else:
                        fresh = True
                        for candle in result.candles:
                            if candle_date(candle) < first_current:
                                entry.candles[candle.t_ms] = candle
                        current = [c for c in result.candles if candle_date(c) >= first_current]
                        if current or not result.violations:
                            entry.current = current[-1] if current else None
                        entry.checked_at = fetched_at
                        # A damaged page cannot prove coverage of missing bars.
                        # Keep valid rows, but retry its holes on a later read.
                        if not result.violations:
                            reached = (
                                target
                                if result.exhausted and missing
                                else period_bounds(candle_date(result.candles[0]), timeframe)[0]
                                if result.candles
                                else first_current
                            )
                            entry.covered_from = min(entry.covered_from or reached, reached)
                        entry.violations = result.violations
                        if len(entry.candles) > _MAX_BARS_PER_KEY:
                            stamps = sorted(entry.candles)[-_MAX_BARS_PER_KEY:]
                            entry.candles = {t: entry.candles[t] for t in stamps}
                            entry.covered_from = period_bounds(candle_date(entry.candles[stamps[0]]), timeframe)[0]
            warnings.extend(violation_to_warning(v, label) for v in entry.violations)
            bars = list(entry.candles.values())
            if entry.current is not None:
                bars.append(entry.current)
        return sorted(bars, key=lambda c: c.t_ms), warnings, fresh

    async def collect(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today: date,
        venue: Venue,
        timeframe: CalendarTimeframe,
        cache_only: bool = False,
    ) -> dict:
        first = period_bounds(frm, timeframe)[0]
        # Historical cutoffs inside a week/month must not expose its later days.
        last_first, last_end = period_bounds(too, timeframe)
        partial_history = too < today and too < last_end
        native_end = last_first - timedelta(days=1) if partial_history else too
        bars, warnings, fresh = (
            await self._load(
                code=code,
                venue=venue,
                timeframe=timeframe,
                frm=first,
                today=today,
                cache_only=cache_only,
            )
            if first <= native_end
            else ([], [], False)
        )
        selected = [c for c in bars if first <= candle_date(c) <= native_end]
        needs_fallback = venue != "KRX" and not any(w.get("is_failure") for w in warnings)
        if needs_fallback and _needs_fill(selected, first, native_end, timeframe):
            fallback, fallback_warnings, fallback_fresh = await self._load(
                code=code,
                venue="KRX",
                timeframe=timeframe,
                frm=first,
                today=today,
                cache_only=cache_only,
            )
            by_period = {
                period_bounds(candle_date(c), timeframe)[0]: c
                for c in fallback
                if first <= candle_date(c) <= native_end
            }
            if by_period:
                by_period.update({period_bounds(candle_date(c), timeframe)[0]: c for c in selected})
                selected = sorted(by_period.values(), key=lambda c: c.t_ms)
                warnings.append(
                    make_data_warning(
                        "daily_fallback_to_krx",
                        "주·월봉의 비어 있는 기간을 KRX로 보완했습니다",
                        batch=f"{frm:%Y%m%d}__{too:%Y%m%d}",
                    )
                )
            warnings.extend(fallback_warnings)
            fresh |= fallback_fresh
        if partial_history:
            fetch = self._daily.collect_daily_cache_only if cache_only else self._daily.collect_daily
            result = await fetch(
                code=code,
                frm=last_first,
                too=too,
                today_d=today,
                policy=venue,
                from_label=f"{last_first:%Y%m%d}",
                to_label=f"{too:%Y%m%d}",
            )
            boundary = _aggregate_daily([LiveCandle.model_validate(c) for c in result["candles"]])
            if boundary is not None:
                selected.append(boundary)
            warnings.extend(result["data_warnings"])
            fresh |= bool(result.get("fresh_batches"))
        label = f"{frm:%Y%m%d}__{too:%Y%m%d}"
        return {
            "code": code,
            "from": f"{frm:%Y%m%d}",
            "to": f"{too:%Y%m%d}",
            "venue": venue,
            "timeframe": timeframe,
            "candles": [c.model_dump() for c in selected],
            "cached_batches": [] if fresh else [label],
            "fresh_batches": [label] if fresh else [],
            "data_warnings": warnings,
        }


def _needs_fill(bars: list[LiveCandle], frm: date, too: date, timeframe: CalendarTimeframe) -> bool:
    if frm > too:
        return False
    periods = {period_bounds(candle_date(c), timeframe)[0] for c in bars}
    cursor = frm
    while cursor <= too:
        if cursor not in periods:
            return True
        cursor = period_bounds(cursor, timeframe)[1] + timedelta(days=1)
    return False


def _aggregate_daily(bars: list[LiveCandle]) -> LiveCandle | None:
    if not bars:
        return None
    bars = sorted(bars, key=lambda c: c.t_ms)
    amounts = [c.trade_value_won for c in bars]
    return LiveCandle(
        t_ms=bars[0].t_ms,
        open=bars[0].open,
        high=max(c.high for c in bars),
        low=min(c.low for c in bars),
        close=bars[-1].close,
        volume=sum(c.volume for c in bars),
        trade_value_won=sum(a for a in amounts if a is not None) if all(a is not None for a in amounts) else None,
    )

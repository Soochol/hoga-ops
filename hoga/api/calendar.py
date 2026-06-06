"""GET /api/inventory/calendar — per-symbol month status map.

Composes disk_state.check_disk_state with the KIS trading-day list and a
today/17-KST overlay. Pure read-side; no mutation. See spec §5.3, §11 Q21.
"""
from __future__ import annotations

import asyncio
import calendar as stdlib_calendar
import datetime as dt
import logging
import time
from pathlib import Path

from fastapi import APIRouter, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.error_codes import UpstreamCode
from hoga.api.models import CalendarCell, CalendarResponse
from hoga.api.params import CODE_PATTERN
# Single Clock seam: KST + now_kst + is_today_too_early all live on
# orchestrator.py per Refactor 3. The today_locked overlay below reuses
# the same predicate that captures.py's enqueue guard uses — keeps the
# 17-KST cutoff in one place.
from hoga.collector.orchestrator import is_today_too_early, now_kst as _now_kst

log = logging.getLogger(__name__)

# Module-level cache: (year, month) → set of YYYYMMDD trading-day strings.
# KRX trading days for past months are stable (holidays don't reschedule retro-
# actively), so an unbounded dict is fine for one process. For the current
# month we accept up to 24h staleness — a new holiday landing mid-month is
# rare enough that bouncing the server fixes it.
_month_cache: dict[tuple[int, int], set[str]] = {}

# Negative cache: (year, month) → monotonic time of the last FAILED fetch.
# Without it, the live poller's calendar gate re-ran the full blocking fetch
# every ~20s cycle for the whole session during a chk-holiday outage. Within
# the TTL we return None (weekday fallback) instantly instead of re-fetching.
_failure_cache: dict[tuple[int, int], float] = {}
_FAILURE_TTL_SECONDS = 60.0

# ADR-0064 — "is TODAY a KRX session?" cache, kept SEPARATE from _month_cache.
# `_session_confirmed` holds YYYYMMDD strings proven to be trading sessions;
# a positive verdict is stable for the day, so it is cached and never
# re-fetched. A *negative* verdict is deliberately NOT cached permanently —
# only its last check time is recorded, so a transient calendar miss for today
# (which would otherwise silently halt live capture for the rest of the
# process, the way the old get_market_ohlcv proxy did) self-heals on the next
# re-check instead of needing a process restart. Re-checks are throttled to
# avoid hammering the upstream on a real holiday. (Post KRX→KIS migration the
# data source is KIS chk-holiday via _trading_days_for, which adds its own
# month cache + failure TTL underneath — the per-day session semantics here
# are unchanged.)
_session_confirmed: set[str] = set()
_session_last_miss_ms: dict[str, float] = {}
_SESSION_MISS_RECHECK_S = 60.0

_last_failure_reason: UpstreamCode | None = None


def last_failure_reason() -> UpstreamCode | None:
    """Public accessor for the most recent KIS-availability failure."""
    return _last_failure_reason


class TradingDayUnavailableError(RuntimeError):
    """Trading-day data unavailable (KIS chk-holiday failed).
    Carries an UpstreamCode for HTTP surfacing."""
    def __init__(self, code: UpstreamCode) -> None:
        super().__init__(f"trading days unavailable: {code.value}")
        self.code = code


def _trading_days_for(year: int, month: int) -> set[str] | None:
    """Return YYYYMMDD strings for trading days in (year, month) via KIS
    chk-holiday (opnd_yn). Returns None when the fetch fails (creds missing,
    network, rt_cd) — most recent reason via :func:`last_failure_reason`.
    Cached results from earlier successful fetches stay valid; failures are
    negative-cached for ``_FAILURE_TTL_SECONDS`` so hot callers (poller gate)
    don't re-run the blocking fetch every cycle during an outage.
    """
    global _last_failure_reason  # noqa: PLW0603

    key = (year, month)
    cached = _month_cache.get(key)
    if cached is not None:
        return cached

    failed_at = _failure_cache.get(key)
    if failed_at is not None and (time.monotonic() - failed_at) < _FAILURE_TTL_SECONDS:
        return None  # recent failure — keep the fallback, don't re-fetch yet

    # Late import (per call) keeps the documented monkeypatch seam: tests patch
    # hoga.api.kis_holidays.fetch_month_trading_days as a module attribute.
    from hoga.api.kis_holidays import KisCredentialsMissing, fetch_month_trading_days

    try:
        result = fetch_month_trading_days(year, month)
    except Exception as e:  # noqa: BLE001 — KisHolidayFetchError or worse
        _last_failure_reason = (
            UpstreamCode.KIS_CREDENTIALS_MISSING
            if isinstance(e, KisCredentialsMissing)
            else UpstreamCode.KIS_HOLIDAY_FETCH_FAILED
        )
        _failure_cache[key] = time.monotonic()
        # The cause never reached operators before (no logger here) — keep it.
        log.warning("calendar: KIS trading-day fetch failed for %04d-%02d: %s", year, month, e)
        return None
    _month_cache[key] = result
    _failure_cache.pop(key, None)
    _last_failure_reason = None
    return result


def is_trading_session_today(
    today_yyyymmdd: str, *, _now_s: float | None = None
) -> bool | None:
    """Is ``today`` a live KRX trading session right now? (ADR-0064)

    Lag-free: backed by the KIS chk-holiday *calendar* (via
    :func:`_trading_days_for`), which lists the whole month — today included —
    upfront. This is the gate the live poller must use; the old daily-OHLCV
    proxy misread a live trading day as non-trading early in the session and
    (once cached) silently halted capture for the whole process.

    Returns True/False, or None when KIS data is unavailable (the poller stays
    lenient on None — losing capture for a transient outage is worse than a
    brief burst of empty fetches). A True verdict is cached for the day; a
    False is re-checked (throttled) so a transient miss self-heals without a
    restart. Underneath, ``_trading_days_for`` adds its own month cache and
    60s failure TTL, and the fetch raises on an empty month — so a cached
    wrong-False for a real session would require KIS itself answering a
    non-empty month that omits today.

    ``_now_s`` is a monotonic-seconds seam for tests; production passes None.
    """
    if today_yyyymmdd in _session_confirmed:
        return True

    now = _now_s if _now_s is not None else time.monotonic()
    year, month = int(today_yyyymmdd[:4]), int(today_yyyymmdd[4:6])
    last_miss = _session_last_miss_ms.get(today_yyyymmdd)
    if last_miss is not None:
        if (now - last_miss) < _SESSION_MISS_RECHECK_S:
            return False  # recently checked; today genuinely absent (holiday) — throttle
        # Throttle expired: this is a deliberate RE-CHECK of a negative.
        # Evict the month so the verdict comes from a FRESH fetch — otherwise
        # the permanent month cache would pin a transient miss for the whole
        # process, which is exactly the silent-halt ADR-0064 exists to prevent.
        # Cost: one extra KIS fetch per minute, only on days the calendar says
        # holiday during market hours (rare), and off-loop at the call sites.
        _month_cache.pop((year, month), None)

    days = _trading_days_for(year, month)
    if days is None:
        # Fetch failed — reason (creds vs upstream) already recorded by
        # _trading_days_for; its failure TTL throttles the retry cadence.
        return None
    if today_yyyymmdd in days:
        _session_confirmed.add(today_yyyymmdd)
        return True
    _session_last_miss_ms[today_yyyymmdd] = now
    return False


def trading_days_in_range(start: str, end: str) -> list[str]:
    """Public helper used by captures.py Task 7. Returns YYYYMMDD trading days
    in [start, end] inclusive, sorted.

    Raises :class:`TradingDayUnavailableError` when KIS data is unavailable for
    any month spanned by the range — fail-fast on the enqueue path so the user
    can't proceed with a guessed day list.

    Tests should monkeypatch or pre-populate ``_month_cache`` rather than rely
    on live KIS chk-holiday; tests should monkeypatch
    ``hoga.api.kis_holidays.fetch_month_trading_days`` to raise for error paths.
    """
    start_d = dt.date(int(start[:4]), int(start[4:6]), int(start[6:8]))
    end_d = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8]))
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    out: list[str] = []
    cur = dt.date(start_d.year, start_d.month, 1)
    while cur <= end_d:
        days = _trading_days_for(cur.year, cur.month)
        if days is None:
            raise TradingDayUnavailableError(last_failure_reason() or UpstreamCode.KIS_HOLIDAY_FETCH_FAILED)
        for d in sorted(days):
            if start <= d <= end:
                out.append(d)
        # Advance to the first day of the next month.
        if cur.month == 12:
            cur = dt.date(cur.year + 1, 1, 1)
        else:
            cur = dt.date(cur.year, cur.month + 1, 1)
    return out


def is_trading_day(date_yyyymmdd: str) -> bool | None:
    """Return True/False for ``date``, or None when KIS data is unavailable.

    Policy on None is the caller's: cold-path schedulers fail-fast
    (``trading_days_in_range`` raises), live-path callers fall back to a
    permissive default (e.g. don't gate polling so capture stays up when
    KIS is briefly unreachable). Keeping the data accessor and the policy
    separate avoids embedding either stance in the module.
    """
    year = int(date_yyyymmdd[:4])
    month = int(date_yyyymmdd[4:6])
    days = _trading_days_for(year, month)
    if days is None:
        return None
    return date_yyyymmdd in days


def reset_cache_for_tests() -> None:
    """Test helper — clears the trading-day cache between tests."""
    global _last_failure_reason  # noqa: PLW0603
    _month_cache.clear()
    _failure_cache.clear()
    _session_confirmed.clear()
    _session_last_miss_ms.clear()
    _last_failure_reason = None


def _all_weekdays_in_month(year: int, month: int) -> set[str]:
    """Fallback when KRX data is unavailable: treat every Mon–Fri as trading day.

    Holidays mis-classify as ``status="none"`` rather than ``"holiday"``, but the
    user sees the banner from ``CalendarResponse.reason`` and knows holiday
    accuracy is off.
    """
    last_day = stdlib_calendar.monthrange(year, month)[1]
    out: set[str] = set()
    for day in range(1, last_day + 1):
        d = dt.date(year, month, day)
        if d.weekday() < 5:
            out.add(f"{year:04d}{month:02d}{day:02d}")
    return out


def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
        DiskState.INVALID: "invalid",                       # ADR-0020
        DiskState.NO_UPSTREAM_DATA: "no_upstream_data",     # ADR-0021
        DiskState.NONE: "none",
    }[st]


def _captured_at_ms(data_dir: Path, code: str, date: str) -> int | None:
    parquet = data_dir / "parquet" / date / code
    if parquet.exists():
        try:
            return int(parquet.stat().st_mtime * 1000)
        except OSError:
            return None
    raw = data_dir / "raw" / date / code
    if raw.exists():
        try:
            return int(raw.stat().st_mtime * 1000)
        except OSError:
            return None
    return None


def _cell_status_for(date_str: str, now: dt.datetime, trading_days: set[str],
                     data_dir: Path, code: str) -> str:
    d = dt.date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))
    today = now.date()
    if d > today:
        return "future"
    if is_today_too_early(date_str, now):
        return "today_locked"
    if date_str not in trading_days:
        return "weekend" if d.weekday() >= 5 else "holiday"
    return _disk_state_to_status(check_disk_state(data_dir, code, date_str).state)


def get_month_map(*, data_dir: Path, code: str, year: int, month: int) -> CalendarResponse:
    """Build the month status map. Pure read-side. Fail-soft on KRX outage."""
    now = _now_kst()
    trading_days = _trading_days_for(year, month)
    if trading_days is None:
        reason = last_failure_reason()
        effective_trading_days = _all_weekdays_in_month(year, month)
    else:
        reason = None
        effective_trading_days = trading_days
    last_day = stdlib_calendar.monthrange(year, month)[1]
    cells: list[CalendarCell] = []
    for day in range(1, last_day + 1):
        date_str = f"{year:04d}{month:02d}{day:02d}"
        status = _cell_status_for(date_str, now, effective_trading_days, data_dir, code)
        captured_ms = (_captured_at_ms(data_dir, code, date_str)
                       if status in ("complete", "source_partial", "client_incomplete")
                       else None)
        cells.append(CalendarCell(date=date_str, status=status,  # type: ignore[arg-type]
                                  captured_at_ms=captured_ms))
    return CalendarResponse(cells=cells, as_of_ms=int(time.time() * 1000), reason=reason)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/inventory", tags=["inventory"])

    @router.get("/calendar")
    async def calendar_route(code: str = Query(..., pattern=CODE_PATTERN),
                              year: int = Query(..., ge=2000, le=2100),
                              month: int = Query(..., ge=1, le=12)) -> CalendarResponse:
        # Offload the entire build to a threadpool so the cold-month KIS
        # HTTP fetch inside _trading_days_for doesn't block the event loop.
        # Warm calls (cache hit) still incur the round-trip; overhead is
        # negligible (~microseconds) vs the per-stall (seconds) we avoid.
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: get_month_map(data_dir=data_dir, code=code, year=year, month=month),
        )

    return router

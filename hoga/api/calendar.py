"""GET /api/inventory/calendar — per-symbol month status map.

Composes disk_state.check_disk_state with the KRX trading-day list and a
today/18-KST overlay. Pure read-side; no mutation. See spec §5.3, §11 Q21.
"""
from __future__ import annotations

import calendar as stdlib_calendar
import datetime as dt
import time
from pathlib import Path

from fastapi import APIRouter, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.models import CalendarCell, CalendarResponse
# Single Clock seam: KST + now_kst + is_today_too_early all live on
# orchestrator.py per Refactor 3. The today_locked overlay below reuses
# the same predicate that captures.py's enqueue guard uses — keeps the
# 18-KST cutoff in one place.
from hoga.collector.orchestrator import is_today_too_early, now_kst as _now_kst


# Module-level cache: (year, month) → set of YYYYMMDD trading-day strings.
# KRX trading days for past months are stable (holidays don't reschedule retro-
# actively), so an unbounded dict is fine for one process. For the current
# month we accept up to 24h staleness — a new holiday landing mid-month is
# rare enough that bouncing the server fixes it.
_month_cache: dict[tuple[int, int], set[str]] = {}


def _trading_days_for(year: int, month: int) -> set[str]:
    """Return YYYYMMDD strings for KRX trading days in (year, month). Cached."""
    key = (year, month)
    cached = _month_cache.get(key)
    if cached is not None:
        return cached
    start = f"{year:04d}{month:02d}01"
    last_day = stdlib_calendar.monthrange(year, month)[1]
    end = f"{year:04d}{month:02d}{last_day:02d}"
    from pykrx import stock
    df = stock.get_market_ohlcv(start, end, "005930")
    result = {d.strftime("%Y%m%d") for d in df.index}
    _month_cache[key] = result
    return result


def trading_days_in_range(start: str, end: str) -> list[str]:
    """Public helper used by captures.py Task 7. Returns YYYYMMDD trading days
    in [start, end] inclusive, sorted. Composes _trading_days_for across all
    months the range spans, so multi-month ranges only hit pykrx once per month.

    Tests should monkeypatch this function (or pre-populate ``_month_cache``)
    rather than rely on live KRX access — KRX endpoints require KRX_ID / KRX_PW
    env vars.
    """
    start_d = dt.date(int(start[:4]), int(start[4:6]), int(start[6:8]))
    end_d = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8]))
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    out: list[str] = []
    cur = dt.date(start_d.year, start_d.month, 1)
    while cur <= end_d:
        days = _trading_days_for(cur.year, cur.month)
        for d in sorted(days):
            if start <= d <= end:
                out.append(d)
        # Advance to the first day of the next month.
        if cur.month == 12:
            cur = dt.date(cur.year + 1, 1, 1)
        else:
            cur = dt.date(cur.year, cur.month + 1, 1)
    return out


def reset_cache_for_tests() -> None:
    """Test helper — clears the trading-day cache between tests."""
    _month_cache.clear()


def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
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
    return _disk_state_to_status(check_disk_state(data_dir, code, date_str))


def get_month_map(*, data_dir: Path, code: str, year: int, month: int) -> CalendarResponse:
    """Build the month status map. Pure read-side."""
    now = _now_kst()
    trading_days = _trading_days_for(year, month)
    last_day = stdlib_calendar.monthrange(year, month)[1]
    cells: list[CalendarCell] = []
    for day in range(1, last_day + 1):
        date_str = f"{year:04d}{month:02d}{day:02d}"
        status = _cell_status_for(date_str, now, trading_days, data_dir, code)
        captured_ms = (_captured_at_ms(data_dir, code, date_str)
                        if status in ("complete", "source_partial", "client_incomplete")
                        else None)
        cells.append(CalendarCell(date=date_str, status=status,  # type: ignore[arg-type]
                                   captured_at_ms=captured_ms))
    return CalendarResponse(cells=cells, as_of_ms=int(time.time() * 1000))


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/inventory", tags=["inventory"])

    @router.get("/calendar")
    async def calendar_route(code: str = Query(..., pattern=r"^\d{6}$"),
                              year: int = Query(..., ge=2000, le=2100),
                              month: int = Query(..., ge=1, le=12)) -> CalendarResponse:
        return get_month_map(data_dir=data_dir, code=code, year=year, month=month)

    return router

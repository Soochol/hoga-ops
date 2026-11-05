"""Native domestic W/M bars. Prices are adjusted as of one explicit basis day.

Unlike ka10081, ka10082/83 turnover is already in won. Keep whole returned
pages: their extra older periods are useful to the next leftward gesture.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from hoga.live.candle_fetch_result import DailyInvariantViolation
from hoga.live.candle_models import LiveCandle
from hoga.live.kiwoom_daily_candles import parse_row, venue_code
from hoga.live.kiwoom_rest import KiwoomRestClient, PageRunner
from hoga.live.venue import Venue
from hoga.util.timeenc import KST

CalendarTimeframe = Literal["W", "M"]
API_IDS: dict[CalendarTimeframe, str] = {"W": "ka10082", "M": "ka10083"}
_MAX_PAGES = 20
_DATE_LENGTH = 8


def period_bounds(day: date, timeframe: CalendarTimeframe) -> tuple[date, date]:
    if timeframe == "W":
        first = day - timedelta(days=day.weekday())
        return first, first + timedelta(days=6)
    first = day.replace(day=1)
    return first, day.replace(day=calendar.monthrange(day.year, day.month)[1])


def candle_date(candle: LiveCandle) -> date:
    return datetime.fromtimestamp(candle.t_ms / 1000, KST).date()


@dataclass(frozen=True)
class CalendarFetchResult:
    candles: list[LiveCandle]
    violations: list[DailyInvariantViolation]
    exhausted: bool


async def fetch_calendar_candles(
    client: KiwoomRestClient,
    code: str,
    *,
    timeframe: CalendarTimeframe,
    frm: date,
    as_of: date,
    venue: Venue,
    run_page: PageRunner,
) -> CalendarFetchResult:
    target = period_bounds(frm, timeframe)[0].strftime("%Y%m%d")
    basis = as_of.strftime("%Y%m%d")
    covered = False

    def stop(rows, _page):
        nonlocal covered
        valid = [str(r.get("dt") or "") for r in rows]
        covered = any(len(s) == _DATE_LENGTH and s.isdigit() and s < target for s in valid)
        return covered

    rows, truncated = await client.walk(
        API_IDS[timeframe],
        {"stk_cd": venue_code(code, venue), "base_dt": basis, "upd_stkpc_tp": "1"},
        max_pages=_MAX_PAGES,
        stop=stop,
        run_page=run_page,
    )
    by_date: dict[int, LiveCandle] = {}
    violations = []
    for row in rows:
        if all(
            row.get(k) is None or (isinstance(row.get(k), str) and not row[k].strip())
            for k in (
                "dt",
                "open_pric",
                "high_pric",
                "low_pric",
                "cur_prc",
                "trde_qty",
                "trde_prica",
            )
        ):
            continue
        try:
            candle, violation = parse_row(
                row,
                from_yyyymmdd="19000101",
                to_yyyymmdd=basis,
                trade_value_unit_won=1,
            )
        except ValueError:
            candle = None
            violation = DailyInvariantViolation(
                str(row.get("dt") or "(empty)"),
                "malformed_row",
                "invalid calendar date",
            )
        if violation is not None:
            violations.append(violation)
        elif candle is not None:
            by_date.setdefault(candle.t_ms, candle)
    if truncated:
        violations.append(
            DailyInvariantViolation(
                target,
                "malformed_row",
                f"{API_IDS[timeframe]} truncated after {_MAX_PAGES} pages",
            )
        )
    return CalendarFetchResult(
        sorted(by_date.values(), key=lambda c: c.t_ms),
        violations,
        exhausted=not covered and not truncated,
    )

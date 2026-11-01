"""One calendar policy for market rankings and ranking predicates.

Weekends are known closed even beyond the calendar's coverage. Before opening,
an unknown current weekday can still read the previous confirmed session.
It is never permission to stamp undated vendor rows as today's observations.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from hoga.api import trading_days
from hoga.live.stock_sessions import stock_indicator_window
from hoga.util.timeenc import KST

RankingSessionState = Literal["open", "closed", "preopen", "holiday", "calendar_unavailable"]
RankingBasisSource = Literal["live", "stored", "provider", "unavailable"]


class RankingBasis(BaseModel):
    session: RankingSessionState
    source: RankingBasisSource
    trading_date: str | None = None
    observed_at_ms: int | None = None
    message: str | None = None


@dataclass(frozen=True)
class RankingSession:
    state: RankingSessionState
    date: dt.date | None

    @property
    def can_fetch(self) -> bool:
        return self.state in {"open", "closed"}


def _trading(day: dt.date, data_dir: Path | None) -> bool | None:
    if day.weekday() >= 5:  # noqa: PLR2004 — Saturday/Sunday
        return False
    return trading_days.is_trading_day(day.strftime("%Y%m%d"), data_dir)


def resolve(now: dt.datetime, venue: str, data_dir: Path | None) -> RankingSession:
    now = now.astimezone(KST) if now.tzinfo else now.replace(tzinfo=KST)
    day = now.date()
    opening = dt.time(9) if venue == "KRX" else dt.time(8)
    trading = _trading(day, data_dir)
    if trading is None and now.time() >= opening:
        return RankingSession("calendar_unavailable", None)
    if trading and now.time() >= opening:
        return RankingSession("open" if stock_indicator_window(int(now.timestamp() * 1000), venue) else "closed", day)
    # At midnight a new weekday may be outside the backward-looking calendar.
    # Before opening we only need its previous confirmed day, not today's verdict.
    state = "holiday" if trading is False else "preopen"
    known = trading_days.trading_days(data_dir)
    first = min(known) if known else now.strftime("%Y%m%d")
    # Stop at the first unknown weekday rather than silently jumping over it.
    while True:
        day -= dt.timedelta(days=1)
        if day.strftime("%Y%m%d") < first:
            return RankingSession("calendar_unavailable", None)
        trading = _trading(day, data_dir)
        if trading is None:
            return RankingSession("calendar_unavailable", None)
        if trading:
            return RankingSession(state, day)


def unavailable(session: RankingSession, message: str | None = None) -> RankingBasis:
    return RankingBasis(
        session=session.state, source="unavailable",
        trading_date=session.date.isoformat() if session.date else None,
        message=message or ("거래일 달력을 확인할 수 없습니다. 달력 갱신이 필요합니다."
            if session.state == "calendar_unavailable" else "최근 거래일의 저장된 순위가 없습니다."),
    )

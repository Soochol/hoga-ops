"""Task-local single-trading-day policy for server-owned minute searches.

The context follows asyncio children without changing unrelated chart/monitor
requests. Only evaluated results are checkpointed; provider bars remain in RAM.
"""
from __future__ import annotations

import contextlib
import datetime as dt
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field

from hoga.api import trading_days
from hoga.api.screener_expression import active_conditions
from hoga.util.timeenc import KST


@dataclass(frozen=True)
class MinuteScope:
    day: dt.date
    cutoff: dt.datetime
    pending: bool = False
    snapshots: dict = field(default_factory=dict, compare=False, repr=False)
    live: bool = False
    clock: Callable | None = field(default=None, compare=False, repr=False)
    cutoffs: dict = field(default_factory=dict, compare=False, repr=False)
    observations: list = field(default_factory=list, compare=False, repr=False)


current: ContextVar[MinuteScope | None] = ContextVar("screener_minute_scope", default=None)


def leaves(req):
    return [leaf for leaf in active_conditions(req.conditions, req.expression)
            if getattr(leaf.params, "timeframe", "D").endswith("m")]


def resolve(data_dir, now):
    now = now.astimezone(KST) if now.tzinfo else now.replace(tzinfo=KST)
    day = now.date()
    known = trading_days.trading_days(data_dir)
    if not known:
        raise ValueError("분봉 검색일을 확인할 거래일 달력이 없습니다")
    # Before opening, only prior dates need calendar coverage. Today's daily
    # calendar refresh may not have run yet (e.g. Monday just after midnight).
    # The loop still rejects an unknown weekday among those prior dates.
    if now.time() < dt.time(9):
        day -= dt.timedelta(days=1)
    # Weekends are known closed; never jump over an unknown weekday.
    while day.weekday() >= 5 or day.strftime("%Y%m%d") not in known:  # noqa: PLR2004 — weekend
        if day.weekday() < 5 and day.strftime("%Y%m%d") > max(known):  # noqa: PLR2004 — weekday
            raise ValueError("분봉 검색일의 거래일 달력이 부족합니다")
        day -= dt.timedelta(days=1)
        if day.strftime("%Y%m%d") < min(known):
            raise ValueError("마지막 거래일을 확인할 수 없습니다")
    cutoff = min(now, dt.datetime.combine(day, dt.time(15, 30), KST))
    return MinuteScope(day, cutoff, live=day == now.date() and dt.time(9) <= now.time() < dt.time(15, 30))


@contextlib.contextmanager
def bind(scope):
    token = current.set(scope)
    try:
        yield
    finally:
        current.reset(token)

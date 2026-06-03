"""Pure helpers shared by the two daily KIS walk-backs.

`fetch_past_daily_candles` and `fetch_investor_net` share *only* the cursor
step-back arithmetic (page oldest − 1 day → YYYYMMDD); their loop skeletons
otherwise differ (cursor param slot, anchor semantics, termination) enough that
a unified driver would be a leaky abstraction — see ADR-0060. This pins the one
genuinely-shared piece.
"""
from __future__ import annotations

from hoga.live.kis_client import _prev_day_yyyymmdd


def test_prev_day_simple() -> None:
    assert _prev_day_yyyymmdd("20240315") == "20240314"


def test_prev_day_month_boundary() -> None:
    assert _prev_day_yyyymmdd("20240301") == "20240229"  # 2024 is a leap year


def test_prev_day_year_boundary() -> None:
    assert _prev_day_yyyymmdd("20240101") == "20231231"

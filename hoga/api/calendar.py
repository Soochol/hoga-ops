"""GET /api/inventory/calendar (Task 15 implements).

Task 7 ships only the trading-day expansion helper used by
POST /api/captures/items. The pykrx call here is uncached; Task 15
expands this file with a (year, month) cache + a fuller cell-status
implementation for the calendar endpoint.
"""
from __future__ import annotations

from datetime import datetime


def trading_days_in_range(start: str, end: str) -> list[str]:
    """Returns YYYYMMDD trading days in [start, end] inclusive.

    Task 7 version: direct pykrx call, no cache (acceptable for enqueue
    which fires once per Start click). Task 15 adds the (year, month)
    cache used by the calendar endpoint.

    Tests should monkeypatch this function (or the captures-side
    ``_expand_to_trading_days``) rather than rely on live KRX access —
    KRX endpoints require KRX_ID / KRX_PW env vars.
    """
    from pykrx import stock
    start_d = datetime.strptime(start, "%Y%m%d").date()
    end_d = datetime.strptime(end, "%Y%m%d").date()
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    cal = stock.get_market_ohlcv(start, end, "005930")
    return [d.strftime("%Y%m%d") for d in cal.index]

"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""

from __future__ import annotations

from pydantic import BaseModel

from hoga.tables.candles import ApiCandle
from hoga.tables.snapshots import ApiOrderbookSnapshot
from hoga.tables.trades import ApiTrade


class StockDate(BaseModel):
    """Inventory entry: one captured Stock-Date with its boundaries."""

    date: str
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int


class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: ApiOrderbookSnapshot | None


class TradesResponse(BaseModel):
    trades: list[ApiTrade]


class CandlesResponse(BaseModel):
    candles: list[ApiCandle]


class Meta(BaseModel):
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    pages_collected: int
    total_unique_events: int
    parser_version: str

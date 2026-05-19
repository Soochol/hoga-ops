"""Pydantic v2 response models."""

from __future__ import annotations

from pydantic import BaseModel


class StockDate(BaseModel):
    """Inventory entry: one captured Stock-Date with its boundaries."""

    date: str
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int


class OrderbookSnapshot(BaseModel):
    ts_ms: int
    seq: int
    ask_p: list[int]  # length 10
    ask_q: list[int]
    bid_p: list[int]
    bid_q: list[int]
    tot_ask: int
    tot_bid: int


class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: OrderbookSnapshot | None


class Trade(BaseModel):
    ts_ms: int
    seq: int
    price: int
    qty: int
    side: int  # -1, 0, +1
    cum_vol: int


class TradesResponse(BaseModel):
    trades: list[Trade]


class Candle(BaseModel):
    ts_ms: int
    open: int
    close: int
    high: int
    low: int
    vol_a: int
    vol_b: int


class CandlesResponse(BaseModel):
    candles: list[Candle]


class BrokerEntry(BaseModel):
    side: str  # "buy" | "sell"
    rank: int
    broker: str
    qty_today: int
    qty_delta: int


class BrokersResponse(BaseModel):
    ts_ms: int | None
    entries: list[BrokerEntry]


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

"""KIS REST 응답 정규화 (pydantic). Populated in Stage 2."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class OrderbookLevel(BaseModel):
    price: int
    qty: int


class KisOrderbook(BaseModel):
    code: str
    asks: list[OrderbookLevel]  # asks[0] = best ask (lowest)
    bids: list[OrderbookLevel]  # bids[0] = best bid (highest)
    total_ask_qty: int
    total_bid_qty: int
    t_ms: int  # client-side epoch ms (UTC)


class KisTrade(BaseModel):
    price: int
    qty: int
    side: Literal[-1, 0, 1, 2]  # -1=sell, 0=mid, 1=buy, 2=auction
    side_source: Literal["inferred", "auction"]
    t_ms: int  # epoch ms (UTC)


class KisBrokerEntry(BaseModel):
    name: str
    qty: int


class KisBrokers(BaseModel):
    code: str
    buy_top: list[KisBrokerEntry]   # top-5 buy brokers
    sell_top: list[KisBrokerEntry]  # top-5 sell brokers


class KisCandle(BaseModel):
    t_ms: int   # epoch ms (UTC) — start of bar
    open: int
    high: int
    low: int
    close: int
    volume: int

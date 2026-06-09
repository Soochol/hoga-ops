"""KIS REST 응답 정규화 (pydantic). Quote/candle/investor wire models.

REST 시세 모델(KisOrderbook/KisTrade/KisBrokers):
  Task 13(f9a93b2)에서 poller 은퇴 시 삭제됐으나, ADR-0067 보는종목 REST 표시폴러(Part B)를 위해 복원.
"""
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


class InvestorNetPoint(BaseModel):
    """One trading day's foreign/institution net-buy quantity for a code.

    Net-buy is signed: positive = net buy, negative = net sell. ``t_ms`` anchors
    at 09:00 KST of the trading day — the same anchor ``KisCandle`` uses — so the
    frontend aligns investor bars to the daily candle of the same day.
    """
    t_ms: int             # epoch ms (UTC) — 09:00 KST anchor
    foreign_net: int      # 외국인 순매수 수량 (KIS frgn_ntby_qty)
    institution_net: int  # 기관계 순매수 수량 (KIS orgn_ntby_qty)

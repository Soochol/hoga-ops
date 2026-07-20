"""KIS REST 응답 정규화 (pydantic). Quote/candle/investor wire models.

호가/체결/거래원 시세 모델(KisOrderbook/KisTrade/KisBrokers)은 두 번 삭제됐다:
Task 13(f9a93b2) poller 은퇴 → ADR-0067 표시폴러로 복원 → PR-F2(2026-07-20)에서
거래원까지 키움 0F push 로 넘어가며 최종 삭제(소비자 0).
"""
from __future__ import annotations

from pydantic import BaseModel


class KisCandle(BaseModel):
    t_ms: int   # epoch ms (UTC) — start of bar
    open: int
    high: int
    low: int
    close: int
    volume: int


class IndexCandlePoint(BaseModel):
    t_ms: int   # epoch ms (UTC) — start of bar
    open: float
    high: float
    low: float
    close: float
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


class InvestorTrendEstimateRow(BaseModel):
    """Intraday KIS estimated foreign/institution quantity row for one slot."""

    slot: str
    foreign_qty: int | None
    institution_qty: int | None
    sum_qty: int | None


class ProgramTradeByStockRow(BaseModel):
    """One KIS stock-level program-trade row.

    `bsop_hour` is the KIS intraday HHMMSS key. The endpoint reports cumulative
    net-buy quantity/amount, so each observed point is independently meaningful
    even when the rolling response window skips intermediate rows.
    """

    code: str
    bsop_hour: str
    t_ms: int
    price: int | None
    net_qty: int | None
    net_amount: int | None
    buy_qty: int | None
    sell_qty: int | None
    buy_amount: int | None
    sell_amount: int | None
    delta_qty: int | None
    delta_amount: int | None

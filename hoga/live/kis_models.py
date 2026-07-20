"""KIS REST 응답 정규화 (pydantic). Quote/candle/investor wire models.

호가/체결/거래원 시세 모델(KisOrderbook/KisTrade/KisBrokers)은 두 번 삭제됐다:
Task 13(f9a93b2) poller 은퇴 → ADR-0067 표시폴러로 복원 → PR-F2(2026-07-20)에서
거래원까지 키움 0F push 로 넘어가며 최종 삭제(소비자 0).
"""
from __future__ import annotations

from pydantic import BaseModel


class KisCandle(BaseModel):
    """브로커 중립 캔들 포트 — 이름의 "Kis" 는 역사적이다.

    KIS REST 캔들 파서와 키움 REST 딥백필(kiwoom_client)이 **둘 다** 이 shape 로
    생산하고, 캔들 캐시·백필 사다리가 소스 무관으로 소비한다. 리네임은 22개
    사용처 파급이라 보류(2026-07-20 감사) — 이 주석이 실체를 말한다.
    """

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


# ProgramTradeByStockRow 는 program_trade_store.py 로 이사(2026-07-20 감사) —
# 공급원이 KIS REST 에서 키움 0w 로 바뀌어(PR-F4) KIS 모델이 아니게 됐다.

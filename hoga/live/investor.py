"""투자자 수급 도메인 모델 — 브로커 중립 포트 계약 타입.

확정 일별 순매수(`InvestorNetPoint`)와 장중 추정치(`InvestorTrendEstimateRow`)는
성질이 다르다 — 전자는 확정 데이터라 캔들과 나란히 저장·정렬되고, 후자는 장중
추정이라 슬롯 단위로 갱신되며 확정값과 어긋날 수 있다.

2026-08-03까지 `kis_models`에 있었다(#1018, 지도 #1005). 이사한 이유는 소비자가
소스 무관이기 때문이고, `kis_models`의 선례를 따른 것이다 — `ProgramTradeByStockRow`
는 공급원이 KIS REST에서 키움 `0w` push로 바뀌자 `program_trade_store.py`로 이사했다.

I/O 없음 — fixture로 완전 테스트 가능.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel


class InvestorNetPoint(BaseModel):
    """One trading day's foreign/institution net-buy quantity for a code.

    Net-buy is signed: positive = net buy, negative = net sell. ``t_ms`` anchors
    at 09:00 KST of the trading day — the same anchor ``Candle`` uses — so the
    frontend aligns investor bars to the daily candle of the same day.
    """
    t_ms: int             # epoch ms (UTC) — 09:00 KST anchor
    foreign_net: int      # 외국인 순매수 수량
    institution_net: int  # 기관계 순매수 수량


class InvestorTrendEstimateRow(BaseModel):
    """Intraday estimated foreign/institution quantity row for one slot."""

    slot: str
    foreign_qty: int | None
    institution_qty: int | None
    sum_qty: int | None


@dataclass(frozen=True)
class InvestorNetInvariantViolation:
    """A row dropped by fetch_investor_net boundary defense.

    Investor rows carry no OHLC invariant, so the only drop reason is a
    malformed/missing trading date. Surfaced to wire data_warnings.
    """
    date_yyyymmdd: str
    reason: Literal["malformed_row"]
    detail: str


@dataclass(frozen=True)
class InvestorNetFetchResult:
    """Return value of fetch_investor_net.

    `points` is ASC-sorted by t_ms; `violations` is the per-row drop log.
    """
    points: list[InvestorNetPoint]
    violations: list[InvestorNetInvariantViolation] = field(default_factory=list)

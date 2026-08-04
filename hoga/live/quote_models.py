"""시세 도메인 모델 — 브로커 중립 포트 계약 타입 (PR-J · #1046).

`candle_models` 가 봉 하나를 담듯 여기는 **시세 스냅샷**을 담는다. 2026-08-04까지
`kis_endpoints` 에 살았는데, 그 모듈은 KIS HTTP 어댑터 그 자체라 키움 어댑터가
거기서 import 하면 ADR-0116 규율 1(`kis_*` ↔ `kiwoom_*` 상호 import 금지) 정면
위반이다. 실제로 `kiwoom_multi_quote`·`kiwoom_index_rest` 가 그러고 있었다.

`Quote` 는 2026-08-04까지 `Quote` 였다. 벤더 접두어가 사실상 네임스페이스
노릇을 하고 있었을 뿐, 소비자(관심종목 목록·스크리너 장중 오버레이·순위)는 줄곧
소스 무관이었다 — `candle_models.LiveCandle` 이 `KisCandle` 에서 이름을 바꾼 것과
같은 이유이고 같은 판정 기준이다: **소비자가 소스 무관이면 중립 타입이다.**

I/O 없음 — fixture 로 완전 테스트 가능.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class IndexQuoteSnapshot:
    """국내업종 현재지수 1건 (FHPUP02100000) — 하단 시장지표 바 용.

    change/change_rate 는 부호 정규화 완료값 (KRX 하락 = 음수).
    t_ms 는 fetch 시각(epoch ms) — KIS 응답에 체결 시각이 없어 수신 시각으로 대체.
    """
    index_id: str
    value: float
    change: float
    change_rate: float
    t_ms: int




@dataclass(frozen=True)
class Quote:
    """One row of intstock-multprice (현재가 + 등락률 + 전일대비 등락액 + 당일 OHLCV) for a Code."""
    code: str
    price: int
    change_pct: float | None
    change_won: int | None = None
    # 당일 OHLC(inter2_oprc/hgpr/lwpr). 기본 None — positional 생성자/동등성 테스트 보존.
    open: int | None = None
    high: int | None = None
    low: int | None = None
    volume: int | None = None
    previous_close: int | None = None



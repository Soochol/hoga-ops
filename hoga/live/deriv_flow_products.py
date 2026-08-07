"""파생 투자자 수급이 다루는 상품표 — `(시장구분, 업종구분)` 쌍의 단일 진실.

KIS `FHPTJ04030000` 의 `fid_input_iscd` → `fid_input_iscd_2` 코드표에서 **요청받은
7종만** 추린 것이다. 벤더는 코스닥150(`KQI`)·위클리(`WKM`/`WKI`)·ETF/ELW/ETN 도 같은
축에 두지만, 여기 없는 것은 아직 화면이 요구하지 않았기 때문이지 못 얻어서가 아니다.

`multiplier_won` 은 **단위 검산의 근거**다(`deriv_flow_units`). 계약 1건의 원화 크기를
알면 응답의 대금÷수량 비율이 어느 단위 조합에서 나온 것인지 역산할 수 있다.
- KOSPI200 선물·옵션: 거래승수 250,000원 (2017년 500,000 → 250,000 인하)
- 미니 KOSPI200 선물·옵션: 50,000원
- 주식선물: 종목마다 계약단위가 다르고 응답은 **전 종목 합산**이라 승수가 없다 →
  `None`. 이 상품은 자체 검산이 불가능하므로 K2I 에서 확정한 단위를 적용한다.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DerivProduct:
    """상품 하나. `key` 는 `fid_input_iscd_2` 와 같다 — 벤더 코드를 그대로 식별자로
    쓴다(우리 이름을 새로 지으면 응답과 대조할 때 매핑이 하나 더 생긴다)."""

    key: str
    label: str
    #: `fid_input_iscd` — 시장구분
    iscd: str
    #: 선물/콜/풋. 화면이 콜·풋을 마주 세울 때 쓴다.
    family: str
    #: 계약 1건의 원화 승수. 주식선물은 합산이라 None.
    multiplier_won: int | None


PRODUCTS: tuple[DerivProduct, ...] = (
    DerivProduct("F001", "선물", "K2I", "futures", 250_000),
    DerivProduct("OC01", "콜옵션", "K2I", "call", 250_000),
    DerivProduct("OP01", "풋옵션", "K2I", "put", 250_000),
    DerivProduct("F004", "미니선물", "MKI", "futures", 50_000),
    DerivProduct("OC02", "미니콜옵션", "MKI", "call", 50_000),
    DerivProduct("OP02", "미니풋옵션", "MKI", "put", 50_000),
    DerivProduct("S001", "주식선물", "999", "futures", None),
)

BY_KEY: dict[str, DerivProduct] = {p.key: p for p in PRODUCTS}

#: 단위 검산의 기준 상품. **선물이어야 한다** — 옵션은 계약 단가가 프리미엄이라
#: 0.5~20pt 사이를 오가서 비율의 기대 구간이 40배로 벌어지고, 그러면 단위 가설끼리
#: 구간이 겹쳐 판정이 안 선다. 선물은 계약 단가가 지수 × 승수라 자릿수가 안정적이다.
UNIT_PROBE_KEY = "F001"

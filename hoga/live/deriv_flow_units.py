"""파생 투자자 수급 응답의 **단위 역산** — 벤더가 말해 주지 않으므로 값에서 읽는다.

## 실측 확정 (2026-08-07 15:59 KST, 파생 마감 직후 · 7상품 전부 응답)

**계약 + 백만원.** 주식(KSP)과 대금 단위가 같다.

    상품          승수       관측 비율   계약 단가        역산 지수
    F001 선물     250,000    245.32     245,324,649원   981.30
    F004 미니선물  50,000     48.92      48,923,493원   978.47

**이 표가 강한 이유는 판정이 모델을 통과해서가 아니라 모델이 실제 지수를 복원했기
때문이다.** 승수가 5배 다른 두 상품이 독립적으로 같은 단위 판정을 냈고, 각자 역산한
지수가 둘 다 그날 실제 KOSPI200 수준(선물 종가 979.10)이다. 단위 가정이 하나라도
틀렸다면 역산값이 5배 또는 1000배로 어긋난다.

교차검산: 선물 외국인 +2,369계약 / +582,167(백만원) = 5,822억 vs
2,369 × 981 × 250,000 = 5,810억.

## 그래도 가드는 남는다

확정됐다고 상수로 박지 않는다. 벤더가 축을 바꾸면 상수는 조용히 틀리고, 이 도메인은
**조용히 틀리는 것이 가장 비싼 실패**다(장중 표본은 소급 조회가 불가능해서 잘못 저장된
날을 다시 만들 수 없다). 가드의 역할이 "확인" 에서 **"회귀 감지"** 로 바뀌었을 뿐이다.

## 문서로는 왜 못 닫았나 (실측 전 조사 기록)

KIS 문서의 `FHPTJ04030000` 응답 표에는 단위 칸이 비어 있고, 예시도 코스피(KSP)
하나뿐이었다. 추론으로 옮길 수도 없었다 — 같은 벤더가 같은 `_tr_pbmn` 접미사에 서로
다른 단위를 쓴다:

    FHPTJ04030000 / KSP(코스피)      대금 = 백만원 · 수량 = 천주
        예시 역산: 주체별 대금÷수량 17.4~70.9 → 단가 17,430~70,900원/주(실제 범위와 일치)
    FHMIF10000000 / 선물옵션 시세     acml_tr_pbmn = 천원
        예시 역산: 220,924계약 × 395.00 × 250,000 = 21.82조 vs 응답 21,741,293,338 → 천원

그래서 **단위를 가정한 상수를 두지 않는다**. `kiwoom_investor` 가 단위 사고를 세 번 낸
뒤 세운 규율(#1117 — 단위는 요청이 정하고, 검산해서 확인한다)의 자동화판이다.

## 왜 2중인가

비율(대금÷수량) 하나로는 축을 못 가른다 — **(수량=계약, 대금=천원)과 (수량=천계약,
대금=백만원)이 같은 비율을 낸다**(둘 다 ≈ 지수×250). 그래서 수량 축을 자릿수로 먼저
못 박고, 그 위에서 비율로 금액 축을 읽는다.

    ① 수량 축   gross 거래량의 자릿수. KOSPI200 선물 일 거래량은 10~30만 계약이라
                계약 단위면 O(10⁴~10⁵), 천계약 단위면 O(10¹~10²) — 100배 이상 갈린다.
    ② 금액 축   ①이 계약으로 확정된 뒤의 대금÷수량 = 계약 단가. 지수 200~1500 ×
                승수 250,000 = 5.0e7 ~ 3.75e8 원이고, 단위 후보끼리 1000배씩 떨어져
                구간이 겹치지 않는다.

**선물로만 잰다**(`UNIT_PROBE_KEY`). 옵션은 계약 단가가 프리미엄이라 40배 폭으로
움직여 가설 구간이 겹친다. 주식선물은 전 종목 합산이라 승수가 아예 없다.

## 판정이 안 서는 경우

장 초반에는 계약 단위여도 거래량이 임계에 못 미친다. 그때는 **보류**(`None`)이고 다음
표본에서 다시 잰다 — 억지로 고르면 그게 곧 조용히 틀린 값이다. 보류 상태에서도 원값은
그대로 저장한다(장중 표본은 소급 조회가 불가능하므로 저장을 미루면 영영 잃는다).
읽기 경로가 미확정을 그대로 노출하고 환산을 거부한다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

#: gross 거래량이 이 값을 넘어야 수량 축을 판정한다. 천계약 단위라면 KOSPI200 선물
#: **하루 전체**가 O(10²)라 절대 넘지 못하는 값이어야 하고(그래야 오판이 없고),
#: 계약 단위라면 장 초반 몇 십 분이면 넘어야 한다(그래야 판정이 늦지 않는다).
#: 일 거래량 10~30만 계약의 1% 수준.
MIN_GROSS_QTY_FOR_VERDICT = 2_000

#: 계약 단가의 허용 구간(원). KOSPI200 지수 200~1500 × 승수 250,000.
#: 실제 지수는 수백~1,000대지만 넉넉히 잡는다 — 좁게 잡아 판정이 안 서는 쪽이
#: 잘못 서는 쪽보다 낫다는 원칙은 지키되, 구간 사이가 1000배라 넓혀도 겹치지 않는다.
_INDEX_MIN = 200.0
_INDEX_MAX = 1500.0

#: 금액 단위 후보 → 원 환산 배수.
AMOUNT_UNITS: dict[str, int] = {
    "won": 1,
    "thousand_won": 1_000,
    "million_won": 1_000_000,
}

#: 3주체만 쓴다. 나머지 9종은 필드명이 불규칙하고(`pe_fund_ntby_vol` 처럼 `_qty` 가
#: 아닌 것이 섞인다) 자릿수 판정에 보태는 것도 없다.
_ACTOR_PREFIXES = ("frgn", "prsn", "orgn")


@dataclass(frozen=True)
class UnitVerdict:
    """단위 판정 결과. 어느 축이든 `None` 이면 **미확정**이고 환산하면 안 된다."""

    quantity: str | None
    amount: str | None
    #: 관측된 대금÷수량. 판정 근거를 사람이 다시 볼 수 있게 남긴다.
    ratio: float | None
    gross_qty: int
    #: 왜 그렇게 판정했는지 / 왜 못 했는지. 로그와 API 응답이 그대로 쓴다.
    reason: str

    @property
    def resolved(self) -> bool:
        return self.quantity is not None and self.amount is not None

    def amount_to_won(self, value: float) -> float | None:
        """응답 대금 → 원. 미확정이면 None — 호출부가 환산을 포기해야 한다."""
        if self.amount is None:
            return None
        return value * AMOUNT_UNITS[self.amount]


def _num(row: dict[str, Any], key: str) -> float | None:
    v = row.get(key)
    if v is None or str(v).strip() == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _gross(row: dict[str, Any], suffixes: tuple[str, str]) -> float:
    """3주체 × (매도, 매수) 합. **순매수가 아니라 gross** 인 이유: 순매수는 부호가
    상쇄돼 장중 어느 시점엔 0 근처로 내려앉는데, 그러면 자릿수도 비율도 못 읽는다."""
    total = 0.0
    for p in _ACTOR_PREFIXES:
        for suf in suffixes:
            v = _num(row, f"{p}_{suf}")
            if v is not None:
                total += abs(v)
    return total


def infer_units(row: dict[str, Any], *, multiplier_won: int) -> UnitVerdict:
    """선물 응답 한 행에서 (수량 축, 금액 축)을 역산한다.

    `multiplier_won` 은 그 상품의 계약 승수(K2I 250,000 · MKI 50,000).
    """
    gross_qty = _gross(row, ("seln_vol", "shnu_vol"))
    gross_amt = _gross(row, ("seln_tr_pbmn", "shnu_tr_pbmn"))

    if gross_qty <= 0 or gross_amt <= 0:
        return UnitVerdict(None, None, None, int(gross_qty), "값 없음 — 판정 보류")

    if gross_qty < MIN_GROSS_QTY_FOR_VERDICT:
        # 계약 단위인데 아직 안 쌓였을 수도, 천계약 단위라 영영 못 넘을 수도 있다.
        # 둘을 구분할 수 없으므로 고르지 않는다.
        return UnitVerdict(
            None, None, gross_amt / gross_qty, int(gross_qty),
            f"거래량 {int(gross_qty)} < 임계 {MIN_GROSS_QTY_FOR_VERDICT} — 판정 보류",
        )

    ratio = gross_amt / gross_qty
    lo = _INDEX_MIN * multiplier_won
    hi = _INDEX_MAX * multiplier_won
    for name, scale in AMOUNT_UNITS.items():
        if lo <= ratio * scale <= hi:
            return UnitVerdict(
                "contract", name, ratio, int(gross_qty),
                f"거래량 {int(gross_qty)} → 계약 축, 계약단가 {ratio * scale:,.0f}원 → {name}",
            )

    # 어느 구간에도 안 맞는다 = 우리 모델이 틀렸다. 조용히 넘기면 그게 #1117 이다.
    return UnitVerdict(
        "contract", None, ratio, int(gross_qty),
        f"계약단가가 어느 단위에도 안 맞음 (비율 {ratio:,.2f}, 기대 {lo:,.0f}~{hi:,.0f}원) — 환산 거부",
    )

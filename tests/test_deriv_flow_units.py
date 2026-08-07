"""파생 응답의 단위 역산 — 이 판정이 틀리면 화면이 100배 틀린 값을 그린다.

벤더가 단위를 말해 주지 않고 문서로도 확정되지 않아(2026-08-07 조사) 값에서 읽는다.
**가장 중요한 케이스는 "동률 함정"** 이다: 비율 하나로는 (수량=계약, 대금=천원)과
(수량=천계약, 대금=백만원)을 못 가른다. 자릿수 검사가 그 동률을 깨는지를 못 박는다.
"""
from __future__ import annotations

from hoga.live.deriv_flow_units import MIN_GROSS_QTY_FOR_VERDICT, infer_units

_MULT = 250_000  # KOSPI200 선물 거래승수
_INDEX = 975.0   # 계약 단가 = 975 × 250,000 = 243,750,000원


def _row(*, qty_scale: float, amt_divisor: float) -> dict[str, str]:
    """3주체 gross 거래량 260,000계약 규모의 선물 응답을 합성한다.

    `qty_scale` = 1 이면 계약 단위, 0.001 이면 천계약 단위.
    `amt_divisor` = 1e6 이면 대금이 백만원 단위, 1e3 이면 천원 단위.
    """
    legs = {"frgn": (60_000, 58_000), "prsn": (30_000, 31_000), "orgn": (40_000, 41_000)}
    row: dict[str, str] = {}
    for prefix, (seln, shnu) in legs.items():
        for suffix, contracts in (("seln", seln), ("shnu", shnu)):
            row[f"{prefix}_{suffix}_vol"] = str(contracts * qty_scale)
            row[f"{prefix}_{suffix}_tr_pbmn"] = str(contracts * _INDEX * _MULT / amt_divisor)
    return row


def test_million_won_amount_is_identified():
    v = infer_units(_row(qty_scale=1, amt_divisor=1e6), multiplier_won=_MULT)
    assert (v.quantity, v.amount) == ("contract", "million_won")
    assert v.resolved


def test_thousand_won_amount_is_identified():
    """같은 거래에 대금만 천원 단위로 오면 판정도 따라 바뀌어야 한다 —
    `FHMIF10000000`(선물옵션 시세)이 실제로 쓰는 축이다."""
    v = infer_units(_row(qty_scale=1, amt_divisor=1e3), multiplier_won=_MULT)
    assert (v.quantity, v.amount) == ("contract", "thousand_won")


def test_won_amount_is_identified():
    v = infer_units(_row(qty_scale=1, amt_divisor=1), multiplier_won=_MULT)
    assert (v.quantity, v.amount) == ("contract", "won")


def test_thousand_contract_axis_is_not_mistaken_for_contracts():
    """**동률 함정.** (천계약, 백만원)은 (계약, 천원)과 비율이 같다 — 비율만 보면
    둘 다 계약단가 2.4375e8 원이 나온다. 자릿수 검사가 이걸 보류로 돌려야 한다.

    보류가 정답인 이유: 두 해석 중 어느 쪽인지 이 표본만으로는 알 수 없고, 억지로
    고르면 그게 조용히 1000배 틀린 값이 된다.
    """
    thousand_contracts = _row(qty_scale=0.001, amt_divisor=1e6)
    v = infer_units(thousand_contracts, multiplier_won=_MULT)
    assert v.quantity is None
    assert v.amount is None
    assert not v.resolved
    # 같은 비율의 (계약, 천원)은 판정이 선다 — 비율이 아니라 자릿수가 갈랐다는 증거.
    same_ratio = infer_units(_row(qty_scale=1, amt_divisor=1e3), multiplier_won=_MULT)
    assert v.ratio == same_ratio.ratio
    assert same_ratio.resolved


def test_early_session_low_volume_defers():
    """장 초반엔 계약 단위여도 임계에 못 미친다 — 고르지 않고 미룬다."""
    tiny = _row(qty_scale=MIN_GROSS_QTY_FOR_VERDICT / 260_000 / 2, amt_divisor=1e6)
    v = infer_units(tiny, multiplier_won=_MULT)
    assert not v.resolved
    assert "판정 보류" in v.reason


def test_empty_row_defers():
    v = infer_units({}, multiplier_won=_MULT)
    assert not v.resolved
    assert v.ratio is None


def test_out_of_model_ratio_refuses_conversion():
    """어느 단위 구간에도 안 맞으면 **환산을 거부한다.** 조용히 가장 가까운 것을
    고르면 그게 #1117 이다."""
    row = _row(qty_scale=1, amt_divisor=1e6)
    for k in list(row):
        if k.endswith("_tr_pbmn"):
            row[k] = str(float(row[k]) * 137)  # 어느 배수에도 안 맞는 값
    v = infer_units(row, multiplier_won=_MULT)
    assert v.quantity == "contract"
    assert v.amount is None
    assert v.amount_to_won(1.0) is None


def test_mini_multiplier_shifts_the_verdict():
    """미니는 승수가 1/5 다 — 같은 응답이라도 승수가 다르면 판정이 달라져야 한다.
    승수를 상품표에서 받아 오는 이유가 이것이다."""
    row = _row(qty_scale=1, amt_divisor=1e6)
    assert infer_units(row, multiplier_won=_MULT).amount == "million_won"
    # 미니 승수(50,000)로 읽으면 계약단가가 5배로 커져 백만원 구간을 벗어난다.
    assert infer_units(row, multiplier_won=50_000).amount != "million_won"


def test_amount_to_won_scales():
    v = infer_units(_row(qty_scale=1, amt_divisor=1e6), multiplier_won=_MULT)
    assert v.amount_to_won(1.0) == 1_000_000

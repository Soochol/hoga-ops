"""파생 수급 읽기 경로 — 단위 미확정이 **정직하게 드러나는지**를 고정한다.

이 표면의 특이점은 `unit` 이 null 일 수 있다는 것이다. 벤더가 대금 단위를 말해 주지
않아 값에서 역산하는데, 판정이 안 서면 억원 축이 통째로 비어야 한다 — 그때 계약 축은
멀쩡해야 하고, 화면이 이유를 말할 수 있게 `units.reason` 이 실려야 한다.
"""
from __future__ import annotations

from hoga.api.market_routes import _deriv_flow_payload
from hoga.live.deriv_flow_store import DerivFlowStore, DerivSample
from hoga.live.session_gate import DERIV_CLOSE_MIN, DERIV_OPEN_MIN

_INDEX = 975.0
_MULT = 250_000


def _row(*, qty_scale: float = 1.0, amt_divisor: float = 1e6, net: int = 5_000) -> dict[str, str]:
    legs = {"frgn": (60_000, 58_000), "prsn": (30_000, 31_000), "orgn": (40_000, 41_000)}
    row: dict[str, str] = {}
    for prefix, (seln, shnu) in legs.items():
        for suffix, contracts in (("seln", seln), ("shnu", shnu)):
            row[f"{prefix}_{suffix}_vol"] = str(contracts * qty_scale)
            row[f"{prefix}_{suffix}_tr_pbmn"] = str(contracts * _INDEX * _MULT / amt_divisor)
        row[f"{prefix}_ntby_qty"] = str(net)
        row[f"{prefix}_ntby_tr_pbmn"] = str(net * _INDEX * _MULT / amt_divisor)
    return row


def _seed(tmp_path, product: str, row: dict[str, str], *, t_ms: int = 1_000) -> None:
    store = DerivFlowStore(tmp_path)
    from hoga.collector.orchestrator import now_kst

    store.append_sample(
        now_kst().strftime("%Y%m%d"),
        DerivSample(
            sampled_at_ms=t_ms,
            product=product,
            request={"fid_input_iscd": "K2I", "fid_input_iscd_2": product},
            row=row,
        ),
    )


def test_empty_day_is_empty_not_error(tmp_path):
    """표본이 없는 날은 빈 상태다 — 실패가 아니다(장 시작 전이 정상 경로)."""
    got = _deriv_flow_payload(tmp_path)
    assert got["unit"] is None
    assert got["units"]["resolved"] is False
    assert all(p["points"] == [] for p in got["products"].values())
    # 상품 골격은 표본이 없어도 선다 — 화면이 빈 칸을 그릴 수 있어야 한다.
    assert set(got["products"]) >= {"F001", "OC01", "OP01", "F004", "OC02", "OP02", "S001"}


def test_session_axis_is_the_derivatives_window(tmp_path):
    """x축은 파생 세션(09:00–15:45)이다 — 주식 15:30 이 아니고, 화면이 하드코딩하지
    않도록 응답이 말한다."""
    got = _deriv_flow_payload(tmp_path)
    assert got["session_start_sec"] == DERIV_OPEN_MIN * 60 == 9 * 3600
    assert got["session_end_sec"] == DERIV_CLOSE_MIN * 60 == 15 * 3600 + 45 * 60


def test_resolved_units_convert_to_eok(tmp_path):
    _seed(tmp_path, "F001", _row())
    got = _deriv_flow_payload(tmp_path)
    assert got["unit"] == "amt_eok"
    assert got["units"]["amount"] == "million_won"
    pt = got["products"]["F001"]["points"][0]
    # 5,000계약 × 975 × 250,000 = 1.21875e12원 = 12,187.5억
    assert pt["foreign"] == 12_187.5
    assert pt["foreign_qty"] == 5_000


def test_unresolved_units_null_the_eok_axis_but_keep_contracts(tmp_path):
    """판정이 안 서면 억원은 null, 계약은 산다. 억지 환산이 #1117 이다."""
    thin = _row(qty_scale=0.001)  # 임계 미달 → 보류
    _seed(tmp_path, "F001", thin)
    got = _deriv_flow_payload(tmp_path)
    assert got["unit"] is None
    assert got["units"]["resolved"] is False
    assert "보류" in got["units"]["reason"]
    pt = got["products"]["F001"]["points"][0]
    assert pt["foreign"] is None
    assert pt["foreign_qty"] == 5_000


def test_units_are_probed_from_the_last_futures_sample(tmp_path):
    """판정은 **마지막** 선물 표본으로 한다 — 누적이 가장 많이 쌓여 자릿수 검사가
    가장 확실하다. 첫 표본으로 재면 장 초반 값이라 영영 보류가 된다."""
    _seed(tmp_path, "F001", _row(qty_scale=0.001), t_ms=1_000)   # 장 초반
    _seed(tmp_path, "F001", _row(), t_ms=2_000)                   # 누적 후
    got = _deriv_flow_payload(tmp_path)
    assert got["units"]["resolved"] is True


def test_option_products_inherit_the_futures_verdict(tmp_path):
    """옵션은 계약 단가가 프리미엄이라 자체 검산이 안 선다 — 선물에서 확정한 단위를
    같은 응답 스키마에 적용한다."""
    _seed(tmp_path, "F001", _row())
    _seed(tmp_path, "OC01", _row(net=1_200))
    got = _deriv_flow_payload(tmp_path)
    assert got["products"]["OC01"]["points"][0]["foreign"] is not None


def test_coverage_counts_per_product(tmp_path):
    """커버리지는 상품별이다 — 콜만 실패한 날이 그 비대칭을 드러내야 한다."""
    _seed(tmp_path, "F001", _row(), t_ms=1_000)
    _seed(tmp_path, "F001", _row(net=6_000), t_ms=61_000)
    got = _deriv_flow_payload(tmp_path)
    assert got["products"]["F001"]["coverage"]["sample_count"] == 2
    assert got["products"]["OC01"]["coverage"]["sample_count"] == 0
    # 405분 세션 / 60초 = 405
    assert got["products"]["F001"]["coverage"]["expected_count"] == 405

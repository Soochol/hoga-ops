"""키움 종목 마스터 테스트 (#1045, PR-I).

`.mst` 와 달라지는 함정 넷을 봉인한다. 넷 다 **조용히 틀리는** 종류다:
  ① 시장은 응답이 아니라 **요청**이 정한다
  ② ETN 코드에 `Q` 접두가 없다 → 캐시 schema bump 필수
  ③ ETN `marketCode` 가 **셋**(60·90·**70**)
  ④ SPEC 밖 상품(리츠·인프라·뮤추얼펀드)이 섞여 온다
"""
from __future__ import annotations

import pytest

from hoga.api import kiwoom_master as km

# 실측 행(2026-08-03). marketCode 는 **상품 종류**이지 시장이 아니다.
ROW_STOCK = {"code": "000020", "name": "동화약품", "marketCode": "0", "marketName": "거래소"}
ROW_ETF = {"code": "0000D0", "name": "TIGER 엔비디아", "marketCode": "8", "marketName": "ETF"}
ROW_ETN = {"code": "500061", "name": "신한 인버스 코스피 200", "marketCode": "60", "marketName": "ETN"}
ROW_ETN_VOL = {"code": "500095", "name": "신한 S&P500 VIX", "marketCode": "90",
               "marketName": "ETN(변동성)"}
ROW_ETN_CAP = {"code": "520066", "name": "미래에셋 KRX금현물", "marketCode": "70",
               "marketName": "ETN(손실제한)"}
ROW_REIT = {"code": "088260", "name": "이리츠코크렙", "marketCode": "6", "marketName": "리츠"}
ROW_INFRA = {"code": "088980", "name": "맥쿼리인프라", "marketCode": "2",
             "marketName": "인프라투자금융"}
ROW_FUND = {"code": "094800", "name": "맵스리얼티", "marketCode": "4", "marketName": "뮤추얼펀드"}


# === 함정 ① 시장은 요청이 정한다 =============================================

def test_market_comes_from_the_request_not_the_response() -> None:
    """KOSPI 요청에 `marketCode=8`(ETF) 이 1,155건 섞여 온다.

    이걸 시장으로 읽으면 ETF 가 전부 미상 시장이 된다. 시장 태깅의 근거는
    `mrkt_tp` 파라미터뿐이다.
    """
    assert km.MARKET_PARAM == {"KOSPI": "0", "KOSDAQ": "10"}
    row = km.parse_row(ROW_ETF, "KOSPI")
    assert row is not None
    assert row.market == "KOSPI", "marketCode 8 이어도 시장은 요청이 정한다"
    assert row.security_type == "etf"


async def test_fetch_calls_once_per_market_with_the_market_param() -> None:
    sent: list[dict] = []

    class _Client:
        async def call(self, api_id, body):
            sent.append({"api_id": api_id, **body})
            code = "0" if body["mrkt_tp"] == "0" else "10"
            return type("P", (), {"rows": [{**ROW_STOCK, "marketCode": code}]})()

    rows = await km.fetch_symbol_master(_Client())
    assert [s["mrkt_tp"] for s in sent] == ["0", "10"], "시장마다 한 번씩"
    assert {s["api_id"] for s in sent} == {"ka10099"}
    assert [r.market for r in rows] == ["KOSPI", "KOSDAQ"]


# === 함정 ② `Q` 접두 ========================================================

def test_measured_etn_codes_carry_no_q_prefix() -> None:
    """**캐시 schema bump 의 근거다.**

    `.mst` 는 `Q500061`, 키움은 `500061` 을 준다. bump 없이 전환하면 stale
    캐시와 새 fetch 가 같은 종목을 다른 코드로 내보내 검색이 이원화된다
    (기존 캐시에 `Q` 접두 380건).
    """
    row = km.parse_row(ROW_ETN, "KOSPI")
    assert row is not None and row.code == "500061"


def test_q_prefix_is_stripped_defensively() -> None:
    """실측 노출은 0건이지만 벤더가 다시 붙이면 캐시가 이원화된다."""
    assert km.normalize_code("Q500061") == "500061"
    assert km.normalize_code("500061") == "500061"
    assert km.normalize_code("QQQ") == "QQ", "접두 한 글자만 벗긴다"
    assert km.normalize_code("") == ""


# === 함정 ③ ETN 코드가 셋 ===================================================

@pytest.mark.parametrize("row", [ROW_ETN, ROW_ETN_VOL, ROW_ETN_CAP])
def test_all_three_etn_market_codes_are_mapped(row: dict) -> None:
    """`60`·`90` 만 매핑하면 **`70`(ETN 손실제한)이 조용히 사라진다.**

    지도 티켓이 60/90 만 적었는데 실측에 70 이 있었다.
    """
    got = km.parse_row(row, "KOSPI")
    assert got is not None, f"{row['marketName']} 이 버려졌다"
    assert got.security_type == "etn"


# === 함정 ④ SPEC 밖 상품 ====================================================

@pytest.mark.parametrize("row", [ROW_REIT, ROW_INFRA, ROW_FUND])
def test_out_of_scope_products_are_dropped(row: dict) -> None:
    """SPEC scope 는 보통주+ETF+ETN 이다 — `.mst` 가 `RT`/`IF`/`MF` 를 버리던 자리."""
    assert km.parse_row(row, "KOSPI") is None


def test_unknown_market_code_is_dropped_not_guessed() -> None:
    """모르는 코드를 stock 으로 넘기면 정체불명 상품이 검색에 샌다."""
    assert km.parse_row({**ROW_STOCK, "marketCode": "99"}, "KOSPI") is None


# === 방어 ===================================================================

@pytest.mark.parametrize("bad", [
    {**ROW_STOCK, "code": ""},
    {**ROW_STOCK, "name": "  "},
    {"marketCode": "0"},
])
def test_unreadable_rows_are_dropped(bad: dict) -> None:
    assert km.parse_row(bad, "KOSPI") is None


def test_empty_market_raises_so_no_empty_catalog_is_persisted() -> None:
    """0행을 성공으로 넘기면 **빈 카탈로그가 디스크를 덮는다** — 검색이 통째로 빈다."""
    with pytest.raises(km.KiwoomMasterFetchError):
        km.parse_market([ROW_REIT], "KOSPI")   # 전부 SPEC 밖 → 유효 0행


# === 시드 스냅샷 ============================================================

def test_seed_snapshot_is_loadable_and_plausible() -> None:
    """`.mst` 가 **무인증 정적 파일**이었다는 성질을 시드가 되산다(SPEC §7).

    `ka10099` 는 인증이 필요하므로, 시드가 없으면 자격증명 없는 첫 부팅에서
    검색이 통째로 빈다.
    """
    rows = km.load_seed()
    assert len(rows) > 4000, "코스피+코스닥 전 종목 규모여야 한다"
    kinds = {r.security_type for r in rows}
    assert kinds == {"stock", "etf", "etn"}
    assert {r.market for r in rows} == {"KOSPI", "KOSDAQ"}
    assert not any(r.code.startswith("Q") for r in rows), "시드에 `Q` 접두가 없어야 한다"
    assert all(r.name for r in rows)


def test_seed_contains_a_known_symbol() -> None:
    by_code = {r.code: r for r in km.load_seed()}
    assert by_code["005930"].name == "삼성전자"
    assert by_code["005930"].market == "KOSPI"
    assert by_code["005930"].security_type == "stock"

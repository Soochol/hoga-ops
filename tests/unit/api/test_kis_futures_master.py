"""KIS 지수선물 .mst 파서 테스트. 커밋된 실제 .mst 발췌 사용.

**주 회귀 가드는 "근월은 상품마다 다르다" 이다.** KOSPI200·코스닥150 은 3/6/9/12
월물만 상장이라 픽스처(2026-08 시점 실측)의 근월이 202609 인 반면, VKOSPI 는 연속월
이라 202608 이다. 전역 최소 만기를 골라 모든 상품에 쓰면 `A04609` 대신 `A04608` 을
써야 할 자리에 엉뚱한 코드가 들어가는데, **그 실패는 조용하다** — KIS 는 존재하지
않는 종목코드에도 `rt_cd=0` "정상처리" + 빈 필드를 준다.
"""
from pathlib import Path

import pytest

from hoga.api.kis_futures_master import (
    KisFuturesMasterFetchError,
    near_month,
    parse_futures_master,
)

FIX = Path(__file__).parent / "fixtures"


def _rows():
    return parse_futures_master((FIX / "futures_mst_sample.bin").read_bytes())


def test_product_split_by_code_prefix() -> None:
    by_code = {r.code: r.product for r in _rows()}
    assert by_code["A01609"] == "kospi200"
    assert by_code["A05608"] == "kospi200_mini"
    assert by_code["A06609"] == "kosdaq150"
    assert by_code["A04608"] == "vkospi"


def test_options_spreads_and_sector_futures_dropped() -> None:
    codes = {r.code for r in _rows()}
    # 옵션(B…)·스프레드(D…)는 선물이 아니다
    assert "B01608A16" not in codes
    assert "D0160901" not in codes
    # 섹터 지수선물은 화면 스코프 밖 — 카드에 올리지 않으므로 파싱하지 않는다
    assert "A08609" not in codes
    assert len(codes) == 9


def test_near_month_differs_per_product() -> None:
    rows = _rows()
    # 3/6/9/12 월물만 상장 — 8월에도 근월이 9월물이다(8월물 없음은 결측이 아니다)
    assert near_month(rows, "kospi200").code == "A01609"
    assert near_month(rows, "kosdaq150").code == "A06609"
    # 연속월 상품은 같은 날 근월이 8월물 — 전역 최소를 쓰면 여기서 깨진다
    assert near_month(rows, "vkospi").code == "A04608"
    assert near_month(rows, "kospi200_mini").code == "A05608"


def test_expiry_is_six_digits() -> None:
    by_code = {r.code: r for r in _rows()}
    # 4자리로 자르면 '2026' 이 되어 만기가 뭉개진다
    assert by_code["A01609"].expiry == "202609"
    assert by_code["A01703"].expiry == "202703"
    # 한글 접두가 붙어도 같은 꼬리를 읽는다
    assert by_code["A06612"].expiry == "202612"
    assert by_code["A04609"].expiry == "202609"


def test_underlying_carried_through() -> None:
    by_code = {r.code: r for r in _rows()}
    assert by_code["A01609"].underlying_code == "2001"
    assert by_code["A06609"].underlying_code == "3003"
    assert by_code["A06609"].underlying_label == "KSQ150"
    assert by_code["A04608"].underlying_code == "0503"


def test_parse_empty_raises() -> None:
    with pytest.raises(KisFuturesMasterFetchError):
        parse_futures_master(b"")


def test_parse_html_error_response_raises() -> None:
    with pytest.raises(KisFuturesMasterFetchError):
        parse_futures_master(b"<html><body>error</body></html>\n")


def test_near_month_missing_product_raises() -> None:
    # 빈 결과를 조용히 반환하면 상위가 종목코드 None 으로 벤더를 친다 — 여기서 끊는다.
    with pytest.raises(KisFuturesMasterFetchError):
        near_month([], "kospi200")

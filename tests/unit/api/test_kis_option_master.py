"""KIS 지수선물옵션 .mst 파서 테스트 (ADR-0135). 커밋된 실제 .mst 샘플 사용.

**주 회귀 가드는 f4 오용이다.** 마스터의 5번째 필드는 값이 2/3 으로만 갈려
콜/풋 구분처럼 보이지만 실제로는 아니다(실측: f4=2 안에 콜 1884·풋 2251).
픽스처에는 그 어긋남을 재현하는 4행이 들어 있다 — B01…(콜)인데 f4=3,
C01…(풋)인데 f4=2. 판별을 f4 로 되돌리면 아래 콜/풋 단언이 즉시 깨진다.

이 버그가 위험한 이유는 조용하지 않고 **절반만 틀리기** 때문이다: 콜과 풋이
뒤섞여도 개수는 그대로라 P/C 비율이 1 근처의 그럴듯한 값을 계속 낸다.
"""
from pathlib import Path

import pytest

from hoga.api.kis_option_master import (
    KisOptionMasterFetchError,
    near_month_chain,
    parse_option_master,
)

FIX = Path(__file__).parent / "fixtures"


def _rows():
    return parse_option_master((FIX / "option_mst_sample.bin").read_bytes())


def test_right_comes_from_code_prefix_not_field4() -> None:
    by_code = {r.code: r for r in _rows()}
    # f4=3 이지만 코드가 B… 이므로 콜이어야 한다 (f4 로 판별하면 풋으로 뒤집힌다)
    assert by_code["B01608A16"].right == "call"
    assert by_code["B01608A17"].right == "call"
    # f4=2 이지만 코드가 C… 이므로 풋이어야 한다
    assert by_code["C01608A16"].right == "put"
    assert by_code["C01608A17"].right == "put"
    # f4 와 코드가 우연히 일치하는 정상 행도 같은 규칙으로 뽑힌다
    assert by_code["B01608625"].right == "call"


def test_series_split_by_prefix() -> None:
    by_code = {r.code: r.series for r in _rows()}
    assert by_code["B01608625"] == "monthly"
    assert by_code["B05608665"] == "monthly_mini"
    assert by_code["C05608665"] == "monthly_mini"
    assert by_code["B09F9W752"] == "weekly_thu"
    assert by_code["BAFBQW752"] == "weekly_mon"


def test_futures_spread_and_other_underlying_dropped() -> None:
    codes = {r.code for r in _rows()}
    # 선물(A…)·스프레드(D…)는 옵션이 아니다
    assert "A01609" not in codes
    assert "D0160901" not in codes
    # KOSDAQ150(기초자산 3003) 옵션은 KOSPI200 스코프 밖 — 집계에 새면 안 된다
    assert "B06608001" not in codes
    assert len(codes) == 9


def test_strike_and_expiry_parsed() -> None:
    by_code = {r.code: r for r in _rows()}
    assert by_code["B01608A16"].strike == 1050.0
    assert by_code["B01608625"].strike == 625.0
    # 정규월물은 YYYYMM 6자리 — 4자리로 자르면 '2026' 이 되어 만기가 뭉개진다
    assert by_code["B01608625"].expiry == "202608"
    # 위클리는 YYMMWn
    assert by_code["B09F9W752"].expiry == "2608W1"
    assert by_code["BAFBQW752"].expiry == "2608W1"


def test_near_month_chain_scopes_to_series() -> None:
    rows = _rows()
    expiry, chain = near_month_chain(rows)
    assert expiry == "202608"
    # 정규월물만 — 미니가 섞이면 계약 승수가 달라 OI/거래량이 중복 집계된다
    assert all(r.series == "monthly" for r in chain)
    assert {r.code for r in chain} == {
        "B01608A16", "B01608A17", "C01608A16", "C01608A17", "B01608625",
    }


def test_mini_chain_is_separate() -> None:
    _, chain = near_month_chain(_rows(), series="monthly_mini")
    assert {r.code for r in chain} == {"B05608665", "C05608665"}


def test_parse_empty_raises() -> None:
    with pytest.raises(KisOptionMasterFetchError):
        parse_option_master(b"")


def test_parse_html_error_response_raises() -> None:
    with pytest.raises(KisOptionMasterFetchError):
        parse_option_master(b"<html><body>error</body></html>\n")


def test_near_month_chain_empty_raises() -> None:
    # 빈 체인을 조용히 반환하면 상위 집계가 0/0 으로 흘러간다 — 여기서 끊는다.
    with pytest.raises(KisOptionMasterFetchError):
        near_month_chain([], series="monthly")

"""`parse_info_row` 의 **위치 인덱스 매핑**을 고정한다.

이 가드가 막는 방향은 하나다: info 행의 필드 위치가 다시 어긋나는 것. 인덱스가
밀리면 각 필드는 **다른 날짜/다른 의미의 값**을 담고, 그건 예외가 아니라 그럴듯한
숫자로 나온다(#: today_open 자리에 종가가, today_high 자리에 전일 종가가 들어와
`high < low` 인 행이 전 종목·전 날짜에 깔렸다).

이 가드가 **못 보는 것**: 값의 신선도. 11~14 도 18~21 도 캡처 시점 스냅샷이라
장초반 캡처는 일봉 확정값과 다르다(`parse_info_row` docstring 실측 참조). 여기서
고정하는 건 "어느 위치가 어느 축인가" 뿐이다.
"""
from pathlib import Path

import pytest

from hoga.parser import parse_info_row
from hoga.tables.dispatch import FieldCountError

FIXTURE_LINE = (
    Path(__file__).parent / "fixtures" / "tiny_tsv" / "info.tsv"
).read_text(encoding="utf-8").strip()


def test_maps_every_field_to_the_right_position():
    """픽스처는 실제 hogaplay 행이다(대한항공 003490) — 값을 손으로 짜지 않는다."""
    info = parse_info_row(FIXTURE_LINE)

    assert info.code == "003490"
    assert info.name == "대한항공"
    assert info.regular_session_open_ms == 90000000
    assert info.regular_session_close_ms == 153000000
    # parts[11..14] — 당일 시/고/저/현재가
    assert info.today_open == 25700
    assert info.today_high == 26450
    assert info.today_low == 25100
    assert info.today_close == 25800
    # parts[15..17] — 상한가·하한가·기준가
    assert info.upper_limit == 33200
    assert info.lower_limit == 17900
    assert info.prev_close == 25550


def test_ohlc_invariants_hold():
    """고가는 최대, 저가는 최소 — 어긋난 인덱스가 만들던 바로 그 모순이다.

    구 매핑은 이 줄에서 high=25550(기준가) / low=25750(전일 시가) 를 실어
    `high < low` 였다. 값 단언과 함께 두는 이유: 인덱스가 **다른 방향으로**
    밀려도 여기서 걸린다.
    """
    info = parse_info_row(FIXTURE_LINE)

    assert info.today_high >= info.today_low
    assert info.today_high >= info.today_open
    assert info.today_high >= info.today_close
    assert info.today_low <= info.today_open
    assert info.today_low <= info.today_close


def test_price_limits_derive_from_prev_close():
    """상·하한가는 기준가의 ±30%(호가단위 반올림)다.

    ⚠ 이건 **이 줄에 대한** 단언이지 보편 불변식이 아니다. 기준가는 배당락·권리락
    날 전일 종가와 갈리고, 퇴화 행은 세 값이 전부 0 이다.
    """
    info = parse_info_row(FIXTURE_LINE)

    assert info.upper_limit == pytest.approx(info.prev_close * 1.3, rel=0.005)
    assert info.lower_limit == pytest.approx(info.prev_close * 0.7, rel=0.005)


def test_unknowns_keeps_only_the_still_unnamed_field():
    info = parse_info_row(FIXTURE_LINE)

    assert set(info.unknowns) == {"f11"}


def test_degenerate_row_parses_without_raising():
    """장초반·부분 캡처는 가격 필드가 전부 0 으로 온다 — 실존하는 행이다.

    실측 raw 1,869건 중 429건이 이 모양이다(2026-03-13 005290 등, 이름도 빈 값).
    파스 시점에 OHLC 불변식을 강제하면 이 행들이 통째로 죽으므로 **걸지 않는다**.
    """
    line = "\t".join([
        "1", "005290", "", "0", "90000000", "0", "1246", "83000159", "90455359",
        "21405", "1050", "49150", "49350", "48800", "48800", "0", "0", "0",
        "49700", "50800", "49200", "50800",
    ])

    info = parse_info_row(line)

    assert info.prev_close == 0
    assert info.upper_limit == 0
    assert info.lower_limit == 0
    assert info.today_open == 49150


def test_short_row_is_a_field_count_error():
    with pytest.raises(FieldCountError):
        parse_info_row("\t".join(["1", "003490", "대한항공"]))

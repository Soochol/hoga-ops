"""세그먼트 결손 총량 — 소스 배지가 읽는 값(`RangeSegment.gap_ms`).

배지가 소스 이름만 내던 시절, 2026-08-06 000660 은 키움이 정규장 6.5시간 중 **5시간
31분**을 놓친 채 그려졌는데 사다리 1순위라 아무 표시가 없었다. 사용자가 화면을 보고
직접 발견할 때까지 시스템은 침묵했다. 이 값이 그 침묵을 깬다.

**`is_partial` 대신 크기를 싣는 이유**는 그 필드가 이진값이라 3분 구멍과 4시간 구멍을
구분하지 못하기 때문이다 — 등급만 보고 소스를 자동 전환하면 실측상 26.8%의 칸에서
10배 촘촘한 데이터를 버린다(모듈 주석 참조).
"""
from __future__ import annotations

import pytest

from hoga.api.bundle import _segment_gap_ms

DATE = "20260806"


def test_missing_gap_ranges_is_unknown_not_zero() -> None:
    """**`None`(정보 없음)과 `0`(결손 없음)은 다르다.**

    합치면 정보가 없는 상태가 "완전함" 으로 둔갑해 배지가 조용해진다 — 이 리포가
    이미 겪은 계약 드리프트 패턴(#1183). 소비자가 셋을 각각 다뤄야 한다.
    """
    assert _segment_gap_ms(DATE, {}) is None
    assert _segment_gap_ms(DATE, {"gap_ranges": None}) is None


def test_empty_gap_ranges_is_zero() -> None:
    assert _segment_gap_ms(DATE, {"gap_ranges": []}) == 0


def test_packed_decimal_is_decoded_not_subtracted() -> None:
    """⚠ `gap_ranges` 값은 **HHMMSSmmm packed-decimal**(ADR-0010/0049)이다.

    09:00:00.000 ~ 11:10:30.017 은 실제로 2시간 10분 30.017초 = 7,830,017ms 인데,
    그대로 빼면 `111030017 - 90000000 = 21,030,017` — **2.7배 부풀려진다**. 이 테스트가
    그 실수를 막는다.
    """
    got = _segment_gap_ms(DATE, {"gap_ranges": [{"start_ms": 90000000, "end_ms": 111030017}]})
    assert got == 7_830_017
    assert got != 111030017 - 90000000


def test_multiple_ranges_sum() -> None:
    # 실측 형태(20260806 000660 ws/KRX): 09:00~11:10 + 12:42~15:11
    meta = {"gap_ranges": [
        {"start_ms": 90000000, "end_ms": 111030017},
        {"start_ms": 124250012, "end_ms": 151142005},
    ]}
    assert _segment_gap_ms(DATE, meta) == 7_830_017 + 8_931_993  # = 16,762,010ms ≈ 4시간 39분


def test_reversed_or_equal_range_contributes_nothing() -> None:
    """끝이 시작보다 앞서면 음수를 더하지 않는다(총량이 줄어드는 것을 막는다)."""
    meta = {"gap_ranges": [
        {"start_ms": 111030017, "end_ms": 90000000},
        {"start_ms": 90000000, "end_ms": 90000000},
    ]}
    assert _segment_gap_ms(DATE, meta) == 0


@pytest.mark.parametrize("bad", [
    [{"start_ms": 90000000}],                    # end 누락
    [{"end_ms": 111030017}],                     # start 누락
    [{"start_ms": "구름", "end_ms": 111030017}],  # 숫자 아님
    [{"start_ms": None, "end_ms": 111030017}],   # None
])
def test_unreadable_range_yields_unknown(bad) -> None:
    """한 구간이라도 못 읽으면 **총량이 과소집계된다** — 조용히 작은 수를 주느니
    "모른다"(`None`)가 정직하다. 작은 수는 배지를 끄지만 `None` 은 트리거만 비활성화하고
    소스 표시는 남긴다."""
    assert _segment_gap_ms(DATE, {"gap_ranges": bad}) is None


def test_out_of_range_clock_values_are_not_rejected() -> None:
    """⚠ **시각 범위는 검증되지 않는다** — 잡히는 것은 *구조적* 오류뿐이다.

    `hhmmssms_to_unix_ms` 는 `99:99:99.999` 도, 음수도 그대로 산술 변환한다(실측).
    따라서 `_segment_gap_ms` 의 `None` 은 "값이 이상하다" 가 아니라 "모양이 깨졌다" 를
    뜻한다. 이 테스트는 그 경계를 못 박아, 나중에 누가 `None` 을 값 검증 신호로
    오해하는 것을 막는다. writer 가 인코딩을 보장하므로(ADR-0049) 실무상 문제는 없다.
    """
    got = _segment_gap_ms(DATE, {"gap_ranges": [{"start_ms": 90000000, "end_ms": 999999999}]})
    assert got is not None
    assert got > 0

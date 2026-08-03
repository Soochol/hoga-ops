"""Tests for hoga.live.kis_venue — KIS 고유의 venue wire 인코딩.

거래소 도메인 자체의 테스트는 #1018(지도 #1005)에서 `test_venue.py` 로 분리했다.
여기 남은 것은 KIS 스택과 함께 사라질 검증뿐이다.
"""

import pytest

from hoga.live.kis_venue import kis_venue_div, previous_empty_page_anchor_hhmmss


def test_kis_venue_div_maps_to_kis_codes() -> None:
    assert kis_venue_div("KRX") == "J"
    assert kis_venue_div("NXT") == "NX"
    assert kis_venue_div("UN") == "UN"


def test_kis_venue_div_rejects_non_concrete_runtime_values() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        kis_venue_div("AUTO")  # type: ignore[arg-type]


# `previous_empty_page_anchor_hhmmss` 는 프로덕션 호출자가 0 이다(#1010 전수조사).
# KIS 스택 삭제와 함께 사라질 코드라 정리하지 않고, 그 사실만 여기 남긴다.
def test_previous_empty_page_anchor_stops_for_krx() -> None:
    assert previous_empty_page_anchor_hhmmss("KRX", "20260609", "153000") is None


def test_previous_empty_page_anchor_jumps_known_nxt_pause() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "153000") == "151900"
    assert previous_empty_page_anchor_hhmmss("UN", "20260609", "090000") == "085900"


def test_previous_empty_page_anchor_stops_on_unknown_gap() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "183000") is None


def test_previous_empty_page_anchor_stops_at_venue_open() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "080000") is None

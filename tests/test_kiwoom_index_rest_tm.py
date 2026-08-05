"""ka20001 `tm_n` 파싱 — 마감 후 센티넬이 지수 전체를 죽이던 버그의 고정.

2026-08-05 실측: 장 마감 후 첫 행이 `tm_n='888888'`(장 마감 확정치 표기)로 오는데,
길이·숫자 검사만 하던 파서가 `now.replace(hour=88)` 에서 ValueError 를 냈다. 그 예외를
라우트가 삼켜 **모든 지수가 조용히 드롭**됐고, 증상은 "자격증명 문제" 처럼 보였다.
"""
from __future__ import annotations

import datetime as dt

from hoga.live.kiwoom_index_rest import _TM_CLOSED_SENTINEL, _tm_to_ms
from hoga.util.timeenc import KST


def _hhmmss(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, KST).strftime("%H%M%S")


def test_normal_time_is_stamped_on_today():
    assert _hhmmss(_tm_to_ms("152000")) == "152000"
    assert _hhmmss(_tm_to_ms("090000")) == "090000"


def test_closed_sentinel_falls_back_instead_of_raising():
    """`888888` 은 길이·숫자 검사를 통과한다 — 범위 검사가 없으면 여기서 터졌다."""
    before = dt.datetime.now(KST).timestamp() * 1000
    got = _tm_to_ms(_TM_CLOSED_SENTINEL)  # ValueError 를 던지면 안 된다
    after = dt.datetime.now(KST).timestamp() * 1000
    assert before - 1000 <= got <= after + 1000  # 수신 시각으로 대체


def test_out_of_range_components_fall_back():
    """시·분·초 각각의 범위를 본다 — 하나만 깨져도 예외 대신 폴백."""
    for bad in ("240000", "126000", "120060", "999999"):
        got = _tm_to_ms(bad)
        assert isinstance(got, int) and got > 0


def test_malformed_shapes_still_fall_back():
    for bad in ("", "12", "abcdef", "12:00:00"):
        assert isinstance(_tm_to_ms(bad), int)

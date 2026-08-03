"""Tests for hoga.live.venue — 브로커 중립 거래소 도메인.

#1018(지도 #1005)에서 `test_kis_venue.py` 로부터 분리. 남은 `test_kis_venue.py` 는
KIS wire 인코딩(`kis_venue_div`)만 검증한다 — KIS 스택과 함께 사라질 테스트다.
"""

from datetime import datetime

import pytest

from hoga.live.venue import (
    daily_venue_for_policy,
    parse_live_venue_policy,
    parse_venue,
    quote_venue_for_policy,
    session_window_hhmmss,
)
from hoga.util.timeenc import KST


def test_parse_venue_accepts_supported_values() -> None:
    assert parse_venue("KRX") == "KRX"
    assert parse_venue("NXT") == "NXT"
    assert parse_venue("UN") == "UN"


def test_parse_venue_rejects_auto_at_concrete_boundary() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        parse_venue("AUTO")


def test_session_window_hhmmss_by_venue() -> None:
    assert session_window_hhmmss("KRX") == ("090000", "153000")
    assert session_window_hhmmss("NXT") == ("080000", "200000")
    assert session_window_hhmmss("UN") == ("080000", "200000")


def test_session_window_rejects_non_concrete_runtime_values() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        session_window_hhmmss("AUTO")  # type: ignore[arg-type]


def test_parse_live_venue_policy_maps_legacy_auto_to_integrated() -> None:
    assert parse_live_venue_policy("AUTO") == "UN"


def test_daily_venue_for_policy_maps_explicit_values() -> None:
    assert daily_venue_for_policy("KRX") == "KRX"
    assert daily_venue_for_policy("NXT") == "NXT"
    assert daily_venue_for_policy("UN") == "UN"


def test_quote_venue_for_policy_maps_explicit_values() -> None:
    now = datetime(2026, 7, 1, 8, 30, tzinfo=KST)
    assert quote_venue_for_policy("KRX", now) == "KRX"
    assert quote_venue_for_policy("NXT", now) == "NXT"
    assert quote_venue_for_policy("UN", now) == "UN"

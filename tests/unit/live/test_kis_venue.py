"""Tests for hoga.live.kis_venue."""

import pytest
from datetime import datetime

from hoga.live.kis_venue import (
    KIS_KST,
    daily_venue_for_policy,
    kis_venue_div,
    parse_kis_venue,
    parse_live_venue_policy,
    previous_empty_page_anchor_hhmmss,
    quote_venue_for_policy,
    session_window_hhmmss,
)


def test_parse_kis_venue_accepts_supported_values() -> None:
    assert parse_kis_venue("KRX") == "KRX"
    assert parse_kis_venue("NXT") == "NXT"
    assert parse_kis_venue("UN") == "UN"


def test_parse_kis_venue_rejects_auto_at_kis_client_boundary() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        parse_kis_venue("AUTO")


def test_kis_venue_div_maps_to_kis_codes() -> None:
    assert kis_venue_div("KRX") == "J"
    assert kis_venue_div("NXT") == "NX"
    assert kis_venue_div("UN") == "UN"


def test_kis_venue_div_rejects_non_concrete_runtime_values() -> None:
    with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
        kis_venue_div("AUTO")  # type: ignore[arg-type]


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
    now = datetime(2026, 7, 1, 8, 30, tzinfo=KIS_KST)
    assert quote_venue_for_policy("KRX", now) == "KRX"
    assert quote_venue_for_policy("NXT", now) == "NXT"
    assert quote_venue_for_policy("UN", now) == "UN"


def test_previous_empty_page_anchor_stops_for_krx() -> None:
    assert previous_empty_page_anchor_hhmmss("KRX", "20260609", "153000") is None


def test_previous_empty_page_anchor_jumps_known_nxt_pause() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "153000") == "151900"
    assert previous_empty_page_anchor_hhmmss("UN", "20260609", "090000") == "085900"


def test_previous_empty_page_anchor_stops_on_unknown_gap() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "183000") is None


def test_previous_empty_page_anchor_stops_at_venue_open() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "080000") is None

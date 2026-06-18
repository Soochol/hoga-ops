"""Tests for hoga.live.kis_venue."""

import pytest

from hoga.live.kis_venue import (
    AUTO_DAILY_USES_INTEGRATED_WARNING,
    auto_minute_venue_for_hhmmss,
    daily_venue_for_policy,
    kis_venue_div,
    merge_auto_minute_bars,
    parse_kis_venue,
    previous_empty_page_anchor_hhmmss,
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


def test_auto_minute_venue_for_hhmmss() -> None:
    assert auto_minute_venue_for_hhmmss("075959") == "NXT"
    assert auto_minute_venue_for_hhmmss("080000") == "NXT"
    assert auto_minute_venue_for_hhmmss("085959") == "NXT"
    assert auto_minute_venue_for_hhmmss("090000") == "KRX"
    assert auto_minute_venue_for_hhmmss("152000") == "KRX"
    assert auto_minute_venue_for_hhmmss("153000") == "KRX"
    assert auto_minute_venue_for_hhmmss("153001") == "NXT"
    assert auto_minute_venue_for_hhmmss("200000") == "NXT"


def test_daily_venue_for_policy_uses_integrated_for_auto() -> None:
    assert daily_venue_for_policy("KRX") == "KRX"
    assert daily_venue_for_policy("NXT") == "NXT"
    assert daily_venue_for_policy("UN") == "UN"
    assert daily_venue_for_policy("AUTO") == "UN"
    assert AUTO_DAILY_USES_INTEGRATED_WARNING["reason"] == "auto_daily_uses_integrated"


def test_merge_auto_minute_bars_applies_policy_by_timestamp() -> None:
    krx = [
        {"t_ms": 900, "close": "krx-regular"},
        {"t_ms": 1531, "close": "krx-after"},
    ]
    nxt = [
        {"t_ms": 800, "close": "nxt-before"},
        {"t_ms": 900, "close": "nxt-regular"},
        {"t_ms": 1531, "close": "nxt-after"},
    ]
    hhmmss = {800: "080000", 900: "090000", 1531: "153100"}

    merged = merge_auto_minute_bars(krx, nxt, hhmmss_for_t_ms=hhmmss.__getitem__)

    assert [row["close"] for row in merged] == ["nxt-before", "krx-regular", "nxt-after"]


def test_previous_empty_page_anchor_stops_for_krx() -> None:
    assert previous_empty_page_anchor_hhmmss("KRX", "20260609", "153000") is None


def test_previous_empty_page_anchor_jumps_known_nxt_pause() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "153000") == "151900"
    assert previous_empty_page_anchor_hhmmss("UN", "20260609", "090000") == "085900"


def test_previous_empty_page_anchor_stops_on_unknown_gap() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "183000") is None


def test_previous_empty_page_anchor_stops_at_venue_open() -> None:
    assert previous_empty_page_anchor_hhmmss("NXT", "20260609", "080000") is None

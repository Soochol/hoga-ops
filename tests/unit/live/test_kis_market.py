"""Tests for hoga.live.kis_market."""

import pytest

from hoga.live.kis_market import kis_market_div, parse_kis_market, session_window_hhmmss


def test_parse_kis_market_accepts_supported_values() -> None:
    assert parse_kis_market("KRX") == "KRX"
    assert parse_kis_market("NXT") == "NXT"
    assert parse_kis_market("UN") == "UN"


def test_parse_kis_market_rejects_auto_at_kis_client_boundary() -> None:
    with pytest.raises(ValueError, match="market must be one of KRX, NXT, UN"):
        parse_kis_market("AUTO")


def test_kis_market_div_maps_to_kis_codes() -> None:
    assert kis_market_div("KRX") == "J"
    assert kis_market_div("NXT") == "NX"
    assert kis_market_div("UN") == "UN"


def test_session_window_hhmmss_by_market() -> None:
    assert session_window_hhmmss("KRX") == ("090000", "153000")
    assert session_window_hhmmss("NXT") == ("080000", "200000")
    assert session_window_hhmmss("UN") == ("080000", "200000")

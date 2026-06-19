"""KIS market routing for /live candle backfill.

The UI exposes four policies, but the KIS client only accepts concrete KIS
markets. AUTO is expanded at the route layer before calling KisClient.
"""
from __future__ import annotations

from typing import Literal, cast

KisMarket = Literal["KRX", "NXT", "UN"]
LiveMarketPolicy = Literal["KRX", "NXT", "UN", "AUTO"]

_KIS_DIV: dict[KisMarket, str] = {
    "KRX": "J",
    "NXT": "NX",
    "UN": "UN",
}

_SESSION_WINDOWS: dict[KisMarket, tuple[str, str]] = {
    "KRX": ("090000", "153000"),
    "NXT": ("080000", "200000"),
    "UN": ("080000", "200000"),
}


def parse_kis_market(value: str) -> KisMarket:
    if value in _KIS_DIV:
        return cast(KisMarket, value)
    raise ValueError("market must be one of KRX, NXT, UN")


def parse_live_market_policy(value: str | None) -> LiveMarketPolicy:
    if value is None or value == "":
        return "KRX"
    if value in ("KRX", "NXT", "UN", "AUTO"):
        return cast(LiveMarketPolicy, value)
    raise ValueError("market must be one of KRX, NXT, UN, AUTO")


def kis_market_div(market: KisMarket) -> str:
    return _KIS_DIV[parse_kis_market(market)]


def session_window_hhmmss(market: KisMarket) -> tuple[str, str]:
    return _SESSION_WINDOWS[parse_kis_market(market)]

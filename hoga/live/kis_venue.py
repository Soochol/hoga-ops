"""KIS venue routing for /live candle backfill."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal, cast

KIS_KST = timezone(timedelta(hours=9))

KisVenue = Literal["KRX", "NXT", "UN"]
LiveVenuePolicy = Literal["KRX", "NXT", "UN"]

_KIS_DIV: dict[KisVenue, str] = {
    "KRX": "J",
    "NXT": "NX",
    "UN": "UN",
}

_SESSION_WINDOWS: dict[KisVenue, tuple[str, str]] = {
    "KRX": ("090000", "153000"),
    "NXT": ("080000", "200000"),
    "UN": ("080000", "200000"),
}

_EMPTY_PAGE_PREVIOUS_ANCHORS: dict[str, str] = {
    # KIS NXT/UN minute queries can return no rows at KRX auction-pause anchors.
    # Jump below the known empty band instead of probing one minute at a time.
    "153000": "151900",
    "090000": "085900",
}


def parse_kis_venue(value: str) -> KisVenue:
    if value in _KIS_DIV:
        return cast(KisVenue, value)
    raise ValueError("venue must be one of KRX, NXT, UN")


def parse_live_venue_policy(value: str | None) -> LiveVenuePolicy:
    if value is None or value == "":
        return "KRX"
    if value == "AUTO":
        return "UN"
    if value in ("KRX", "NXT", "UN"):
        return cast(LiveVenuePolicy, value)
    raise ValueError("venue must be one of KRX, NXT, UN")


def kis_venue_div(venue: KisVenue) -> str:
    return _KIS_DIV[parse_kis_venue(venue)]


def session_window_hhmmss(venue: KisVenue) -> tuple[str, str]:
    return _SESSION_WINDOWS[parse_kis_venue(venue)]


def daily_venue_for_policy(policy: LiveVenuePolicy) -> KisVenue:
    """Return the concrete KIS Venue for daily candles."""
    return parse_kis_venue(policy)


def quote_venue_for_policy(policy: LiveVenuePolicy, _now: datetime) -> KisVenue:
    """Return the concrete KIS Venue for live quote overlay requests."""
    return parse_kis_venue(policy)


def previous_empty_page_anchor_hhmmss(
    venue: KisVenue,
    _date_yyyymmdd: str,
    hhmmss: str,
) -> str | None:
    """Return the next anchor to try after an empty KIS minute page.

    KRX stops on empty pages. NXT/UN may emit empty pages at KRX auction-pause
    boundaries, so those concrete venues can skip to the previous meaningful
    anchor while still honoring the venue's opening bound.
    """
    venue = parse_kis_venue(venue)
    if venue == "KRX":
        return None

    session_open_hhmmss, _ = session_window_hhmmss(venue)
    if hhmmss <= session_open_hhmmss:
        return None

    next_anchor = _EMPTY_PAGE_PREVIOUS_ANCHORS.get(hhmmss)
    if next_anchor is None:
        return None
    if next_anchor < session_open_hhmmss:
        return None
    return next_anchor

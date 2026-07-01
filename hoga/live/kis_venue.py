"""KIS venue routing for /live candle backfill.

The UI exposes four policies, but the KIS client only accepts concrete KIS
venues. AUTO is expanded at the route layer before calling KisClient.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable, Literal, cast

KIS_KST = timezone(timedelta(hours=9))

KisVenue = Literal["KRX", "NXT", "UN"]
LiveVenuePolicy = Literal["KRX", "NXT", "UN", "AUTO"]

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
    if value in ("KRX", "NXT", "UN", "AUTO"):
        return cast(LiveVenuePolicy, value)
    raise ValueError("venue must be one of KRX, NXT, UN, AUTO")


def kis_venue_div(venue: KisVenue) -> str:
    return _KIS_DIV[parse_kis_venue(venue)]


def session_window_hhmmss(venue: KisVenue) -> tuple[str, str]:
    return _SESSION_WINDOWS[parse_kis_venue(venue)]


def auto_minute_venue_for_hhmmss(hhmmss: str) -> KisVenue:
    if "090000" <= hhmmss <= "153000":
        return "KRX"
    return "NXT"


def daily_venue_for_policy(policy: LiveVenuePolicy) -> KisVenue:
    """Return the concrete KIS Venue for daily candles.

    AUTO is minute-only: one daily candle cannot preserve an intraday KRX/NXT
    split, so daily AUTO falls back to KIS integrated bars.
    """
    if policy == "AUTO":
        return "UN"
    return policy


def quote_venue_for_policy(policy: LiveVenuePolicy, now: datetime) -> KisVenue:
    """Return the concrete KIS Venue for live quote overlay requests."""
    if policy != "AUTO":
        return policy
    return auto_minute_venue_for_hhmmss(now.astimezone(KIS_KST).strftime("%H%M%S"))


AUTO_DAILY_USES_INTEGRATED_WARNING = {
    "reason": "auto_daily_uses_integrated",
    "msg": "AUTO daily candles use KIS integrated venue because daily bars cannot be split by intraday KRX/NXT time windows",
}


def merge_auto_minute_bars(
    krx: list[dict],
    nxt: list[dict],
    *,
    hhmmss_for_t_ms: Callable[[int], str],
) -> list[dict]:
    """Merge AUTO minute bars according to Venue Routing Policy.

    KRX owns the Regular Session. NXT owns eligible extended minutes outside
    that window. UN is deliberately not involved: integrated mode is a single
    KIS `UN` call, while AUTO is the only policy that fans out.
    """
    by_t: dict[int, dict] = {}
    for row in nxt:
        t_ms = row.get("t_ms")
        if isinstance(t_ms, int) and auto_minute_venue_for_hhmmss(hhmmss_for_t_ms(t_ms)) == "NXT":
            by_t[t_ms] = row
    for row in krx:
        t_ms = row.get("t_ms")
        if isinstance(t_ms, int) and auto_minute_venue_for_hhmmss(hhmmss_for_t_ms(t_ms)) == "KRX":
            by_t[t_ms] = row
    return [by_t[t_ms] for t_ms in sorted(by_t)]


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

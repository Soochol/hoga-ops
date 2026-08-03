"""거래소(venue) 도메인 — 브로커 중립.

`Venue`는 **거래소**이지 벤더 개념이 아니다. KRX/NXT/UN(통합)은 시장이 가진
성질이고, 어느 브로커로 조회하든 같다 — 키움도 같은 venue 를 다룬다(ADR-0118
관심종목 시간대 venue 스왑, ADR-0096 UN 하이브리드).

벤더가 소유하는 것은 **wire 인코딩뿐**이다: KIS 는 `FID_COND_MRKT_DIV_CODE` 에
`J`/`NX`/`UN` 을 싣고(`kis_venue.kis_venue_div`), 키움은 종목코드 접미(`_NX`/`_AL`)
로 표현한다. 그 매핑은 각 벤더 모듈에 남고, 여기에는 오지 않는다.

2026-08-03까지 `kis_venue.KisVenue` 였다(#1018, 지도 #1005). `KIS_KST` 도 같은
파일에 있었으나 이사가 아니라 **소멸**했다 — 정본은 `hoga.util.timeenc.KST`
하나이고 벤더별로 다른 값이 아니라서, 소비자를 정본으로 직결하면 심볼이 사라진다.

I/O 없음.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, cast

Venue = Literal["KRX", "NXT", "UN"]
LiveVenuePolicy = Literal["KRX", "NXT", "UN"]

_SESSION_WINDOWS: dict[Venue, tuple[str, str]] = {
    "KRX": ("090000", "153000"),
    "NXT": ("080000", "200000"),
    "UN": ("080000", "200000"),
}


def parse_venue(value: str) -> Venue:
    if value in _SESSION_WINDOWS:
        return cast(Venue, value)
    raise ValueError("venue must be one of KRX, NXT, UN")


def parse_live_venue_policy(value: str | None) -> LiveVenuePolicy:
    if value is None or value == "":
        return "KRX"
    if value == "AUTO":
        return "UN"
    if value in ("KRX", "NXT", "UN"):
        return cast(LiveVenuePolicy, value)
    raise ValueError("venue must be one of KRX, NXT, UN")


def session_window_hhmmss(venue: Venue) -> tuple[str, str]:
    return _SESSION_WINDOWS[parse_venue(venue)]


def daily_venue_for_policy(policy: LiveVenuePolicy) -> Venue:
    """Return the concrete Venue for daily candles."""
    return parse_venue(policy)


def quote_venue_for_policy(policy: LiveVenuePolicy, _now: datetime) -> Venue:
    """Return the concrete Venue for live quote overlay requests."""
    return parse_venue(policy)

"""KIS 고유의 venue wire 인코딩.

거래소 개념 자체(`Venue`·정책·세션창)는 브로커 중립이라 `hoga.live.venue` 로
이사했다(#1018, 지도 #1005). 여기 남은 것은 **KIS 가 소유하는 매핑뿐**이다 —
`FID_COND_MRKT_DIV_CODE` 값과, KIS 분봉이 KRX 동시호가 경계에서 빈 페이지를
내보낼 때의 앵커 점프표.

KIS 스택이 삭제되면 이 파일도 함께 사라진다(지도 #1005 A 분류).
"""
from __future__ import annotations

from hoga.live.venue import Venue, parse_venue, session_window_hhmmss

_KIS_DIV: dict[Venue, str] = {
    "KRX": "J",
    "NXT": "NX",
    "UN": "UN",
}

_EMPTY_PAGE_PREVIOUS_ANCHORS: dict[str, str] = {
    # KIS NXT/UN minute queries can return no rows at KRX auction-pause anchors.
    # Jump below the known empty band instead of probing one minute at a time.
    "153000": "151900",
    "090000": "085900",
}


def kis_venue_div(venue: Venue) -> str:
    return _KIS_DIV[parse_venue(venue)]


def previous_empty_page_anchor_hhmmss(
    venue: Venue,
    _date_yyyymmdd: str,
    hhmmss: str,
) -> str | None:
    """Return the next anchor to try after an empty KIS minute page.

    KRX stops on empty pages. NXT/UN may emit empty pages at KRX auction-pause
    boundaries, so those concrete venues can skip to the previous meaningful
    anchor while still honoring the venue's opening bound.

    **프로덕션 호출자 0** — 2026-08-03 #1010 전수조사에서 확인했다. `kis_endpoints`
    는 고정 앵커 목록(`_minute_page_anchors`)을 쓴다. KIS 스택 삭제와 함께 사라질
    코드라 이번 이사(#1018)에서는 건드리지 않는다.
    """
    venue = parse_venue(venue)
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

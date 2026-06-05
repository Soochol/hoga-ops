"""KRX 세션 게이트 — poller에서 이주(은퇴 대비, 그릴링 Q2).

market_phase: 시계 기반 위상. should_run_now: 캘린더 게이트 포함(ADR-0064).
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from .kis_client import KIS_KST


def market_phase(t_ms: int) -> Literal["regular", "after_hours_closing", "closed"]:
    """KRX session phase by clock alone (no calendar awareness).

    regular: 09:00-15:30 KST
    after_hours_closing: 15:30-16:00 KST
    closed: everything else

    Calendar-aware gating (holidays, weekends) lives in :func:`should_run_now`
    so the phase predicate stays pure and reusable from non-poller contexts.
    """
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    h, m = kst.hour, kst.minute
    if h == 15 and m >= 30:  # noqa: PLR2004
        return "after_hours_closing"
    if 9 <= h < 16:  # noqa: PLR2004
        return "regular"
    return "closed"


def should_run_now(t_ms: int) -> bool:
    """Calendar + clock gate: True only when KRX is *probably* trading right now.

    ADR-0064: the trading-day check uses :func:`calendar.is_trading_session_today`
    (backed by the KRX business-day *calendar*), NOT :func:`calendar.is_trading_day`
    (backed by daily OHLCV). The OHLCV proxy returns False for a live trading day
    early in the session — today's bar isn't published yet — and once that False
    was cached the poller silently halted capture for the whole process. The
    business-day calendar marks today as a session from the open.

    Weekends are short-circuited by the clock/weekday before any KRX call, so a
    weekend stays closed even when KRX is unreachable (a None verdict is treated
    leniently below and would otherwise poll).

    Lenient on missing calendar data — when ``is_trading_session_today`` returns
    None (KRX creds missing, pykrx flaked), defer to the clock alone. Losing live
    capture for a transient KRX outage is a worse failure than the noise from a
    brief burst of empty fetches on a stale day.
    """
    if market_phase(t_ms) == "closed":
        return False
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    if kst.weekday() >= 5:  # Saturday/Sunday — never a KRX session  # noqa: PLR2004
        return False
    from hoga.api.calendar import is_trading_session_today  # noqa: PLC0415
    verdict = is_trading_session_today(kst.strftime("%Y%m%d"))
    return verdict is not False


def ws_capture_window(now_ms: int) -> bool:
    """WS 수집 게이트(advisor B 결정 2026-06-05): 거래일 && 정규장(09:00–15:30)만.

    poller 시절의 장후 시간외(15:30–16:00, overtime TR) 캡처는 **의도적 회귀** —
    가격 고정 구간이라 정보가치 낮고 hogaplay 일배치가 post-hoc per-tick 보완
    (spec §11). 정규 TR만 구독하므로 15:30 이후엔 틱이 없어, 게이트를 열어두면
    다운샘플러 carry가 유령 스냅샷만 쓴다 — 그래서 15:30에 닫는다.
    """
    return should_run_now(now_ms) and market_phase(now_ms) == "regular"

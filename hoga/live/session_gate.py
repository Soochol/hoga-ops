"""KRX 세션 게이트 — poller에서 이주(은퇴 대비, 그릴링 Q2).

market_phase: 시계 기반 위상. should_run_now: 캘린더 게이트 포함(ADR-0064).
"""
from __future__ import annotations

import asyncio
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
    (backed by the KIS chk-holiday calendar, which lists today from the session
    open), NOT a daily-OHLCV proxy. The old proxy returned False for a live trading day
    early in the session — today's bar isn't published yet — and once that False
    was cached the poller silently halted capture for the whole process. The
    business-day calendar marks today as a session from the open.

    Weekends are short-circuited by the clock/weekday before any KIS call, so a
    weekend stays closed even when KIS is unreachable (a None verdict is treated
    leniently below and would otherwise poll).

    Lenient on missing calendar data — when ``is_trading_session_today`` returns
    None (KRX creds missing, chk-holiday flaked), defer to the clock alone. Losing live
    capture for a transient KRX outage is a worse failure than the noise from a
    brief burst of empty fetches on a stale day.
    """
    if market_phase(t_ms) == "closed":
        return False
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    if kst.weekday() >= 5:  # Saturday/Sunday — never a KRX session  # noqa: PLR2004
        return False
    from hoga.api.calendar_policy import live_session_allowed_today  # noqa: PLC0415
    return live_session_allowed_today(kst.strftime("%Y%m%d"))


def ws_capture_window(now_ms: int) -> bool:
    """WS 수집 게이트(advisor B 결정 2026-06-05): 거래일 && 정규장(09:00–15:30)만.

    poller 시절의 장후 시간외(15:30–16:00, overtime TR) 캡처는 **의도적 회귀** —
    가격 고정 구간이라 정보가치 낮고 hogaplay 일배치가 post-hoc per-tick 보완
    (spec §11). 정규 TR만 구독하므로 15:30 이후엔 틱이 없어, 게이트를 열어두면
    다운샘플러 carry가 유령 스냅샷만 쓴다 — 그래서 15:30에 닫는다.

    ⚠ BLOCKING: should_run_now → is_trading_session_today(캘린더/chk-holiday)가 캐시
    미스 시 동기 KIS HTTP를 칠 수 있다. **이벤트 루프에서 직접 호출 금지** — 코루틴은
    ``ws_capture_window_async``를 await하라. 유일한 합법적 sync 사용처는 소비자가 스스로
    to_thread로 감싸는 gate_fn 클로저(KisWsClient가 ``await to_thread(gate_fn)`` 처리).
    """
    return should_run_now(now_ms) and market_phase(now_ms) == "regular"


async def ws_capture_window_async(now_ms: int) -> bool:
    """ws_capture_window의 non-blocking 진입점 — to_thread를 한 곳에 봉인한다.

    blocking 계약을 시그니처(async)에 박아 미래 호출자가 캘린더 I/O로 이벤트 루프를
    동결시키지 못하게 한다(systems-over-heroes). 코루틴 호출부는 모두 이걸 await.
    """
    return await asyncio.to_thread(ws_capture_window, now_ms)


# ── #524 통합 venue 시분할: 연결 게이트(저장 게이트와 분리) ─────────────────────

# 연결 창 = 거래일 && 08:00–20:00 KST. NXT 확장 세션(장전 08:00·장후 ~20:00)을
# 포함해 시분할 스왑이 KRX↔NXT 구독을 유지할 수 있게 한다. **저장(캡처)은
# ws_capture_window(정규장)가 별도 게이트** — 연결 창 확대가 저장 창을 넓히지 않는다.
_CONN_OPEN_MIN = 8 * 60         # 08:00 KST
_CONN_CLOSE_MIN = 20 * 60       # 20:00 KST


def _within_connection_clock(t_ms: int) -> bool:
    kst = datetime.fromtimestamp(t_ms / 1000, tz=KIS_KST)
    return _CONN_OPEN_MIN <= (kst.hour * 60 + kst.minute) < _CONN_CLOSE_MIN


def ws_connection_window(now_ms: int) -> bool:
    """WS **연결** 게이트: 거래일 && 08:00–20:00 KST. ws_capture_window(저장,
    정규장)와 분리 — NXT 시분할 시간대에도 연결을 유지/재수립한다.

    should_run_now(캘린더)는 market_phase=='closed'(정규장 밖)면 False라 08~09·15:30~20을
    못 담으므로 여기서 별도로 거래일(주말/휴장 배제)만 검사하고 시계는 08~20으로 연다.

    ⚠ BLOCKING: ws_capture_window와 동일하게 캘린더 캐시 미스 시 동기 KIS HTTP 가능 —
    이벤트 루프에서 직접 호출 금지, 코루틴은 ``ws_connection_window_async``를 await.
    """
    if not _within_connection_clock(now_ms):
        return False
    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    if kst.weekday() >= 5:  # 주말 — 즉시 차단(KIS 호출 전)  # noqa: PLR2004
        return False
    from hoga.api.calendar_policy import live_session_allowed_today  # noqa: PLC0415
    return live_session_allowed_today(kst.strftime("%Y%m%d"))


async def ws_connection_window_async(now_ms: int) -> bool:
    """ws_connection_window의 non-blocking 진입점 — to_thread 봉인(blocking 계약)."""
    return await asyncio.to_thread(ws_connection_window, now_ms)


# 시분할 구독 venue 경계 — 저장 게이트(정규장 09:00–15:30)를 KRX가 완전히 덮도록
# 개장 전 워밍(08:50)과 마감 후 drain 마진(15:31)을 둔다. 이 창 밖(연결 창 내)은 NXT.
#   08:00 ─ 08:50 : NXT     (장전 NXT 세션)
#   08:50 ─ 15:31 : KRX     (정규장 캡처를 워밍~drain 마진으로 완전 포함)
#   15:31 ─ 20:00 : NXT     (장후 NXT 세션)
# 저장은 여전히 ws_capture_window(정규장)만 — KRX 구독이 08:50/15:31로 넓어도
# _gate_open(정규장)이 저장을 09:00–15:30로 고정하므로 캡처 데이터는 불변.
_KRX_WARMUP_MIN = 8 * 60 + 50   # 08:50 — 개장(09:00) 전 KRX 구독 준비
_KRX_DRAIN_MARGIN_MIN = 15 * 60 + 31  # 15:31 — 마감(15:30) drain flush 보존 후 스왑


def target_ws_venue(now_ms: int) -> str:
    """이 시각에 구독해야 할 venue("KRX"/"NXT"). 순수 시계 — 거래일 여부는
    연결 게이트가 이미 강제하므로 여기선 시각만 본다(정규장 캡처 경계와 동일한
    pure-clock 기준, market_phase와 일관)."""
    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    minutes = kst.hour * 60 + kst.minute
    return "KRX" if _KRX_WARMUP_MIN <= minutes < _KRX_DRAIN_MARGIN_MIN else "NXT"

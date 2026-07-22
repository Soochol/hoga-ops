"""Unit tests for hoga.live.session_gate.ws_capture_window."""
from datetime import datetime

import pytest

from hoga.api import calendar as cal
from hoga.live.kis_client import KIS_KST
from hoga.live.session_gate import (
    in_krx_warmup_window,
    is_auction_window,
    target_ws_venue,
    ws_capture_window,
    ws_capture_window_async,
    ws_connection_window,
)


def _ms(year: int, month: int, day: int, hour: int, minute: int) -> int:
    return int(datetime(year, month, day, hour, minute, 0, tzinfo=KIS_KST).timestamp() * 1000)


def test_regular_hours_trading_day_returns_true(monkeypatch):
    """10:00 KST on a trading weekday → True."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 10, 0)  # Tuesday
    assert ws_capture_window(t) is True


def test_after_hours_closing_returns_false(monkeypatch):
    """15:45 KST — after_hours_closing phase → False even on a trading day."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 15, 45)  # Tuesday
    assert ws_capture_window(t) is False


def test_holiday_at_regular_hours_returns_false(monkeypatch):
    """should_run_now returns False (calendar says holiday) at 10:00 → False."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    t = _ms(2026, 5, 27, 10, 0)  # Tuesday but stubbed as holiday
    assert ws_capture_window(t) is False


@pytest.mark.asyncio
async def test_async_wrapper_matches_sync(monkeypatch):
    """ws_capture_window_async(non-blocking 진입점, to_thread 봉인)는 sync와 동일 결과 —
    blocking 계약을 시그니처에 박되 동작은 보존(C4 계약 명시화)."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 10, 0)  # Tuesday 10:00
    assert await ws_capture_window_async(t) is True
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    assert await ws_capture_window_async(t) is False


# ── #524 연결 창(08~20) vs 저장 창(정규장) 분리 + 시분할 venue 경계 ─────────────


def test_connection_window_covers_nxt_hours_on_trading_day(monkeypatch):
    """연결 창은 거래일 08:00~20:00 — 저장 창(정규장) 밖의 NXT 시간대도 True."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    assert ws_connection_window(_ms(2026, 5, 27, 8, 30)) is True   # 장전 NXT
    assert ws_connection_window(_ms(2026, 5, 27, 10, 0)) is True   # 정규장
    assert ws_connection_window(_ms(2026, 5, 27, 18, 0)) is True   # 장후 NXT
    # 창 밖(07:59, 20:00) → False
    assert ws_connection_window(_ms(2026, 5, 27, 7, 59)) is False
    assert ws_connection_window(_ms(2026, 5, 27, 20, 0)) is False


def test_connection_window_false_on_weekend_and_holiday(monkeypatch):
    """주말은 KIS 호출 전 즉시 차단; 평일이라도 휴장이면 False."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    assert ws_connection_window(_ms(2026, 5, 30, 10, 0)) is False  # 토요일
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    assert ws_connection_window(_ms(2026, 5, 27, 10, 0)) is False  # 평일 휴장


def test_connection_window_strictly_wider_than_capture_window(monkeypatch):
    """캡처 창(정규장)이 True인 시각은 연결 창도 반드시 True(연결 ⊇ 저장)."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    for h, m in [(9, 0), (12, 0), (15, 29)]:
        t = _ms(2026, 5, 27, h, m)
        if ws_capture_window(t):
            assert ws_connection_window(t) is True


def test_target_venue_krx_only_around_regular_session_with_margins():
    """구독 venue: 정규장을 워밍(08:50)~drain 마진(15:31)으로 완전 포함해 KRX,
    그 밖(연결 창 내 NXT 시간대)은 NXT."""
    assert target_ws_venue(_ms(2026, 5, 27, 8, 30)) == "NXT"   # 장전 NXT
    assert target_ws_venue(_ms(2026, 5, 27, 8, 50)) == "KRX"   # 워밍 시작
    assert target_ws_venue(_ms(2026, 5, 27, 9, 0)) == "KRX"    # 개장(캡처 시작 시 KRX 준비 완료)
    assert target_ws_venue(_ms(2026, 5, 27, 15, 30)) == "KRX"  # 마감 순간까지 KRX(drain 보존)
    assert target_ws_venue(_ms(2026, 5, 27, 15, 31)) == "NXT"  # drain 마진 후 NXT 스왑
    assert target_ws_venue(_ms(2026, 5, 27, 18, 0)) == "NXT"   # 장후 NXT


def test_is_auction_window_covers_open_and_close_single_price():
    """동시호가 창: 장전 08:30–09:00, 장마감 15:20–15:30 KST. 순수 시계.
    경계: 시작 포함, 끝 배제. 연속거래 시각·시간외는 False(예상체결 게이트 방어선)."""
    # 장전 동시호가
    assert is_auction_window(_ms(2026, 5, 27, 8, 29)) is False  # 창 직전
    assert is_auction_window(_ms(2026, 5, 27, 8, 30)) is True   # 시작(포함)
    assert is_auction_window(_ms(2026, 5, 27, 8, 55)) is True
    assert is_auction_window(_ms(2026, 5, 27, 9, 0)) is False   # 개장(배제) — 연속거래 시작
    # 연속거래 중
    assert is_auction_window(_ms(2026, 5, 27, 12, 0)) is False
    # 장마감 동시호가
    assert is_auction_window(_ms(2026, 5, 27, 15, 19)) is False  # 창 직전
    assert is_auction_window(_ms(2026, 5, 27, 15, 20)) is True   # 시작(포함)
    assert is_auction_window(_ms(2026, 5, 27, 15, 25)) is True
    assert is_auction_window(_ms(2026, 5, 27, 15, 30)) is False  # 마감(배제)
    # 시간외
    assert is_auction_window(_ms(2026, 5, 27, 16, 30)) is False


def test_krx_warmup_window_is_0850_to_0900():
    """08:50–09:00 KRX 워밍 창(ADR-0118 §5 저장셋 등록 완결 술어). 순수 시계 —
    경계: 08:50 포함, 09:00 배제(개장). target_ws_venue의 KRX 시작과 정렬."""
    assert in_krx_warmup_window(_ms(2026, 5, 27, 8, 49)) is False  # 워밍 직전(NXT)
    assert in_krx_warmup_window(_ms(2026, 5, 27, 8, 50)) is True   # 워밍 시작(경계 포함)
    assert in_krx_warmup_window(_ms(2026, 5, 27, 8, 59)) is True   # 워밍 중
    assert in_krx_warmup_window(_ms(2026, 5, 27, 9, 0)) is False   # 개장 — 창 종료
    assert in_krx_warmup_window(_ms(2026, 5, 27, 10, 0)) is False  # 정규장 중

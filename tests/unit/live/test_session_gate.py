"""Unit tests for hoga.live.session_gate.ws_capture_window."""
from datetime import datetime

import pytest

from hoga.api import calendar as cal
from hoga.live.session_gate import (
    deriv_capture_window,
    investor_flow_capture_window,
    investor_flow_capture_window_async,
    is_auction_window,
    ws_capture_window,
    ws_capture_window_async,
    ws_connection_window,
)
from hoga.util.timeenc import KST


def _ms(year: int, month: int, day: int, hour: int, minute: int) -> int:
    return int(datetime(year, month, day, hour, minute, 0, tzinfo=KST).timestamp() * 1000)


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


def test_is_auction_window_krx_covers_open_and_close_single_price():
    """KRX 동시호가 창: 장전 08:30–09:00, 장마감 15:20–15:30 KST. 순수 시계.
    경계: 시작 포함, 끝 배제. 연속거래·NXT 단일가 시각은 False(예상체결 게이트)."""
    # 장전 동시호가
    assert is_auction_window(_ms(2026, 5, 27, 8, 29), "KRX") is False  # 창 직전
    assert is_auction_window(_ms(2026, 5, 27, 8, 30), "KRX") is True   # 시작(포함)
    assert is_auction_window(_ms(2026, 5, 27, 8, 55), "KRX") is True
    assert is_auction_window(_ms(2026, 5, 27, 9, 0), "KRX") is False   # 개장(배제) — 연속거래 시작
    # 연속거래 중
    assert is_auction_window(_ms(2026, 5, 27, 12, 0), "KRX") is False
    # 장마감 동시호가
    assert is_auction_window(_ms(2026, 5, 27, 15, 19), "KRX") is False  # 창 직전
    assert is_auction_window(_ms(2026, 5, 27, 15, 20), "KRX") is True   # 시작(포함)
    assert is_auction_window(_ms(2026, 5, 27, 15, 25), "KRX") is True
    assert is_auction_window(_ms(2026, 5, 27, 15, 30), "KRX") is False  # 마감(배제)
    # NXT 단일가 창은 KRX 창이 아니다 — 그 시각 KRX 는 이미 닫혔다
    assert is_auction_window(_ms(2026, 5, 27, 15, 35), "KRX") is False
    # NXT 애프터마켓 접속매매 시간대
    assert is_auction_window(_ms(2026, 5, 27, 16, 30), "KRX") is False


def test_is_auction_window_nxt_covers_after_market_opening_call_only():
    """NXT 단일가는 애프터마켓 시가 15:30–15:40 **하나뿐**이다.

    프리마켓(08:00–08:50)·애프터마켓(15:40–20:00)은 접속매매고, KRX 단일가 동안
    (08:50–09:00:30 · 15:20–15:30)은 NXT 가 거래정지다 — 증권사 안내 4곳 일치
    (2026-08-07 확인). 그 밖의 시각을 열면 NXT 가 접속매매 중에 흘리는 예상체결값이
    화면에 샌다(2026-07-22 실측).
    """
    assert is_auction_window(_ms(2026, 5, 27, 15, 29), "NXT") is False  # 창 직전(거래정지)
    assert is_auction_window(_ms(2026, 5, 27, 15, 30), "NXT") is True   # 시작(포함)
    assert is_auction_window(_ms(2026, 5, 27, 15, 39), "NXT") is True
    assert is_auction_window(_ms(2026, 5, 27, 15, 40), "NXT") is False  # 체결 시점(배제) — 접속매매 시작
    # KRX 단일가 창은 NXT 창이 아니다 — 그 시각 NXT 는 거래정지다
    assert is_auction_window(_ms(2026, 5, 27, 8, 55), "NXT") is False
    assert is_auction_window(_ms(2026, 5, 27, 15, 25), "NXT") is False
    # NXT 프리마켓·애프터마켓 접속매매
    assert is_auction_window(_ms(2026, 5, 27, 8, 10), "NXT") is False
    assert is_auction_window(_ms(2026, 5, 27, 16, 30), "NXT") is False


def test_is_auction_window_un_covers_both_markets_windows():
    """통합(`_AL`)은 병합 스트림이라 KRX·NXT 두 시장의 단일가 창을 모두 갖는다."""
    assert is_auction_window(_ms(2026, 5, 27, 8, 55), "UN") is True    # KRX 시가
    assert is_auction_window(_ms(2026, 5, 27, 15, 25), "UN") is True   # KRX 종가
    assert is_auction_window(_ms(2026, 5, 27, 15, 35), "UN") is True   # NXT 애프터 시가
    assert is_auction_window(_ms(2026, 5, 27, 12, 0), "UN") is False   # 연속거래
    assert is_auction_window(_ms(2026, 5, 27, 16, 30), "UN") is False  # 애프터 접속매매


def test_is_auction_window_unknown_venue_is_closed():
    """모르는 venue 는 닫힘 — 단일가 시각을 모르는 시장에 창을 열면 값이 샌다."""
    assert is_auction_window(_ms(2026, 5, 27, 8, 55), "KOSDAQ_ATS") is False
    assert is_auction_window(_ms(2026, 5, 27, 15, 35), "") is False


# ── 투자자 수급(ka10051) 수집 창: 정규장보다 늦게 닫는다 ──────────────────────


def test_investor_flow_window_stays_open_through_closing_auction(monkeypatch):
    """**이 창이 막는 것**: 종가 단일가 체결분(15:30 일괄)이 시계열에서 빠지는 것.

    정규장(15:30)에서 닫으면 그 체결이 붙기 전에 게이트가 내려간다. 증상이 "수집이
    멈췄다" 로 보이지 않는 것이 이 버그의 성질이다 — 15:20 이후 접속매매가 없어 값이
    동결되므로 `rows_equal` 이 폴을 전부 스킵하고, 파일의 마지막 쓰기가 매일 15:22 로
    찍힌다(2026-08-11 실측, 네 거래일 모두).

    **이 창이 못 보는 것**: 벤더가 실제로 언제 갱신하는가. 창은 "물어볼 자격" 만
    정하고, 값이 안 변하면 dedup 이 버린다 — 그래서 창을 넓히는 쪽은 안전하다.
    """
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    # 정규장 안 — 기존 창과 겹치는 구간
    assert investor_flow_capture_window(_ms(2026, 5, 27, 9, 0)) is True
    assert investor_flow_capture_window(_ms(2026, 5, 27, 15, 29)) is True
    # **여기가 새로 열린 구간이다.** `ws_capture_window` 는 이 셋에서 전부 False 다.
    assert investor_flow_capture_window(_ms(2026, 5, 27, 15, 35)) is True
    assert investor_flow_capture_window(_ms(2026, 5, 27, 16, 1)) is True
    assert investor_flow_capture_window(_ms(2026, 5, 27, 16, 29)) is True
    # 끝은 배제 — 16:30 부터는 17:00 확정 배치의 몫이다.
    assert investor_flow_capture_window(_ms(2026, 5, 27, 16, 30)) is False


def test_investor_flow_window_opens_before_regular_session(monkeypatch):
    """**이 창이 막는 것**: 장전 세션 체결이 09:00 한 점에 뭉쳐 경로를 잃는 것.

    09:00 은 검토된 값이 아니라 "주식 정규장 시작" 이라는 기본값이었다. 재보니 벤더는
    장전에도 답한다(2026-08-12 실측, 코스피): 08:17 에 외국인 -616 · 기관 +149 로
    시작해 08:47 에 -1280 · +519 까지 움직이고, NXT 프리마켓이 끝나는 08:50 이후
    동결됐다.

    **09:00 에 리셋되지 않는다** — 수집기가 09:00:25 에 찍은 그날 첫 표본이 이미
    -1260 · +475 로 장전 누적을 승계하고 있었다. 그러니 이 창이 새로 담는 것은 값이
    아니라 **해상도**다.

    **이 창이 못 보는 것**: 08:00 정각에 이미 값이 있는가. 첫 실측이 08:17 이라 그
    앞은 안 재봤다. 창을 열어 두면 값이 없는 구간은 dedup 이 버리므로 안전한 방향이다.

    **파생은 따라 열지 않는다** — `deriv_capture_window` 는 09:00 그대로다. 같은 날
    08:23 에 KOSPI200 선물이 `session:"closed"` · `volume:0` 이었다(장전 세션 없음).
    """
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    # **여기가 새로 열린 구간이다.** `ws_capture_window` 는 이 둘에서 False 다.
    assert investor_flow_capture_window(_ms(2026, 5, 27, 8, 0)) is True
    assert investor_flow_capture_window(_ms(2026, 5, 27, 8, 59)) is True
    # 시작도 끝과 같이 경계는 배제한다 — 07:59 는 닫혀 있다.
    assert investor_flow_capture_window(_ms(2026, 5, 27, 7, 59)) is False
    # 파생 창은 이 확장을 따라오지 않는다 — 담을 값이 없다.
    assert deriv_capture_window(_ms(2026, 5, 27, 8, 30)) is False


def test_investor_flow_window_is_strictly_wider_than_regular_session(monkeypatch):
    """정규장이 열린 시각은 이 창도 반드시 열린다(투자자 수급 창 ⊇ 저장 창).

    확장이 **덧붙이기**임을 고정한다 — 창을 옮기면서 장중 구간을 잃으면 소급 백필이
    불가능한 표본을 영구히 버리게 된다(#1105).
    """
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    for h, m in [(9, 0), (10, 30), (12, 0), (15, 19), (15, 29)]:
        t = _ms(2026, 5, 27, h, m)
        if ws_capture_window(t):
            assert investor_flow_capture_window(t) is True


def test_investor_flow_window_false_on_weekend_and_holiday(monkeypatch):
    """거래일 판정은 SSOT 에 위임한다 — 확장된 꼬리가 휴장일을 열어 주면 안 된다.

    비거래일에 표본을 찍으면 그날이 "수집했는데 아무 일도 없던 날" 로 남아, 커버리지가
    말하는 결손과 구별되지 않는다.
    """
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    assert investor_flow_capture_window(_ms(2026, 5, 30, 16, 0)) is False  # 토요일
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    assert investor_flow_capture_window(_ms(2026, 5, 27, 16, 0)) is False  # 평일 휴장


@pytest.mark.asyncio
async def test_investor_flow_window_async_matches_sync(monkeypatch):
    """async 진입점은 sync 와 같은 답 — blocking 계약만 시그니처에 박는다."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 16, 0)
    assert await investor_flow_capture_window_async(t) is True
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    assert await investor_flow_capture_window_async(t) is False

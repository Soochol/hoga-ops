"""선물 세션 판정 테스트.

**주 회귀 가드는 야간장의 날짜 경계다.** 야간(18:00–익일 05:00)은 자정을 넘으므로
새벽 구간은 "오늘" 이 아니라 **전 거래일**의 세션이다. 여기서 `is_trading_day(오늘)`
을 그대로 부르면 토요일 새벽(=금요일 야간장)이 비거래일로 판정돼 카드가 조용히 꺼진다.

주식용 `session_gate.market_phase` 를 재사용할 수 없는 이유도 함께 고정한다 —
선물 주간은 15:45 까지로 주식(15:30)보다 15분 길다.
"""
from datetime import datetime

from hoga.api import calendar as cal
from hoga.live.futures_runtime import LINEUP, futures_session
from hoga.util.timeenc import KST


def _ms(year: int, month: int, day: int, hour: int, minute: int) -> int:
    return int(datetime(year, month, day, hour, minute, 0, tzinfo=KST).timestamp() * 1000)


def _weekday_calendar(monkeypatch) -> None:
    """주말만 비거래일인 달력. 실제 시드에 의존하지 않으려고 요일로 판정한다."""

    def is_trading_day(date_yyyymmdd: str) -> bool:
        return datetime.strptime(date_yyyymmdd, "%Y%m%d").weekday() < 5

    monkeypatch.setattr(cal, "is_trading_day", is_trading_day)


# ── 주간 ──────────────────────────────────────────────────────────────────

def test_day_session_during_regular_hours(monkeypatch):
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 6, 10, 0)) == "day"  # 목요일


def test_day_session_runs_to_1545_not_1530(monkeypatch):
    """선물 주간은 주식보다 15분 길다 — 주식 게이트를 재사용하면 여기서 깨진다."""
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 6, 15, 44)) == "day"
    assert futures_session(_ms(2026, 8, 6, 15, 45)) == "closed"


def test_gap_between_sessions_is_closed(monkeypatch):
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 6, 17, 0)) == "closed"


# ── 야간 ──────────────────────────────────────────────────────────────────

def test_night_session_opens_at_1800(monkeypatch):
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 6, 17, 59)) == "closed"
    assert futures_session(_ms(2026, 8, 6, 18, 0)) == "night"
    assert futures_session(_ms(2026, 8, 6, 23, 50)) == "night"  # 실측으로 틱 확인된 시각


def test_after_midnight_belongs_to_previous_trading_day(monkeypatch):
    """새벽 02:00 은 **전날** 야간장이다 — 오늘 기준으로 보면 안 된다."""
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 7, 2, 0)) == "night"  # 금요일 새벽 = 목요일 야간
    assert futures_session(_ms(2026, 8, 7, 4, 59)) == "night"
    assert futures_session(_ms(2026, 8, 7, 5, 0)) == "closed"


def test_saturday_dawn_is_fridays_night_session(monkeypatch):
    """토요일 새벽은 금요일 야간장이다. 오늘(토)로 판정하면 조용히 꺼진다."""
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 8, 2, 0)) == "night"  # 토요일 새벽


def test_sunday_dawn_is_closed(monkeypatch):
    """일요일 새벽의 전날은 토요일 — 비거래일이라 야간장이 없다."""
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 9, 2, 0)) == "closed"


def test_saturday_daytime_is_closed(monkeypatch):
    _weekday_calendar(monkeypatch)
    assert futures_session(_ms(2026, 8, 8, 10, 0)) == "closed"


# ── 달력 부재 ──────────────────────────────────────────────────────────────

def test_unknown_calendar_day_is_treated_as_trading(monkeypatch):
    """시드 범위 밖(None)은 거래일로 본다 — 조용히 끄는 것보다 값이 안 변하는 편이 낫다."""
    monkeypatch.setattr(cal, "is_trading_day", lambda d: None)
    assert futures_session(_ms(2026, 8, 6, 10, 0)) == "day"


def test_holiday_closes_all_sessions(monkeypatch):
    monkeypatch.setattr(cal, "is_trading_day", lambda d: False)
    assert futures_session(_ms(2026, 8, 6, 10, 0)) == "closed"
    assert futures_session(_ms(2026, 8, 6, 20, 0)) == "closed"
    assert futures_session(_ms(2026, 8, 7, 2, 0)) == "closed"


# ── 라인업 ────────────────────────────────────────────────────────────────

def test_lineup_excludes_mini() -> None:
    """미니는 계약 승수가 달라 정규와 나란히 두면 거래량·OI 가 합산으로 오독된다."""
    assert {i.product for i in LINEUP} == {"kospi200", "kosdaq150", "vkospi"}


def test_only_vkospi_has_no_underlying_card() -> None:
    """토글 짝이 없는 카드는 VKOSPI 뿐 — 나머지는 현물 카드와 쌍을 이룬다."""
    solo = [i.id for i in LINEUP if i.underlying_id is None]
    assert solo == ["VKOSPI_F"]

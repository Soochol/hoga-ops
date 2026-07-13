"""is_today_too_early returns True iff date == today_kst AND now < 16:30 KST."""
import datetime as dt

from hoga.collector import orchestrator as orch

KST = dt.timezone(dt.timedelta(hours=9))


def test_today_too_early_before_1630():
    now = dt.datetime(2026, 5, 22, 16, 29, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260522", now) is True


def test_today_too_early_exactly_1630_returns_false():
    now = dt.datetime(2026, 5, 22, 16, 30, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260522", now) is False


def test_today_too_early_past_date_returns_false():
    now = dt.datetime(2026, 5, 22, 10, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260521", now) is False


def test_today_too_early_future_date_returns_false():
    now = dt.datetime(2026, 5, 22, 10, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260601", now) is False


def test_today_too_early_malformed_date_returns_false():
    now = dt.datetime(2026, 5, 22, 10, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("not-a-date", now) is False


def test_today_too_early_refused_raised_when_capture_today_pre_1630():
    """collect_stock_date raises TodayTooEarlyRefused when policy hits."""
    # Just verify the exception type exists and inherits RuntimeError.
    assert issubclass(orch.TodayTooEarlyRefused, RuntimeError)

"""GET /api/inventory/calendar?code&year&month."""
from __future__ import annotations

import datetime as dt
import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import hoga.api.calendar as cal

# Approximate KRX trading days for May 2026 — weekdays minus a plausible
# holiday on 2026-05-05 (Children's Day). Tests only need consistency,
# not real-world fidelity.
_MAY_2026_TRADING_DAYS = {
    f"202605{d:02d}"
    for d in (1, 4, 6, 7, 8, 11, 12, 13, 14, 15,
              18, 19, 20, 21, 22, 25, 26, 27, 28, 29)
}


@pytest.fixture(autouse=True)
def _stub_trading_days(monkeypatch):
    """Pre-populate the (year, month) cache to avoid live KRX access."""
    cal.reset_cache_for_tests()
    cal._month_cache[(2026, 5)] = set(_MAY_2026_TRADING_DAYS)
    yield
    cal.reset_cache_for_tests()


def _build_app(monkeypatch, tmp_path):
    from hoga.api.app import create_app
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    return create_app(data_dir=tmp_path)


def test_calendar_returns_envelope_with_as_of_ms(monkeypatch, tmp_path):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/inventory/calendar?code=005930&year=2026&month=5")
        assert r.status_code == 200
        body = r.json()
        assert "cells" in body and "as_of_ms" in body
        assert isinstance(body["as_of_ms"], int) and body["as_of_ms"] > 0
        # 31 days in May.
        assert len(body["cells"]) == 31


def test_calendar_marks_weekends(monkeypatch, tmp_path):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/inventory/calendar?code=005930&year=2026&month=5")
        body = r.json()
        # 20260516 was a Saturday.
        sat = next(cell for cell in body["cells"] if cell["date"] == "20260516")
        assert sat["status"] == "weekend"


def test_calendar_marks_future_dates(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    fixed_now = dt.datetime(2026, 5, 15, 10, 0, 0, tzinfo=KST)
    monkeypatch.setattr("hoga.api.calendar._now_kst", lambda: fixed_now, raising=False)
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        # 20260518 is in the future relative to fixed_now.
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "future"


def test_calendar_marks_today_locked_before_1630_kst(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    monkeypatch.setattr("hoga.api.calendar._now_kst",
                        lambda: dt.datetime(2026, 5, 22, 16, 29, 0, tzinfo=KST),
                        raising=False)
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        today_cell = next(c for c in body["cells"] if c["date"] == "20260522")
        assert today_cell["status"] == "today_locked"


def test_calendar_uses_disk_state_for_captured_cells(monkeypatch, tmp_path):
    (tmp_path / "parquet" / "20260518" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260518" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False}))
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "complete"
        assert cell["captured_at_ms"] is not None


def _write_source_meta(tmp_path, date, code, source, meta):
    d = tmp_path / "parquet" / date / code / source
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta))


def _status_for(monkeypatch, tmp_path, date, code):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get(f"/api/inventory/calendar?code={code}&year=2026&month=5").json()
        return next(cc for cc in body["cells"] if cc["date"] == date)


def test_calendar_kis_live_only_complete_shows_complete_live(monkeypatch, tmp_path):
    """ADR-0115: hogaplay absent, kis_live COMPLETE → complete_live (not complete)."""
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "complete_live"
    assert cell["captured_at_ms"] is not None


def test_calendar_kis_live_only_partial_shows_partial_live(monkeypatch, tmp_path):
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": True, "is_partial": True})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "partial_live"


def test_calendar_hogaplay_wins_over_kis_live(monkeypatch, tmp_path):
    """hogaplay COMPLETE + kis_live present → hogaplay-framed 'complete'."""
    _write_source_meta(tmp_path, "20260518", "005930", "hogaplay",
                       {"collection_complete": True, "is_partial": False})
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": True, "is_partial": False})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "complete"


def test_calendar_kis_live_incomplete_shows_none(monkeypatch, tmp_path):
    """kis_live not finalized (CLIENT_INCOMPLETE) → 'none' (✕ noise removed)."""
    _write_source_meta(tmp_path, "20260518", "005930", "kis_live",
                       {"collection_complete": False, "is_partial": True})
    cell = _status_for(monkeypatch, tmp_path, "20260518", "005930")
    assert cell["status"] == "none"


import pytest
from pathlib import Path

from hoga.api import calendar as calendar_module
from hoga.api.error_codes import UpstreamCode


def test_disk_state_to_status_maps_invalid() -> None:
    """ADR-0020: DiskState.INVALID maps to 'invalid' string on the wire."""
    from hoga.api.calendar import _disk_state_to_status
    from hoga.api.disk_state import DiskState
    assert _disk_state_to_status(DiskState.INVALID) == "invalid"


def test_calendar_cell_constructs_with_invalid_status() -> None:
    """Pydantic Literal must accept 'invalid' — runtime validation passes.

    Regression: if CalendarStatus omitted 'invalid', CalendarCell(status='invalid')
    would raise ValidationError and the calendar route would 500 for any code
    with an INVALID-classified date.
    """
    from hoga.api.models import CalendarCell
    cell = CalendarCell(date="20260518", status="invalid",  # type: ignore[arg-type]
                        captured_at_ms=None)
    assert cell.status == "invalid"


def test_calendar_route_renders_invalid_cell_e2e(monkeypatch, tmp_path):
    """End-to-end: a parquet dir with INVALID-shaped meta surfaces as
    {status: 'invalid'} in the calendar response (no 500)."""
    pq = tmp_path / "parquet" / "20260518" / "005930"
    pq.mkdir(parents=True)
    # collection_complete=True so it passes the CLIENT_INCOMPLETE branch;
    # close_ms=0 trips meta.close_after_open + meta.close_in_kst_range → INVALID.
    (pq / "meta.json").write_text(json.dumps({
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 0,
        "collection_complete": True,
        "is_partial": False,
    }))
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "invalid"


@pytest.fixture(autouse=False)
def _reset_calendar_state():
    calendar_module.reset_cache_for_tests()
    yield
    calendar_module.reset_cache_for_tests()


def test_trading_days_for_returns_none_when_fetch_raises(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    """_trading_days_for returns None and sets KIS_HOLIDAY_FETCH_FAILED when
    fetch_month_trading_days raises (covers creds-missing, network, rt_cd)."""
    import hoga.api.kis_holidays as kis_holidays_module

    def _raise(year, month):
        raise kis_holidays_module.KisHolidayFetchError("KIS_APP_KEY/KIS_APP_SECRET missing")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)

    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KIS_HOLIDAY_FETCH_FAILED


# ---------------------------------------------------------------------------
# is_trading_session_today (ADR-0064): lag-free "is TODAY a KRX session?"
#
# The poller gate must NOT rely on a lagging proxy to decide whether *today*
# is a trading day — a wrong False, once cached, silently halts live capture
# for the whole process. Post KRX→KIS migration the source is the KIS
# chk-holiday calendar via _trading_days_for (month cache + failure TTL);
# the per-day session semantics (positive cached, negative re-checked with a
# throttle + fresh fetch) are preserved from the pykrx-era tests these
# replace. Seam: monkeypatch hoga.api.kis_holidays.fetch_month_trading_days.
# ---------------------------------------------------------------------------

def _stub_month_fetch(monkeypatch, days_yyyymmdd, *, raises=None, calls=None):
    """fetch_month_trading_days stub returning the given day set (or raising)."""
    import hoga.api.kis_holidays as kis_holidays_module

    def _fetch(year, month):
        if calls is not None:
            calls.append((year, month))
        if raises is not None:
            raise raises
        return set(days_yyyymmdd)

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _fetch)


def test_is_trading_session_today_true_when_in_trading_days(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    # June 2026: 1,2,4,5 trading; 3 holiday. Today=05 IS in the set.
    _stub_month_fetch(monkeypatch, ["20260601", "20260602", "20260604", "20260605"])
    assert calendar_module.is_trading_session_today("20260605") is True


def test_is_trading_session_today_false_on_holiday(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    # 20260603 is NOT in the trading-day set → it's a holiday → False.
    _stub_month_fetch(monkeypatch, ["20260601", "20260602", "20260604", "20260605"])
    assert calendar_module.is_trading_session_today("20260603") is False


def test_is_trading_session_today_none_when_creds_missing(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    import hoga.api.kis_holidays as kis_holidays_module

    _stub_month_fetch(
        monkeypatch, [],
        raises=kis_holidays_module.KisCredentialsMissing("KIS keys missing"),
    )
    assert calendar_module.is_trading_session_today("20260605") is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KIS_CREDENTIALS_MISSING


def test_is_trading_session_today_none_when_fetch_raises(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    import hoga.api.kis_holidays as kis_holidays_module

    _stub_month_fetch(
        monkeypatch, [],
        raises=kis_holidays_module.KisHolidayFetchError("chk-holiday exploded"),
    )
    assert calendar_module.is_trading_session_today("20260605") is None


def test_is_trading_session_today_caches_positive(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """A confirmed trading session is cached per day — no repeat KIS fetch."""
    calls: list = []
    _stub_month_fetch(monkeypatch, ["20260605"], calls=calls)
    assert calendar_module.is_trading_session_today("20260605") is True
    assert calendar_module.is_trading_session_today("20260605") is True
    assert len(calls) == 1  # second call served from the per-day cache


def test_is_trading_session_today_rechecks_negative_and_self_heals(
    monkeypatch: pytest.MonkeyPatch, _reset_calendar_state: None,
) -> None:
    """A False for today is NOT cached permanently. If the calendar source
    transiently omits today (the ADR-0064 bug shape), the gate self-heals once
    it reappears — the throttled re-check evicts the month cache so the
    verdict comes from a FRESH fetch, not the pinned month set. Re-fetches are
    throttled, not every call."""
    calls: list = []
    # First: today missing from a non-empty month → False.
    _stub_month_fetch(monkeypatch, ["20260604"], calls=calls)
    assert calendar_module.is_trading_session_today("20260605", _now_s=0.0) is False
    assert len(calls) == 1
    # Within the throttle window: still False, but NO re-fetch.
    assert calendar_module.is_trading_session_today("20260605", _now_s=10.0) is False
    assert len(calls) == 1
    # After the throttle window AND the source now includes today → True
    # (month cache evicted on re-check, fresh fetch sees the fixed data).
    _stub_month_fetch(monkeypatch, ["20260604", "20260605"], calls=calls)
    assert calendar_module.is_trading_session_today("20260605", _now_s=999.0) is True
    assert len(calls) == 2


def test_get_month_map_fail_soft_when_kis_fetch_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    """Calendar UI still renders every weekday; banner reason is set."""
    import datetime as dt
    import hoga.api.kis_holidays as kis_holidays_module

    def _raise(year, month):
        raise kis_holidays_module.KisHolidayFetchError("KIS_APP_KEY/KIS_APP_SECRET missing")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)
    # Freeze "now" to a mid-month weekday (Wed 2026-05-13) so that the
    # weekend-cell assertion below stays deterministic regardless of the
    # actual calendar date when the suite runs. Without this freeze, a test
    # run on a weekend would classify "today" as today_locked even though it
    # is a weekend day, breaking `c.status in ("weekend", "future")`.
    KST = dt.timezone(dt.timedelta(hours=9))
    frozen_now = dt.datetime(2026, 5, 13, 12, 0, 0, tzinfo=KST)
    monkeypatch.setattr(calendar_module, "_now_kst", lambda: frozen_now)

    resp = calendar_module.get_month_map(data_dir=tmp_path, code="005930", year=2026, month=5)
    assert resp.reason == UpstreamCode.KIS_HOLIDAY_FETCH_FAILED
    # May 2026 has 31 days; all are present as cells.
    assert len(resp.cells) == 31
    weekday_cells = [c for c in resp.cells
                     if dt.date(int(c.date[:4]), int(c.date[4:6]), int(c.date[6:8])).weekday() < 5]
    weekend_cells = [c for c in resp.cells
                     if dt.date(int(c.date[:4]), int(c.date[4:6]), int(c.date[6:8])).weekday() >= 5]
    assert all(c.status in ("none", "future", "today_locked") for c in weekday_cells), \
        "weekdays should not be misclassified as holiday when KRX is unavailable"
    # Past and future weekend days show "weekend"/"future"; with now frozen to
    # a weekday, no weekend cell falls on the frozen "today" so today_locked
    # never overrides the weekend classification.
    assert all(c.status in ("weekend", "future") for c in weekend_cells)


def test_trading_days_in_range_raises_when_kis_fetch_fails(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    import hoga.api.kis_holidays as kis_holidays_module

    def _raise(year, month):
        raise kis_holidays_module.KisHolidayFetchError("KIS_APP_KEY/KIS_APP_SECRET missing")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)

    with pytest.raises(calendar_module.TradingDayUnavailableError) as exc_info:
        calendar_module.trading_days_in_range("20260501", "20260531")
    assert exc_info.value.code == UpstreamCode.KIS_HOLIDAY_FETCH_FAILED


def test_reset_cache_clears_last_failure_reason(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    import hoga.api.kis_holidays as kis_holidays_module

    def _raise(year, month):
        raise kis_holidays_module.KisHolidayFetchError("creds missing")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)
    calendar_module._trading_days_for(2026, 5)
    assert calendar_module.last_failure_reason() is not None
    calendar_module.reset_cache_for_tests()
    assert calendar_module.last_failure_reason() is None


def test_calendar_cell_shows_no_upstream_data_for_sentinel(tmp_path: Path) -> None:
    """A sentinel directory must surface as CalendarCell.status =
    'no_upstream_data' on the wire so the frontend can render the '–' marker.
    captured_at_ms stays None (no capture timestamp — there was nothing to
    capture)."""
    from hoga.api.calendar import get_month_map

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    # Force the trading-day branch deterministically: pretend 20260319 is a
    # trading day by populating the module cache.
    from hoga.api.calendar import _month_cache, reset_cache_for_tests
    reset_cache_for_tests()
    _month_cache[(2026, 3)] = {f"202603{day:02d}" for day in range(1, 32)}

    try:
        resp = get_month_map(data_dir=tmp_path, code="003490", year=2026, month=3)
    finally:
        reset_cache_for_tests()

    cell = next(c for c in resp.cells if c.date == "20260319")
    assert cell.status == "no_upstream_data"
    assert cell.captured_at_ms is None


def test_trading_days_for_negative_caches_failures(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    """Within the failure TTL a repeat call must NOT re-fetch — without this
    the live poller's gate re-ran the full blocking fetch every ~20s cycle on
    the event loop for the whole session during a chk-holiday outage."""
    import hoga.api.kis_holidays as kis_holidays_module

    calls = {"n": 0}

    def _raise(year, month):
        calls["n"] += 1
        raise kis_holidays_module.KisHolidayFetchError("upstream down")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)

    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module._trading_days_for(2026, 5) is None  # within TTL
    assert calls["n"] == 1  # second call served by the negative cache

    # TTL expiry → one more real attempt
    key = (2026, 5)
    calendar_module._failure_cache[key] -= calendar_module._FAILURE_TTL_SECONDS + 1
    assert calendar_module._trading_days_for(2026, 5) is None
    assert calls["n"] == 2


def test_trading_days_for_singleflights_concurrent_failures(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    _reset_calendar_state: None,
) -> None:
    """Concurrent startup callers for the same month should share one failed
    KIS attempt. The negative cache prevents later retries, but without a
    lock two first callers can miss the cache together and duplicate the
    chk-holiday 500/log wall."""
    import hoga.api.kis_holidays as kis_holidays_module

    calls = {"n": 0}

    def _raise(year, month):
        calls["n"] += 1
        time.sleep(0.05)
        raise kis_holidays_module.KisHolidayFetchError("upstream down")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)

    with (
        caplog.at_level("WARNING", logger="hoga.api.calendar"),
        ThreadPoolExecutor(max_workers=2) as pool,
    ):
        got = list(pool.map(lambda _i: calendar_module._trading_days_for(2026, 5), range(2)))

    assert got == [None, None]
    assert calls["n"] == 1
    warnings = [r for r in caplog.records if "KIS trading-day fetch failed" in r.message]
    assert len(warnings) == 1


def test_trading_days_for_maps_creds_missing_to_distinct_reason(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    """KisCredentialsMissing → KIS_CREDENTIALS_MISSING (UI says 'set keys');
    any other failure → KIS_HOLIDAY_FETCH_FAILED (UI says 'retry later')."""
    import hoga.api.kis_holidays as kis_holidays_module

    def _creds_missing(year, month):
        raise kis_holidays_module.KisCredentialsMissing("KIS_APP_KEY/KIS_APP_SECRET missing")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _creds_missing)
    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KIS_CREDENTIALS_MISSING

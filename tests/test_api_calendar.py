"""GET /api/inventory/calendar?code&year&month."""
from __future__ import annotations

import datetime as dt
import json

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


def test_calendar_marks_today_locked_before_18_kst(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    monkeypatch.setattr("hoga.api.calendar._now_kst",
                        lambda: dt.datetime(2026, 5, 22, 17, 59, 0, tzinfo=KST),
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


import pytest
from pathlib import Path

from hoga.api import calendar as calendar_module
from hoga.api.error_codes import UpstreamCode


@pytest.fixture(autouse=False)
def _reset_calendar_state():
    calendar_module.reset_cache_for_tests()
    yield
    calendar_module.reset_cache_for_tests()


def test_trading_days_for_returns_none_when_creds_missing(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KRX_CREDENTIALS_MISSING


def test_trading_days_for_returns_none_when_pykrx_raises(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    monkeypatch.setenv("KRX_ID", "u")
    monkeypatch.setenv("KRX_PW", "p")

    # The function does `from pykrx import stock` — patch the import path.
    import sys
    class _FakeStock:
        @staticmethod
        def get_market_ohlcv(*args, **kwargs):
            raise RuntimeError("pykrx exploded")
    fake_pykrx = type(sys)("pykrx")
    fake_pykrx.stock = _FakeStock
    monkeypatch.setitem(sys.modules, "pykrx", fake_pykrx)

    assert calendar_module._trading_days_for(2026, 5) is None
    assert calendar_module.last_failure_reason() == UpstreamCode.KRX_FETCH_FAILED


def test_get_month_map_fail_soft_when_creds_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    """Calendar UI still renders every weekday; banner reason is set."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    resp = calendar_module.get_month_map(data_dir=tmp_path, code="005930", year=2026, month=5)
    assert resp.reason == UpstreamCode.KRX_CREDENTIALS_MISSING
    # May 2026 has 31 days; all are present as cells.
    assert len(resp.cells) == 31
    import datetime as dt
    weekday_cells = [c for c in resp.cells
                     if dt.date(int(c.date[:4]), int(c.date[4:6]), int(c.date[6:8])).weekday() < 5]
    weekend_cells = [c for c in resp.cells
                     if dt.date(int(c.date[:4]), int(c.date[4:6]), int(c.date[6:8])).weekday() >= 5]
    assert all(c.status in ("none", "future", "today_locked") for c in weekday_cells), \
        "weekdays should not be misclassified as holiday when KRX is unavailable"
    # Future weekend days show "future" (date > today check happens first in _cell_status_for).
    assert all(c.status in ("weekend", "future") for c in weekend_cells)


def test_trading_days_in_range_raises_when_creds_missing(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    with pytest.raises(calendar_module.KrxUnavailableError) as exc_info:
        calendar_module.trading_days_in_range("20260501", "20260531")
    assert exc_info.value.code == UpstreamCode.KRX_CREDENTIALS_MISSING


def test_reset_cache_clears_last_failure_reason(
    monkeypatch: pytest.MonkeyPatch,
    _reset_calendar_state: None,
) -> None:
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)
    calendar_module._trading_days_for(2026, 5)
    assert calendar_module.last_failure_reason() is not None
    calendar_module.reset_cache_for_tests()
    assert calendar_module.last_failure_reason() is None

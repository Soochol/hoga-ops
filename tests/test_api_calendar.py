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

"""Extended /api/stock-dates response per frontend spec §4.4.

Verifies the new fields added to the StockDate model: price_min/max,
captured_at (Unix ms of latest mtime in the Stock-Date dir), total_volume,
pages_collected, file_size_bytes, and today_open/high/low/close.

Per ADR 0003, all time fields are Unix ms — the existing fields
``regular_session_open_ms`` / ``regular_session_close_ms`` /
``data_window_first_ms`` / ``data_window_last_ms`` must be Unix ms, NOT
the HHMMSSmmm packed-decimal encoding stored on disk.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_stock_dates_extended_fields(app_client: TestClient) -> None:
    r = app_client.get("/api/stock-dates")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 1
    row = rows[0]

    # Existing fields
    assert row["code"] == "003490"
    assert row["date"] == "20260519"
    assert row["name"] == "대한항공"

    # ADR 0003: time fields exposed as Unix ms (not HHMMSSmmm).
    # 09:00 KST on any date >= 2023-11-14 is well past 1.7e12.
    assert row["regular_session_open_ms"] > 1_700_000_000_000
    assert row["regular_session_close_ms"] > row["regular_session_open_ms"]
    assert row["data_window_first_ms"] > 1_700_000_000_000
    assert row["data_window_last_ms"] >= row["data_window_first_ms"]

    # Frontend spec §4.4 — new fields are present.
    for field in (
        "price_min",
        "price_max",
        "captured_at",
        "total_volume",
        "pages_collected",
        "file_size_bytes",
        "today_open",
        "today_high",
        "today_low",
        "today_close",
    ):
        assert field in row, f"missing {field}"

    # Sanity ranges.
    assert row["price_min"] > 0
    assert row["price_max"] >= row["price_min"]
    assert row["captured_at"] > 1_700_000_000_000  # Unix ms
    assert row["total_volume"] >= 0
    assert row["pages_collected"] >= 1
    assert row["file_size_bytes"] > 0
    assert row["today_open"] > 0
    assert row["today_high"] > 0
    assert row["today_low"] > 0
    assert row["today_close"] > 0


def test_stock_date_full_capture_count_passes_through(tmp_path):
    """meta.json with full_capture_count=5 → StockDate.full_capture_count == 5."""
    import json
    from hoga.api.queries import QueryEngine
    code_dir = tmp_path / "parquet" / "20260519" / "005930"
    code_dir.mkdir(parents=True)
    meta = {
        "code": "005930", "name": "삼성전자",
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
        "pages_collected": 1, "total_unique_events": 0,
        "today_open": 70_000, "today_high": 71_000, "today_low": 69_000, "today_close": 70_500,
        "parser_version": "0", "collection_complete": True, "is_partial": False,
        "full_capture_count": 5,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    engine = QueryEngine(data_dir=tmp_path)
    rows = engine.list_stock_dates()
    assert len(rows) == 1
    assert rows[0].full_capture_count == 5


def test_stock_date_full_capture_count_null_for_legacy(tmp_path):
    """meta.json without the field → StockDate.full_capture_count is None."""
    import json
    from hoga.api.queries import QueryEngine
    code_dir = tmp_path / "parquet" / "20260519" / "005930"
    code_dir.mkdir(parents=True)
    meta = {
        "code": "005930", "name": "삼성전자",
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
        "pages_collected": 1, "total_unique_events": 0,
        "today_open": 70_000, "today_high": 71_000, "today_low": 69_000, "today_close": 70_500,
        "parser_version": "0", "collection_complete": True, "is_partial": False,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    engine = QueryEngine(data_dir=tmp_path)
    rows = engine.list_stock_dates()
    assert len(rows) == 1
    assert rows[0].full_capture_count is None


# ADR-0042: inventory rows are annotated with fail_streak + blocked.


def test_stock_dates_default_fail_streak_zero_and_blocked_false(app_client: TestClient) -> None:
    """An inventory row with no fail_streak entry returns fail_streak=0, blocked=False."""
    from hoga.api import captures
    captures._fail_streaks.clear()  # ensure baseline
    r = app_client.get("/api/stock-dates")
    assert r.status_code == 200
    rows = r.json()
    assert all(row["fail_streak"] == 0 for row in rows)
    assert all(row["blocked"] is False for row in rows)


def test_stock_dates_reflects_manifest_counter(app_client: TestClient) -> None:
    """A row whose (Code, Stock-Date) has a fail_streak in the manifest
    surfaces the live counter."""
    from hoga.api import captures
    captures._fail_streaks.clear()
    captures._fail_streaks["003490|20260519"] = 3
    try:
        r = app_client.get("/api/stock-dates")
        assert r.status_code == 200
        row = next(x for x in r.json() if x["code"] == "003490" and x["date"] == "20260519")
        assert row["fail_streak"] == 3
        assert row["blocked"] is False
    finally:
        captures._fail_streaks.clear()


def test_stock_dates_blocked_at_threshold(app_client: TestClient) -> None:
    """fail_streak == 5 → blocked=True."""
    from hoga.api import captures
    captures._fail_streaks.clear()
    captures._fail_streaks["003490|20260519"] = 5
    try:
        r = app_client.get("/api/stock-dates")
        assert r.status_code == 200
        row = next(x for x in r.json() if x["code"] == "003490" and x["date"] == "20260519")
        assert row["fail_streak"] == 5
        assert row["blocked"] is True
    finally:
        captures._fail_streaks.clear()

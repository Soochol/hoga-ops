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

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture
def app_client(tmp_path: Path) -> TestClient:
    """Set up data/parquet/20260519/003490 from the tiny_tsv fixture."""
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    app = create_app(data_dir=tmp_path / "data")
    return TestClient(app)


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

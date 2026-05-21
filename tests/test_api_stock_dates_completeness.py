"""GET /api/stock-dates surfaces collection_complete and is_partial per row."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.queries import QueryEngine


def _write_full_stock_date(tmp_path: Path, code: str, date: str, **completeness: object) -> None:
    """Create a parquet dir with the minimum files queries.list_stock_dates expects."""
    parquet_dir = tmp_path / "parquet" / date / code
    parquet_dir.mkdir(parents=True)

    import pyarrow as pa
    import pyarrow.parquet as pq
    pq.write_table(pa.table({"ts_ms": pa.array([], type=pa.int64())}), parquet_dir / "snapshots.parquet")
    pq.write_table(
        pa.table({"low": pa.array([], type=pa.int64()), "high": pa.array([], type=pa.int64()),
                  "vol_a": pa.array([], type=pa.int64()), "vol_b": pa.array([], type=pa.int64())}),
        parquet_dir / "candles.parquet",
    )

    meta = {
        "code": code,
        "name": "삼성전자",
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
        "prev_close": 50000,
        "upper_limit": 65000,
        "lower_limit": 35000,
        "today_open": 50500,
        "today_high": 51000,
        "today_low": 50000,
        "today_close": 50800,
        "pages_collected": 47,
        **completeness,
    }
    (parquet_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def test_stock_date_exposes_collection_complete_and_is_partial(tmp_path: Path) -> None:
    _write_full_stock_date(tmp_path, "005930", "20260520", collection_complete=True, is_partial=False)
    eng = QueryEngine(tmp_path)
    try:
        rows = eng.list_stock_dates()
    finally:
        eng.close()
    assert len(rows) == 1
    assert rows[0].collection_complete is True
    assert rows[0].is_partial is False


def test_stock_date_legacy_meta_defaults_to_safe_values(tmp_path: Path) -> None:
    """Legacy meta without the two fields → conservative defaults."""
    _write_full_stock_date(tmp_path, "005930", "20260520")  # neither field
    eng = QueryEngine(tmp_path)
    try:
        rows = eng.list_stock_dates()
    finally:
        eng.close()
    assert rows[0].collection_complete is False
    assert rows[0].is_partial is True

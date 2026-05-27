from __future__ import annotations

import json
import shutil
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture
def staged_raw(tmp_path: Path) -> Path:
    """Copy tiny_tsv fixture into a temp data/raw/{date}/{code}/ tree."""
    raw_dir = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw_dir.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw_dir / name)
    return tmp_path


def test_parser_writes_all_tables(staged_raw: Path) -> None:
    out_dir = parse_stock_date(
        code="003490",
        date="20260519",
        data_dir=staged_raw / "data",
    )
    expected = (
        "snapshots.parquet",
        "trades.parquet",
        "brokers.parquet",
        "candles.parquet",
        "meta.json",
    )
    for name in expected:
        assert (out_dir / name).exists(), f"missing {name}"


def test_parser_trades_table(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "trades.parquet")
    assert tbl.num_rows == 6  # noqa: PLR2004
    sides = tbl.column("side").to_pylist()
    assert sides == [0, 0, 1, 1, 1, -1]
    qtys = tbl.column("qty").to_pylist()
    assert qtys == [501, 7868, 3, 1, 3, 3]


def test_parser_snapshots_table(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "snapshots.parquet")
    assert tbl.num_rows == 2  # noqa: PLR2004
    assert tbl.column("ask_p1").to_pylist() == [25800, 25700]


def test_parser_brokers_table(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "brokers.parquet")
    assert tbl.num_rows == 10  # noqa: PLR2004
    assert set(tbl.column("side").to_pylist()) == {"buy", "sell"}


def test_parser_candles_table_sorted_ascending(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    tbl = pq.read_table(out_dir / "candles.parquet")
    assert tbl.num_rows == 2  # noqa: PLR2004
    ts = tbl.column("ts_ms").to_pylist()
    assert ts == sorted(ts), "candles must be sorted ascending"


def test_parser_meta_json(staged_raw: Path) -> None:
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["code"] == "003490"
    assert meta["name"] == "대한항공"
    assert meta["regular_session_open_ms"] == 90000000  # noqa: PLR2004
    assert meta["regular_session_close_ms"] == 153000000  # noqa: PLR2004
    assert "raw_info_tsv" in meta
    assert isinstance(meta["total_unique_events"], int)


def test_parser_dedups_global_seq(tmp_path: Path) -> None:
    raw_dir = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw_dir.mkdir(parents=True)
    shutil.copy(FIXTURE_DIR / "info.tsv", raw_dir / "info.tsv")
    page = (FIXTURE_DIR / "first_001.tsv").read_text(encoding="utf-8")
    (raw_dir / "first_001.tsv").write_text(page, encoding="utf-8")
    (raw_dir / "first_002.tsv").write_text(page, encoding="utf-8")
    shutil.copy(FIXTURE_DIR / "chart.tsv", raw_dir / "chart.tsv")

    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    trades_tbl = pq.read_table(out_dir / "trades.parquet")
    assert trades_tbl.num_rows == 6, "duplicates by global_seq must be removed"  # noqa: PLR2004


def test_parser_writes_full_capture_count_one_on_first_capture(staged_raw: Path) -> None:
    """First successful Full Capture writes full_capture_count=1."""
    out_dir = parse_stock_date(
        code="003490", date="20260519", data_dir=staged_raw / "data",
    )
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 1


def test_parser_increments_full_capture_count_on_recapture(staged_raw: Path) -> None:
    """Second successful Full Capture overwrites meta.json with prior + 1."""
    out_dir = parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    # First call → 1. Re-run the parser; same raw, same out dir → second meta write.
    parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 2


def test_parser_increments_full_capture_count_from_legacy_meta(staged_raw: Path) -> None:
    """Legacy meta.json without the field → after Retry, full_capture_count == 1."""
    out_dir = staged_raw / "data" / "parquet" / "20260519" / "003490"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(json.dumps({"legacy": True}), encoding="utf-8")
    parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 1


def test_parser_handles_corrupt_prior_meta(
    staged_raw: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Non-UTF-8 bytes in prior meta.json → warning, prior_count=0, new count=1.

    Guards against UnicodeDecodeError (a ValueError subclass) escaping the
    except clause. See finding from pre-landing adversarial review.
    """
    import logging
    out_dir = staged_raw / "data" / "parquet" / "20260519" / "003490"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_bytes(b"\x80invalid not utf-8")
    with caplog.at_level(logging.WARNING, logger="hoga.parser"):
        parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["full_capture_count"] == 1
    assert any("corrupt prior meta.json" in rec.message for rec in caplog.records)


def test_parser_rejects_bool_prior_full_capture_count(staged_raw: Path) -> None:
    """meta.json with `"full_capture_count": true` (a bool) → treated as legacy.

    bool is a subclass of int in Python, so `isinstance(True, int)` is True.
    The guard must explicitly exclude bool to avoid silent off-by-one drift.
    """
    out_dir = staged_raw / "data" / "parquet" / "20260519" / "003490"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(
        json.dumps({"full_capture_count": True}), encoding="utf-8"
    )
    parse_stock_date(code="003490", date="20260519", data_dir=staged_raw / "data")
    meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
    # Without the bool-reject guard, prior_count would absorb True (== 1)
    # and this would be 2 instead of 1.
    assert meta["full_capture_count"] == 1

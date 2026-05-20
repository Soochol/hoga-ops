"""Session bundle slice tests."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from hoga.api.bundle import build_candles_slice
from hoga.api.queries import QueryEngine
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture
def engine(tmp_path: Path) -> QueryEngine:
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    return QueryEngine(tmp_path / "data")


def test_session_candles_slice(engine: QueryEngine, tmp_path: Path) -> None:
    rows = build_candles_slice(
        engine.conn, code="003490", date="20260519", data_dir=tmp_path / "data"
    )
    assert len(rows) >= 1
    assert all(r.ts_ms > 1_700_000_000_000 for r in rows)
    # OHLCV plausibility
    assert all(r.high >= r.low for r in rows)


def test_session_quote_ratio_slice(engine: QueryEngine, tmp_path: Path) -> None:
    from hoga.api.bundle import build_quote_ratio_slice
    qr = build_quote_ratio_slice(
        engine.conn, code="003490", date="20260519",
        data_dir=tmp_path / "data", bucket_ms=1000,
    )
    assert qr.bucket_ms == 1000
    assert len(qr.points) >= 1
    # Last-snapshot-per-bucket semantics: timestamps strictly non-decreasing
    ts = [p.t for p in qr.points]
    assert ts == sorted(ts)
    # Both totals are non-negative
    assert all(p.bid_total >= 0 and p.ask_total >= 0 for p in qr.points)

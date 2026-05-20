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


def test_session_depth_intensity_bid_ask_split(engine: QueryEngine, tmp_path: Path) -> None:
    from hoga.api.bundle import build_depth_intensity_slice
    di = build_depth_intensity_slice(
        engine.conn, code="003490", date="20260519",
        data_dir=tmp_path / "data", depth_bucket_ms=5000,
    )
    # Two grids of equal length
    assert len(di.bid_grid) == len(di.ask_grid)
    # All cells non-negative
    for col in di.bid_grid + di.ask_grid:
        assert all(v >= 0 for v in col)
    # Cap respected: at most 2M cells per grid
    if di.bid_grid:
        assert len(di.bid_grid) * len(di.bid_grid[0]) <= 2_000_000


def test_depth_intensity_cap_widens_bucket(engine: QueryEngine, tmp_path: Path) -> None:
    """If raw 1-s bucket would exceed cap, bucket widens automatically.

    Contract: when default bucket would exceed ``max_cells``, the algorithm
    widens the time bucket. (It cannot reduce ``bin_count``, which is set by
    the price range, so the cap is only approximately honored when
    ``max_cells < bin_count``.)
    """
    from hoga.api.bundle import build_depth_intensity_slice
    di = build_depth_intensity_slice(
        engine.conn, code="003490", date="20260519",
        data_dir=tmp_path / "data", depth_bucket_ms=1000, max_cells=100,
    )
    # Bucket must have widened beyond the requested 1000 ms.
    assert di.bucket_ms > 1000

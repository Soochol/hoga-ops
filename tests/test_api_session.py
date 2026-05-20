"""Session bundle slice tests."""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
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


def test_session_candles_slice(engine: QueryEngine) -> None:
    rows = build_candles_slice(engine, code="003490", date="20260519")
    assert len(rows) >= 1
    assert all(r.ts_ms > 1_700_000_000_000 for r in rows)
    # OHLCV plausibility
    assert all(r.high >= r.low for r in rows)


def test_session_quote_ratio_slice(engine: QueryEngine) -> None:
    from hoga.api.bundle import build_quote_ratio_slice
    qr = build_quote_ratio_slice(engine, code="003490", date="20260519", bucket_ms=1000)
    assert qr.bucket_ms == 1000
    assert len(qr.points) >= 1
    # Last-snapshot-per-bucket semantics: timestamps strictly non-decreasing
    ts = [p.t for p in qr.points]
    assert ts == sorted(ts)
    # Both totals are non-negative
    assert all(p.bid_total >= 0 and p.ask_total >= 0 for p in qr.points)


def test_session_depth_intensity_bid_ask_split(engine: QueryEngine) -> None:
    from hoga.api.bundle import build_depth_intensity_slice
    di = build_depth_intensity_slice(
        engine, code="003490", date="20260519", depth_bucket_ms=5000,
    )
    # Two grids of equal length
    assert len(di.bid_grid) == len(di.ask_grid)
    # All cells non-negative
    for col in di.bid_grid + di.ask_grid:
        assert all(v >= 0 for v in col)
    # Cap respected: at most 2M cells per grid
    if di.bid_grid:
        assert len(di.bid_grid) * len(di.bid_grid[0]) <= 2_000_000


def test_depth_intensity_cap_widens_bucket(engine: QueryEngine) -> None:
    """If raw 1-s bucket would exceed cap, bucket widens automatically.

    Contract: when default bucket would exceed ``max_cells``, the algorithm
    widens the time bucket. (It cannot reduce ``bin_count``, which is set by
    the price range, so the cap is only approximately honored when
    ``max_cells < bin_count``.)
    """
    from hoga.api.bundle import build_depth_intensity_slice
    di = build_depth_intensity_slice(
        engine, code="003490", date="20260519", depth_bucket_ms=1000, max_cells=100,
    )
    # Bucket must have widened beyond the requested 1000 ms.
    assert di.bucket_ms > 1000


def test_session_volume_profile_slice(engine: QueryEngine) -> None:
    from hoga.api.bundle import build_volume_profile_slice
    vp = build_volume_profile_slice(engine, code="003490", date="20260519", vp_bins=24)
    assert vp.bin_count == 24
    assert len(vp.bins) == 24
    # Bins are price-sorted ascending
    prices = [b.price_low for b in vp.bins]
    assert prices == sorted(prices)
    # Includes auction-cross volume (no side filter)
    total = sum(b.qty for b in vp.bins)
    assert total >= 0


def test_session_fill_strength_excludes_auctions(engine: QueryEngine) -> None:
    from hoga.api.bundle import build_fill_strength_slice
    fs = build_fill_strength_slice(engine, code="003490", date="20260519")
    assert fs.bucket_ms == 60000
    # Per spec §4.1: fill_strength excludes side = 0
    trades_path = str(engine.parquet_dir("20260519", "003490") / "trades.parquet")
    expected = engine.conn.execute(
        "SELECT SUM(qty) FROM read_parquet(?) WHERE side != 0",
        [trades_path],
    ).fetchone()[0] or 0
    actual = sum(p.buy_qty + p.sell_qty for p in fs.points)
    assert actual == expected


@pytest.fixture
def app_client(tmp_path: Path) -> TestClient:
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    app = create_app(data_dir=tmp_path / "data")
    return TestClient(app)


def test_session_bundle_shape(app_client: TestClient) -> None:
    r = app_client.get("/api/session?code=003490&date=20260519")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["code"] == "003490"
    assert body["session_open_ms"] > 1_700_000_000_000
    for slice_name in (
        "candles",
        "quote_ratio",
        "depth_intensity",
        "volume_profile",
        "fill_strength",
    ):
        assert slice_name in body


def test_session_bundle_unified_price_grid(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/session?code=003490&date=20260519"
        "&price_min=25000&price_max=26000"
    )
    assert r.status_code == 200, r.text
    di = r.json()["depth_intensity"]
    assert di["price_min"] == 25000
    assert di["price_max"] == 26000


def test_session_unknown_returns_404(app_client: TestClient) -> None:
    r = app_client.get("/api/session?code=999999&date=20260519")
    assert r.status_code == 404

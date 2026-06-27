from __future__ import annotations

from pathlib import Path

import polars as pl
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.bundle import build_range_bundle, build_volume_distribution_slice
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.tables.trades import query_continuous_trade_volume_distribution


def _write_stock_date(root: Path) -> None:
    code_dir = root / "parquet" / "20260625" / "005930" / "hogaplay"
    code_dir.mkdir(parents=True)
    (code_dir / "meta.json").write_text(
        """
        {
          "code": "005930",
          "name": "삼성전자",
          "regular_session_open_ms": 90000000,
          "regular_session_close_ms": 153000000,
          "prev_close": 100,
          "upper_limit": 130,
          "lower_limit": 70,
          "today_open": 100,
          "today_high": 120,
          "today_low": 100,
          "today_close": 115,
          "pages_collected": 1,
          "total_unique_events": 1,
          "parser_version": "test"
        }
        """,
        encoding="utf-8",
    )
    pl.DataFrame(
        [
            {
                "ts_ms": 90_000_000,
                "open": 100,
                "high": 120,
                "low": 100,
                "close": 110,
                "vol_a": 0,
                "vol_b": 0,
            },
        ],
    ).write_parquet(code_dir / "candles.parquet")
    pl.DataFrame(
        [
            {
                "ts_ms": 90_000_000,
                "seq": 1,
                "price": 100,
                "change_pct": 0.0,
                "qty": 10,
                "side": 1,
                "cum_vol": 10,
                "cum_trades": 1,
                "low_so_far": 100,
                "high_so_far": 100,
                "net_pressure": 10,
            },
            {
                "ts_ms": 90_001_000,
                "seq": 2,
                "price": 110,
                "change_pct": 0.0,
                "qty": 20,
                "side": -1,
                "cum_vol": 30,
                "cum_trades": 2,
                "low_so_far": 100,
                "high_so_far": 110,
                "net_pressure": -10,
            },
            {
                "ts_ms": 90_001_000,
                "seq": 3,
                "price": 120,
                "change_pct": 0.0,
                "qty": 999,
                "side": 0,
                "cum_vol": 0,
                "cum_trades": 3,
                "low_so_far": 100,
                "high_so_far": 120,
                "net_pressure": 0,
            },
            {
                "ts_ms": 90_002_000,
                "seq": 4,
                "price": 120,
                "change_pct": 0.0,
                "qty": 30,
                "side": 1,
                "cum_vol": 60,
                "cum_trades": 4,
                "low_so_far": 100,
                "high_so_far": 120,
                "net_pressure": 20,
            },
        ],
    ).write_parquet(code_dir / "trades.parquet")


def _engine(tmp_path: Path) -> QueryEngine:
    _write_stock_date(tmp_path)
    return QueryEngine(tmp_path)


def _client(tmp_path: Path) -> TestClient:
    _write_stock_date(tmp_path)
    return TestClient(create_app(data_dir=tmp_path))


def _fold_sparse_qty(sparse_bins: list[tuple[int, int]], range_count: int) -> list[int]:
    qty_by_idx = [0 for _ in range(range_count)]
    for idx, qty in sparse_bins:
        if idx >= 0:
            qty_by_idx[min(idx, range_count - 1)] += qty
    return qty_by_idx


def test_cutoff_includes_exact_timestamp_and_excludes_later(tmp_path: Path) -> None:
    engine = _engine(tmp_path)
    cutoff_ms = hhmmssms_to_unix_ms("20260625", 90_001_000)

    profile = build_volume_distribution_slice(
        engine,
        code="005930",
        date="20260625",
        source="hogaplay",
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        range_count=5,
        cutoff_ms=cutoff_ms,
    )

    assert profile is not None
    assert sum(b.qty for b in profile.bins) == 30
    assert profile.last_trade_ms == cutoff_ms

    binning = query_continuous_trade_volume_distribution(
        engine.conn,
        path=tmp_path / "parquet" / "20260625" / "005930" / "hogaplay" / "trades.parquet",
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        upper_bound_ms=32_401_001,
    )
    assert _fold_sparse_qty(binning.bins, 2) == [10, 20]


def test_volume_distribution_without_cutoff_preserves_final_profile(tmp_path: Path) -> None:
    engine = _engine(tmp_path)

    profile = build_volume_distribution_slice(
        engine,
        code="005930",
        date="20260625",
        source="hogaplay",
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
        range_count=5,
    )

    assert profile is not None
    assert sum(b.qty for b in profile.bins) == 60

    binning = query_continuous_trade_volume_distribution(
        engine.conn,
        path=tmp_path / "parquet" / "20260625" / "005930" / "hogaplay" / "trades.parquet",
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )
    assert _fold_sparse_qty(binning.bins, 2) == [10, 50]


def test_full_range_bundle_ignores_cutoff_and_preserves_final_profile(
    tmp_path: Path,
) -> None:
    engine = _engine(tmp_path)
    cutoff_ms = hhmmssms_to_unix_ms("20260625", 90_001_000)

    bundle = build_range_bundle(
        engine,
        code="005930",
        from_date="20260625",
        to_date="20260625",
        bucket_ms=60_000,
        mode="full",
        source_pref="hogaplay",
        volume_distribution_bins=5,
        volume_distribution_cutoff_ms=cutoff_ms,
    )

    assert len(bundle.volume_distributions) == 1
    profile = bundle.volume_distributions[0]
    assert profile.last_trade_ms == hhmmssms_to_unix_ms("20260625", 90_002_000)
    assert sum(b.qty for b in profile.bins) == 60


def test_volume_distribution_cutoff_requires_single_stock_date(tmp_path: Path) -> None:
    client = _client(tmp_path)
    cutoff_ms = hhmmssms_to_unix_ms("20260625", 90_001_000)

    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260624",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "sidecar",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 5,
            "volume_distribution_cutoff_ms": cutoff_ms,
        },
    )

    assert resp.status_code == 400
    assert "single Stock-Date" in resp.text


def test_volume_distribution_cutoff_requires_sidecar_mode(tmp_path: Path) -> None:
    client = _client(tmp_path)
    cutoff_ms = hhmmssms_to_unix_ms("20260625", 90_001_000)

    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260625",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "full",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 5,
            "volume_distribution_cutoff_ms": cutoff_ms,
        },
    )

    assert resp.status_code == 400
    assert "mode=sidecar" in resp.text


def test_volume_distribution_cutoff_rejects_epoch_outside_stock_date(
    tmp_path: Path,
) -> None:
    client = _client(tmp_path)
    cutoff_ms = hhmmssms_to_unix_ms("20260624", 90_001_000)

    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260625",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "sidecar",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 5,
            "volume_distribution_cutoff_ms": cutoff_ms,
        },
    )

    assert resp.status_code == 400
    assert "not within Stock-Date" in resp.text


def test_volume_distribution_cutoff_sidecar_route_returns_cutoff_profile(
    tmp_path: Path,
) -> None:
    client = _client(tmp_path)
    cutoff_ms = hhmmssms_to_unix_ms("20260625", 90_001_000)

    resp = client.get(
        "/api/range",
        params={
            "code": "005930",
            "from": "20260625",
            "to": "20260625",
            "bucket_ms": 60_000,
            "mode": "sidecar",
            "source_pref": "hogaplay",
            "volume_distribution_bins": 5,
            "volume_distribution_cutoff_ms": cutoff_ms,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["candles"] == []
    assert len(body["volume_distributions"]) == 1
    profile = body["volume_distributions"][0]
    assert profile["last_trade_ms"] == cutoff_ms
    assert sum(bin_["qty"] for bin_ in profile["bins"]) == 30

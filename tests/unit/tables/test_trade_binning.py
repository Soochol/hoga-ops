from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Event
from unittest.mock import patch

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from hoga.tables import trade_binning as tb
from hoga.tables.trades import query_continuous_trade_volume_distribution, query_trade_volume_poc

SPEC = tb.BinningSpec(100, 120, 2, 32_400_000, 32_520_000)
ROWS = [
    (85_959_999, 100, 999, 1),
    (90_000_000, 100, 10, 1),
    (90_000_001, 110, 20, -1),
    (90_000_001, 120, 30, 1),
    (90_059_999, 100, 40, 1),
    (90_100_000, 110, 50, 1),
    (90_200_000, 110, 999, 1),
    (90_010_000, 100, 999, 0),
]


def write(path: Path, rows=ROWS) -> None:
    pq.write_table(
        pa.table({name: [row[i] for row in rows] for i, name in enumerate(["ts_ms", "price", "qty", "side"])}), path
    )


@pytest.fixture
def data(tmp_path):
    path = tmp_path / "trades.parquet"
    write(path)
    with duckdb.connect() as con:
        yield con, path


def test_shared_distribution_poc_preserves_top_edge_first_time_and_ties(data):
    con, path = data
    cache = tb.TradeBinningCache()
    kwargs = dict(
        path=path,
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=90_200_000,
        binning_cache=cache,
    )
    with patch.object(tb, "query_statistics", wraps=tb.query_statistics) as query:
        dist = query_continuous_trade_volume_distribution(con, **kwargs)
        poc = query_trade_volume_poc(con, **kwargs)
    assert query.call_count == 1
    assert dist.bins == [(0, 50), (1, 70), (2, 30)]
    assert dist.max_intra_ms == 32_460_000
    assert (poc.qty, poc.low_price, poc.high_price, poc.intra_ms) == (100, 110, 120, 32_400_001)
    write(path, [(90_000_005, 100, 20, 1), (90_000_001, 110, 20, 1)])
    poc = query_trade_volume_poc(con, **kwargs)
    assert poc.low_price == 100  # qty ties prefer lower bin, not earliest timestamp
    assert poc.intra_ms == 32_400_005


def test_exact_prefix_matches_direct_at_every_boundary_and_reuses_index(data):
    con, path = data
    cache = tb.TradeBinningCache()
    with patch.object(tb, "query_time_index", wraps=tb.query_time_index) as build:
        for cutoff in [
            0,
            32_400_000,
            32_400_001,
            32_400_002,
            32_459_999,
            32_460_000,
            32_460_001,
            32_520_000,
            86_400_000,
        ]:
            assert cache.read(con, path, SPEC, cutoff=cutoff) == tb.query_statistics(
                con, path, replace(SPEC, upper=min(SPEC.upper, cutoff))
            )
    assert build.call_count == 1
    assert 0 < cache.nbytes < 4096


def test_cache_keys_include_file_generation_price_grid_and_session_bounds(data):
    con, path = data
    cache = tb.TradeBinningCache()
    first = cache.read(con, path, SPEC, cutoff=SPEC.upper)
    for spec in [
        replace(SPEC, price_hi=110),
        replace(SPEC, bins=1),
        replace(SPEC, lower=32_400_001),
        replace(SPEC, upper=32_460_000),
    ]:
        assert cache.read(con, path, spec, cutoff=spec.upper) == tb.query_statistics(con, path, spec)
    write(path, [(90_000_000, 100, 123, 1)])
    assert cache.read(con, path, SPEC, cutoff=SPEC.upper) != first
    assert cache.read(con, path, SPEC, cutoff=SPEC.upper) == ((0, 123, 32_400_000, 32_400_000),)


def test_entry_and_byte_caps_evict_or_decline(data):
    con, path = data
    for cache in [tb.TradeBinningCache(max_entries=1), tb.TradeBinningCache(max_bytes=1)]:
        with patch.object(tb, "query_statistics", wraps=tb.query_statistics) as query:
            cache.read(con, path, SPEC)
            cache.read(con, path, replace(SPEC, bins=1))
            cache.read(con, path, SPEC)
        assert query.call_count == 3
        assert cache.nbytes <= cache.max_bytes


def test_oversized_or_overflowing_index_falls_back_exactly(data, monkeypatch):
    con, path = data
    for limit in [1, 500_000]:
        monkeypatch.setattr(tb, "MAX_INDEX_ROWS", limit)
        if limit > 1:
            write(path, [(90_000_000, 100, 2**62, 1), (90_000_001, 100, 2**62, 1)])
        cache = tb.TradeBinningCache()
        with patch.object(tb, "query_time_index", wraps=tb.query_time_index) as build:
            for cutoff in [32_400_001, 32_500_000]:
                assert cache.read(con, path, SPEC, cutoff=cutoff) == tb.query_statistics(
                    con, path, replace(SPEC, upper=cutoff)
                )
        assert build.call_count == 1  # negative result is bounded and reusable too


def test_same_key_singleflight_and_failed_load_can_retry(data):
    con, path = data
    expected = tb.query_statistics(con, path, SPEC)
    cache = tb.TradeBinningCache()
    entered, release = Event(), Event()

    def load(*args):
        entered.set()
        assert release.wait(5)
        return expected

    with patch.object(tb, "query_statistics", side_effect=load) as query, ThreadPoolExecutor(2) as pool:
        first = pool.submit(cache.read, con, path, SPEC)
        assert entered.wait(5)
        second = pool.submit(cache.read, con, path, SPEC)
        release.set()
        assert first.result() == second.result() == expected
        assert query.call_count == 1
    other = replace(SPEC, bins=1)
    with (
        patch.object(tb, "query_statistics", side_effect=RuntimeError("test failure")),
        pytest.raises(RuntimeError, match="test failure"),
    ):
        cache.read(con, path, other)
    assert cache.read(con, path, other) == tb.query_statistics(con, path, other)

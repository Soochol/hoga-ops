"""Cache + cursor-isolation tests for QueryEngine.list_stock_dates.

These exercise the QueryEngine directly (not via TestClient) so the
in-memory cache state and cursor() call counts can be observed.
"""
from __future__ import annotations

import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock
from hoga.api.queries import QueryEngine
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"

# 10 Stock-Dates is the floor mandated by the spec for the concurrency
# test — small fixtures don't make DuckDB calls overlap meaningfully.
_DATES = [
    "20260504", "20260505", "20260506", "20260507", "20260508",
    "20260511", "20260512", "20260513", "20260514", "20260515",
]


def _build_engine_with_stock_dates(tmp_path: Path, dates: list[str]) -> QueryEngine:
    """Parse the tiny_tsv fixture under each date so each becomes a Stock-Date.

    Code is fixed at 003490 (the code embedded in tiny_tsv). One code × N dates
    gives N Stock-Date dirs, enough to exercise the per-(date, code) loop.
    """
    data_dir = tmp_path / "data"
    for date in dates:
        raw = data_dir / "raw" / date / "003490"
        raw.mkdir(parents=True)
        for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
            shutil.copy(FIXTURE_DIR / name, raw / name)
        parse_stock_date(code="003490", date=date, data_dir=data_dir)
    return QueryEngine(data_dir)


def test_concurrent_calls_dont_crash(tmp_path: Path) -> None:
    """30 concurrent list_stock_dates calls must all return identically with no exception.

    Regression for the documented 2026-05-23 incident where shared
    DuckDB connection state crashed the server under modest load.
    """
    engine = _build_engine_with_stock_dates(tmp_path, _DATES)
    try:
        with ThreadPoolExecutor(max_workers=30) as pool:
            futures = [pool.submit(engine.list_stock_dates) for _ in range(30)]
            results = [f.result(timeout=30) for f in futures]
        baseline = results[0]
        assert len(baseline) == len(_DATES)
        for r in results:
            assert r == baseline
    finally:
        engine.close()


def test_cache_hit_skips_duckdb(tmp_path: Path) -> None:
    """Second list_stock_dates call with no FS changes must not touch DuckDB.

    Wraps engine._conn.cursor with a spy and asserts call_count is 0
    on the second invocation.
    """
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:3])
    try:
        # First call: cold — populates cache.
        first = engine.list_stock_dates()
        assert len(first) == 3

        # Spy on cursor() for the second call only.
        # NOTE: DuckDB's C extension makes `_conn.cursor` read-only, so
        # mock.patch.object(engine._conn, "cursor", ...) raises AttributeError.
        # We patch one level up: engine._conn (a plain Python attribute) is
        # freely rebindable, and MagicMock(wraps=...) proxies all real calls
        # while recording them.
        with mock.patch.object(engine, "_conn", wraps=engine._conn) as conn_spy:
            second = engine.list_stock_dates()
        assert conn_spy.cursor.call_count == 0, (
            "Cache hit must not allocate a cursor — every cache miss "
            "calls self.conn which calls _conn.cursor()."
        )
        assert second == first
    finally:
        engine.close()


def test_mtime_change_triggers_recompute(tmp_path: Path) -> None:
    """When meta.json's mtime advances, the cached row must be recomputed."""
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:2])
    try:
        first = engine.list_stock_dates()
        assert len(first) == 2

        # Bump mtime on one of the meta.json files by 5 seconds.
        meta_path = engine.data_dir / "parquet" / _DATES[0] / "003490" / "meta.json"
        original = meta_path.stat()
        new_ns = original.st_mtime_ns + 5_000_000_000
        os.utime(meta_path, ns=(new_ns, new_ns))

        # Spy on connection cursor() calls for the second call (using the
        # patch-whole-_conn pattern established in test_cache_hit_skips_duckdb,
        # because DuckDB's C extension makes _conn.cursor read-only).
        with mock.patch.object(
            engine, "_conn", wraps=engine._conn
        ) as conn_spy:
            second = engine.list_stock_dates()
        # The changed entry recomputes (>=1 cursor call); the unchanged
        # entry stays cached (0 additional cursor calls). Conservative
        # lower bound: at least 1, strictly less than the cold-call count.
        assert conn_spy.cursor.call_count >= 1
        # Selective-invalidation checks (stronger than `second == first`):
        # queries.py lines 158-160 compute captured_at as max(st_mtime)
        # over ALL files in code_dir — including meta.json itself — so
        # bumping meta.json's mtime by 5 s legitimately shifts captured_at
        # by 5000 ms for the recomputed entry.  The un-bumped entry must
        # be byte-identical (cache hit, no recompute).
        assert second[0].captured_at == first[0].captured_at + 5000
        assert second[1] == first[1]
    finally:
        engine.close()


def test_disappeared_dir_pruned_from_cache(tmp_path: Path) -> None:
    """When a Stock-Date dir is deleted, its cache entry must be evicted."""
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:2])
    try:
        first = engine.list_stock_dates()
        assert len(first) == 2
        assert len(engine._stock_date_cache) == 2

        # Delete one Stock-Date dir entirely.
        victim = engine.data_dir / "parquet" / _DATES[0] / "003490"
        shutil.rmtree(victim)
        # Also remove the empty date_dir so iterdir doesn't visit it.
        victim.parent.rmdir()

        second = engine.list_stock_dates()
        assert len(second) == 1
        assert len(engine._stock_date_cache) == 1
        assert (_DATES[0], "003490") not in engine._stock_date_cache
    finally:
        engine.close()

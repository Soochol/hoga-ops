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
        meta_path = engine.data_dir / "parquet" / _DATES[0] / "003490" / "hogaplay" / "meta.json"
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


# ---------------------------------------------------------------------------
# 배치 parquet 집계 (2026-07-29)
#
# _compute_stock_date 는 Stock-Date 당 DuckDB 쿼리를 2개 던진다. 콜드 캐시에서
# 15.9k 행 × 2 ≈ 32k 개의 read_parquet 호출이 되어 실측 39.5s 였다.
# _batch_parquet_stats 가 이를 아티팩트당 1쿼리로 접는다(실측 39.5s → 6.9s,
# 전 행 값 동일).
#
# 배치는 **최적화일 뿐 계약이 아니다**. 스키마가 어긋난 parquet 하나가 배치
# 전체를 죽일 수 있는데, 행별 경로는 그 한 행만 건너뛴다. 아래는 그 격리
# 속성이 배치 도입 후에도 유지되는지 고정한다.
# ---------------------------------------------------------------------------


def test_batch_and_per_row_produce_identical_rows(tmp_path: Path) -> None:
    """배치 경로와 행별 경로의 결과가 완전히 같아야 한다."""
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:3])
    batched = engine.list_stock_dates()

    # 캐시를 비우고 배치를 무력화해 행별 경로로 다시 계산.
    engine._stock_date_cache.clear()
    with mock.patch.object(QueryEngine, "_batch_parquet_stats", return_value={}):
        per_row = engine.list_stock_dates()

    assert [r.model_dump() for r in batched] == [r.model_dump() for r in per_row]


def test_batch_failure_falls_back_to_per_row(tmp_path: Path) -> None:
    """배치 쿼리가 터져도 목록은 정상적으로 나와야 한다.

    _batch_parquet_stats 는 어떤 실패도 삼키고 {} 를 돌려주며, 그러면 모든 행이
    기존 행별 쿼리를 탄다. 이게 성립하지 않으면 parquet 하나의 스키마 드리프트가
    인벤토리 엔드포인트 전체를 500 으로 만든다.
    """
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:3])
    expected = [r.model_dump() for r in engine.list_stock_dates()]

    engine._stock_date_cache.clear()
    real_execute = engine.conn.execute

    def _fail_batch(sql, *args, **kwargs):
        if "filename=true" in sql:
            raise RuntimeError("simulated BinderException")
        return real_execute(sql, *args, **kwargs)

    with mock.patch.object(type(engine.conn), "execute", side_effect=_fail_batch):
        got = engine.list_stock_dates()

    assert [r.model_dump() for r in got] == expected


def test_malformed_parquet_costs_one_row_not_the_endpoint(tmp_path: Path) -> None:
    """읽을 수 없는 parquet 이 섞여도 나머지 Stock-Date 는 살아남는다."""
    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:3])
    all_rows = engine.list_stock_dates()
    assert len(all_rows) == 3

    # 한 Stock-Date 의 candles.parquet 을 쓰레기로 덮는다.
    victim_date = _DATES[0]
    victim = engine.data_dir / "parquet" / victim_date / "003490"
    target = victim / "hogaplay" / "candles.parquet"
    if not target.exists():
        target = victim / "candles.parquet"
    target.write_bytes(b"not a parquet file")
    # meta.json mtime 을 흔들어 캐시 미스를 강제.
    meta = target.parent / "meta.json"
    os.utime(meta, None)
    engine._stock_date_cache.clear()

    survivors = engine.list_stock_dates()
    assert victim_date not in {r.date for r in survivors}
    assert len(survivors) == 2


def test_batch_stats_absent_dir_matches_empty_defaults(tmp_path: Path) -> None:
    """배치가 행을 못 만든 디렉터리(빈 parquet)는 행별 경로의 기본값과 같아야 한다."""
    from hoga.api.queries import _ParquetStats

    engine = _build_engine_with_stock_dates(tmp_path, _DATES[:1])
    stats = engine._batch_parquet_stats([tmp_path / "does" / "not" / "exist"])
    assert stats[tmp_path / "does" / "not" / "exist"] == _ParquetStats()
    assert _ParquetStats().bounds is None
    assert (_ParquetStats().price_min, _ParquetStats().price_max) == (0, 0)
    assert _ParquetStats().total_volume == 0

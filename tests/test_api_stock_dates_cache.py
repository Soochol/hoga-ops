"""Cache + cursor-isolation tests for QueryEngine.list_stock_dates.

These exercise the QueryEngine directly (not via TestClient) so the
in-memory cache state and cursor() call counts can be observed.
"""
from __future__ import annotations

import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
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

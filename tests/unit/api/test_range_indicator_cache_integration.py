"""Indicator cache wired into the slice builders — equivalence + cache authority.

The cache stores 1-minute quote_ratio/fill_strength per (code, date, source) and
re-aggregates on read. Two properties matter and are proven deterministically
(no timing):

1. **cache == recompute** — a cached (1m + re-aggregate) slice is byte-identical
   to the legacy direct ``bucket_ms=N`` query, including a closing-auction day.
2. **cache is authoritative for a warmed past day** — once the 1m rows are cached,
   a coarser-timeframe request is served WITHOUT re-querying the raw parquet
   (monkeypatched to fail if touched), which is the whole perf win.

Plus the gate: **today is never cached** (still promoting), and a sub-minute
bucket bypasses the cache (cannot re-aggregate finer than 1m).
"""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest

from hoga.api.bundle import build_fill_strength_slice, build_quote_ratio_slice
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms
from hoga.tables import snapshots as snapshots_tbl

DATE = "20260529"
FUTURE = "20260601"  # > DATE, so DATE counts as a completed past day
CODE = "005930"
SRC = "kis_live"
CLOSE_FULL = 153000000
DAY_START = hhmmssms_to_unix_ms(DATE, 0)
B3, B5 = 180_000, 300_000


def _unix(h: int, m: int, s: int = 0) -> int:
    return DAY_START + (h * 3600 + m * 60 + s) * 1000


def _engine_with_day(tmp_path: Path) -> QueryEngine:
    code_dir = tmp_path / "parquet" / DATE / CODE / SRC
    code_dir.mkdir(parents=True, exist_ok=True)
    code_dir.joinpath("meta.json").write_text(json.dumps({
        "source": SRC, "code": CODE, "date": DATE,
        "regular_session_open_ms": 90000000, "regular_session_close_ms": CLOSE_FULL,
        "collection_complete": True, "is_partial": False,
    }))
    # snapshots: continuous session + closing auction (exercises the rep rule).
    srows = []

    def _snap(unix_ms: int, bid: int, ask: int, continuous: bool) -> None:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"], row[f"ask_p{i}"], row[f"bid_q{i}"], row[f"ask_q{i}"] = 100, 101, 0, 0
        if continuous:  # 10-level book: deep level set → counts as continuous
            row["bid_q1"], row["bid_q4"], row["ask_q1"], row["ask_q4"] = bid - 1, 1, ask - 1, 1
        else:  # 3-level closing-auction book
            row["bid_q1"], row["ask_q1"] = bid, ask
        row["total_bid_qty"], row["total_ask_qty"] = bid, ask
        srows.append(row)

    minute, h, m = 0, 9, 0
    while (h, m) < (15, 20):
        bid, ask = 11 + (minute * 7) % 40, 21 + (minute * 11) % 40
        _snap(_unix(h, m, 10), bid, ask, True)
        _snap(_unix(h, m, 40), bid + 1, ask + 1, True)
        minute, m = minute + 1, m + 1
        if m == 60:
            m, h = 0, h + 1
    # Closing auction 15:20–15:29 (3-level) — exercises the rep/(0,0) path through
    # the full slice builder + cache, not just the pure re-aggregator.
    for mm in range(20, 30):
        _snap(_unix(15, mm, 30), 900 + mm, 800 + mm, False)
    pl.DataFrame(srows).write_parquet(code_dir / "snapshots.parquet")
    # trades for fill_strength.
    trows = []
    minute, h, m = 0, 9, 0
    while (h, m) < (15, 20):
        trows.append({"ts_ms": unix_ms_to_hhmmssms(DATE, _unix(h, m, 5)), "side": 1, "qty": 10 + minute % 5})  # noqa: E501
        trows.append({"ts_ms": unix_ms_to_hhmmssms(DATE, _unix(h, m, 35)), "side": -1, "qty": 4 + minute % 3})  # noqa: E501
        minute, m = minute + 1, m + 1
        if m == 60:
            m, h = 0, h + 1
    pl.DataFrame(trows).write_parquet(code_dir / "trades.parquet")
    return QueryEngine(tmp_path)


def _ratio(engine, bucket_ms, *, cache, today):
    return build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=bucket_ms, source=SRC,
        session_close_ms=CLOSE_FULL, cache=cache, today_kst=today,
    )


def _fill(engine, bucket_ms, *, cache, today):
    return build_fill_strength_slice(
        engine, code=CODE, date=DATE, bucket_ms=bucket_ms, source=SRC, cache=cache, today_kst=today,
    )


@pytest.mark.parametrize("bucket_ms", [B3, B5])
def test_cached_slice_equals_direct(tmp_path: Path, bucket_ms: int) -> None:
    engine = _engine_with_day(tmp_path)
    # Legacy direct path (no cache) is the oracle.
    direct_r = _ratio(engine, bucket_ms, cache=None, today=None)
    direct_f = _fill(engine, bucket_ms, cache=None, today=None)
    # Cached path (1m + re-aggregate) must produce identical wire points.
    cached_r = _ratio(engine, bucket_ms, cache=engine.indicators_cache, today=FUTURE)
    cached_f = _fill(engine, bucket_ms, cache=engine.indicators_cache, today=FUTURE)
    assert cached_r == direct_r
    assert cached_f == direct_f


def test_warmed_cache_serves_coarser_without_requerying(tmp_path: Path, monkeypatch) -> None:
    engine = _engine_with_day(tmp_path)
    oracle_3m = _ratio(engine, B3, cache=None, today=None)
    cache = engine.indicators_cache
    _ratio(engine, 60_000, cache=cache, today=FUTURE)  # warm 1m
    # Any further raw query is a cache-miss bug — make it explode.
    def _boom(*_a, **_k):
        raise AssertionError("raw snapshots re-queried despite a warm cache")
    monkeypatch.setattr(snapshots_tbl, "query_bucketed_ratio", _boom)
    served_3m = _ratio(engine, B3, cache=cache, today=FUTURE)
    assert served_3m == oracle_3m


def test_today_is_not_cached(tmp_path: Path) -> None:
    engine = _engine_with_day(tmp_path)
    cache = engine.indicators_cache
    # today_kst == DATE → DATE is "today" → must bypass the cache entirely.
    _ratio(engine, B3, cache=cache, today=DATE)
    _fill(engine, B3, cache=cache, today=DATE)
    assert cache.get_ratio(CODE, DATE, SRC) is None
    assert cache.get_fill(CODE, DATE, SRC) is None
    assert not (tmp_path / "kis-past-indicators").exists()


def test_sub_minute_bucket_bypasses_cache(tmp_path: Path) -> None:
    engine = _engine_with_day(tmp_path)
    cache = engine.indicators_cache
    # 1000 ms (the /replay default) is not a 1m multiple → cannot re-aggregate
    # from a 1m cache → must query directly and not populate the cache.
    _ratio(engine, 1000, cache=cache, today=FUTURE)
    assert cache.get_ratio(CODE, DATE, SRC) is None


def test_cache_file_written_for_past_day(tmp_path: Path) -> None:
    engine = _engine_with_day(tmp_path)
    _ratio(engine, B3, cache=engine.indicators_cache, today=FUTURE)
    _fill(engine, B3, cache=engine.indicators_cache, today=FUTURE)
    assert (tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.ratio.json").exists()
    assert (tmp_path / "kis-past-indicators" / CODE / SRC / f"{DATE}.fill.json").exists()

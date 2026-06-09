"""Series-level invariants — checks over candles/snapshots/trades artifacts.

Plan tasks 3, 4, 5 combined: catalog entries for candles_ts_monotonic
(error), snapshots_no_gaps (warn), cum_vol_monotonic (warn — forensic
trust signal, not broken shape; see ADR-0020 §5 + invariants.py)."""
from __future__ import annotations

from hoga.api.invariants import (
    SERIES_INVARIANTS,
    Severity,
    StockDateArtifacts,
    check_series,
)
from hoga.tables.candles import Candle


def _candle(ts_ms: int) -> Candle:
    return Candle(ts_ms=ts_ms, open_=100, close_=100, high=100, low=100,
                  vol_a=0, vol_b=0)


def _stub_orderbook(ts_ms: int):
    """Minimal Orderbook for ts_ms-only tests. Fields we don't need
    use trivial defaults — the invariant only reads ts_ms."""
    from hoga.tables.snapshots import Orderbook
    return Orderbook(
        ts_ms=ts_ms, seq=ts_ms,
        ask_p=(0,) * 10, ask_q=(0,) * 10, ask_d=(0,) * 10,
        bid_p=(0,) * 10, bid_q=(0,) * 10, bid_d=(0,) * 10,
        tot_ask=0, tot_ask_d=0, tot_bid=0, tot_bid_d=0,
    )


def _trade(ts_ms: int, seq: int, side: int, cum_vol: int):
    from hoga.tables.trades import Trade
    return Trade(
        ts_ms=ts_ms, seq=seq, price=100, change_pct=0.0, qty=1,
        side=side, cum_vol=cum_vol, cum_trades=1,
        low_so_far=100, high_so_far=100,
        net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0,
        unknown_18=0.0,
    )


# === Catalog registration ===

def test_catalog_has_three_series_invariants() -> None:
    ids = {inv.id for inv in SERIES_INVARIANTS}
    assert ids == {
        "series.candles_ts_monotonic",
        "series.snapshots_no_gaps",
        "series.cum_vol_monotonic",
    }


# === series.candles_ts_monotonic (error) ===

def test_candles_ts_monotonic_passes_for_strictly_ascending() -> None:
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_001_000), _candle(90_002_000), _candle(90_003_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert fired == []


def test_candles_ts_monotonic_fires_on_equal_timestamps() -> None:
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_001_000), _candle(90_001_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.error
    assert fired[0].ctx["prev_ts_ms"] == 90_001_000
    assert fired[0].ctx["curr_ts_ms"] == 90_001_000


def test_candles_ts_monotonic_passes_for_hogaplay_descending_input() -> None:
    """Real-world case: hogaplay's chart.tsv arrives newest-first (descending).
    candles.write_parquet sorts ASC before persisting, so the chart library
    only ever sees sorted data. The invariant must check the canonical order,
    not the raw parse order — otherwise it fires on every healthy capture.
    Regression for the 489790/20260224 archival false-positive (377 spurious
    violations recorded in meta.json, excluding the date from range queries)."""
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_003_000), _candle(90_002_000), _candle(90_001_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert fired == []


def test_candles_ts_monotonic_skips_when_candles_none() -> None:
    """Optional input: invariant skips silently if candles not loaded."""
    arts = StockDateArtifacts(meta={}, candles=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert fired == []


def test_candles_ts_monotonic_reports_each_duplicate_pair() -> None:
    """Post-sort, the only way to fail strict-ascending is duplicate ts_ms —
    one violation per duplicate pair, regardless of raw input order. The
    write_parquet sort puts adjacent dupes next to each other."""
    arts = StockDateArtifacts(meta={}, candles=[
        # Two distinct duplicate clusters; raw order is intentionally mixed
        # so the sort-first behavior is exercised, not just trivially passed.
        _candle(90_002_000), _candle(90_001_000), _candle(90_002_000),
        _candle(90_003_000), _candle(90_003_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 2
    # Both violations report duplicate timestamps (curr == prev).
    assert all(v.ctx["prev_ts_ms"] == v.ctx["curr_ts_ms"] for v in fired)


# === series.snapshots_no_gaps (warn) ===
# has_meaningful_gaps needs regular_session_close_ms to bound the Auction Window
# cutoff (Half-Day-safe), so the invariant pulls it from meta. Fixtures here
# pass a normal-day close (153000000 HHMMSSmmm = 15:30:00).
_REGULAR_CLOSE_META = {"regular_session_close_ms": 153_000_000}


def test_snapshots_no_gaps_passes_for_dense_stream() -> None:
    """One snapshot per second from 09:00:00 to 09:00:30 — no gap."""
    snaps = [_stub_orderbook(90_000_000 + i * 1000) for i in range(31)]
    arts = StockDateArtifacts(meta=_REGULAR_CLOSE_META, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []


def test_snapshots_no_gaps_fires_when_session_gap_present() -> None:
    """≥60s gap inside session → has_meaningful_gaps True → fire (warn)."""
    snaps = [
        _stub_orderbook(90_000_000),
        _stub_orderbook(90_130_000),  # 130s later — within session, big gap
    ]
    arts = StockDateArtifacts(meta=_REGULAR_CLOSE_META, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.warn


def test_snapshots_no_gaps_skips_when_snapshots_none() -> None:
    arts = StockDateArtifacts(meta=_REGULAR_CLOSE_META, snapshots=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []


def test_snapshots_no_gaps_skips_when_meta_lacks_session_close() -> None:
    """Legacy / malformed meta without regular_session_close_ms → skip silently
    rather than guess a default (which would re-introduce the Half-Day footgun
    that motivated making the parameter required on has_meaningful_gaps)."""
    snaps = [_stub_orderbook(90_000_000), _stub_orderbook(90_130_000)]
    arts = StockDateArtifacts(meta={}, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []


# === series.cum_vol_monotonic (warn) ===
# WARN, not error: a cum_vol regression (single hogaplay page-overlap rebase)
# leaves the segment shape intact — the read path consumes no cum_vol — so the
# date is INCLUDED with a data_warning rather than excluded. See ADR-0020 §5.

def test_cum_vol_monotonic_passes_for_clean_data() -> None:
    arts = StockDateArtifacts(meta={}, trades=[
        _trade(90_001_000, 10, 1, 5),
        _trade(90_002_000, 11, 1, 8),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert fired == []


def test_cum_vol_monotonic_fires_one_violation_per_regression() -> None:
    """Mirrors the helper test in test_tables_trades — two regressions
    must surface as two Violations (not first-only)."""
    arts = StockDateArtifacts(meta={}, trades=[
        _trade(90_001_000, 10, 1, 10),
        _trade(90_002_000, 11, -1, 8),   # regression 1
        _trade(90_003_000, 12, -1, 5),   # regression 2
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert len(fired) == 2
    assert all(v.severity == Severity.warn for v in fired)
    ctx_pairs = [(v.ctx["prev_cum"], v.ctx["curr_cum"]) for v in fired]
    assert (10, 8) in ctx_pairs
    assert (8, 5) in ctx_pairs


def test_cum_vol_monotonic_skips_when_trades_none() -> None:
    arts = StockDateArtifacts(meta={}, trades=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert fired == []


# === Regression: 5/18/003490 lightweight-charts crash pattern ===

def test_check_series_5_18_003490_candle_regression_pattern() -> None:
    """Lock the literal time values from the lightweight-charts stack trace
    that motivated ADR-0020 + the series catalog.

    Production error message: "Assertion failed: data must be asc ordered by
    time, index=1055, time=599428, prev time=631826". The library only sees
    the canonicalized parquet (sorted ASC by ``candles.write_parquet``), so a
    raw-input reordering would silently be fixed by the sort. The remaining
    way to trip the library is duplicate ts_ms: after ASC sort, equal-time
    rows land adjacent and the next row violates strict ordering. This test
    locks that contract with the original crash's literal time values."""
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(631_826_000),
        _candle(599_428_000),
        # Two candles share the original "curr" timestamp — after sort,
        # they collide and trigger the same chart-library assertion that
        # ADR-0020 was added to prevent.
        _candle(599_428_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.error
    assert fired[0].ctx["prev_ts_ms"] == 599_428_000
    assert fired[0].ctx["curr_ts_ms"] == 599_428_000

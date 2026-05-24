"""Series-level invariants — checks over candles/snapshots/trades artifacts.

Plan tasks 3, 4, 5 combined: catalog entries for candles_ts_monotonic
(error), snapshots_no_gaps (warn), cum_vol_monotonic (error)."""
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


def test_candles_ts_monotonic_fires_on_regression() -> None:
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_002_000), _candle(90_001_000),
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 1
    assert fired[0].ctx["curr_ts_ms"] < fired[0].ctx["prev_ts_ms"]


def test_candles_ts_monotonic_skips_when_candles_none() -> None:
    """Optional input: invariant skips silently if candles not loaded."""
    arts = StockDateArtifacts(meta={}, candles=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert fired == []


def test_candles_ts_monotonic_reports_every_regression() -> None:
    """Multiple bad pairs → one violation per pair (not just first)."""
    arts = StockDateArtifacts(meta={}, candles=[
        _candle(90_001_000), _candle(90_000_000),  # regression 1
        _candle(90_002_000), _candle(90_001_500),  # regression 2
    ])
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.candles_ts_monotonic"]
    assert len(fired) == 2


# === series.snapshots_no_gaps (warn) ===

def test_snapshots_no_gaps_passes_for_dense_stream() -> None:
    """One snapshot per second from 09:00:00 to 09:00:30 — no gap."""
    snaps = [_stub_orderbook(90_000_000 + i * 1000) for i in range(31)]
    arts = StockDateArtifacts(meta={}, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []


def test_snapshots_no_gaps_fires_when_session_gap_present() -> None:
    """≥60s gap inside session → has_meaningful_gaps True → fire (warn)."""
    snaps = [
        _stub_orderbook(90_000_000),
        _stub_orderbook(90_130_000),  # 130s later — within session, big gap
    ]
    arts = StockDateArtifacts(meta={}, snapshots=snaps)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert len(fired) == 1
    assert fired[0].severity == Severity.warn


def test_snapshots_no_gaps_skips_when_snapshots_none() -> None:
    arts = StockDateArtifacts(meta={}, snapshots=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.snapshots_no_gaps"]
    assert fired == []


# === series.cum_vol_monotonic (error) ===

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
    assert all(v.severity == Severity.error for v in fired)
    ctx_pairs = [(v.ctx["prev_cum"], v.ctx["curr_cum"]) for v in fired]
    assert (10, 8) in ctx_pairs
    assert (8, 5) in ctx_pairs


def test_cum_vol_monotonic_skips_when_trades_none() -> None:
    arts = StockDateArtifacts(meta={}, trades=None)
    fired = [v for v in check_series(arts)
             if v.invariant_id == "series.cum_vol_monotonic"]
    assert fired == []

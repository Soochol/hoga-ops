"""hoga validate — read-only sweep of all Stock-Date meta.json."""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from hoga.cli import app


def _seed(data_dir: Path, date: str, code: str, meta: dict) -> None:
    d = data_dir / "parquet" / date / code
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")


def _healthy() -> dict:
    return {
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_000_000,
        "collection_complete": True,
        "is_partial": False,
        "pages_collected": 100,
        "total_unique_events": 80,
    }


def test_validate_reports_violations(tmp_path, monkeypatch):
    """Walks parquet/, reports invariant violations to stdout."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})
    _seed(tmp_path, "20260520", "005930", _healthy())

    result = CliRunner().invoke(app, ["validate"])
    assert result.exit_code == 0
    assert "20260518" in result.stdout
    assert "003490" in result.stdout
    assert "meta.close_after_open" in result.stdout
    assert "005930" not in result.stdout


def test_validate_filters_by_code(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})
    _seed(tmp_path, "20260518", "005930", _healthy() | {"regular_session_close_ms": 0})

    result = CliRunner().invoke(app, ["validate", "--code", "003490"])
    assert result.exit_code == 0
    assert "003490" in result.stdout
    assert "005930" not in result.stdout


def test_validate_severity_warn_includes_warns(tmp_path, monkeypatch):
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # warn-only: low unique_events_ratio (4132 pages, 1553 events = real 5/18 case)
    _seed(tmp_path, "20260520", "005930",
          _healthy() | {"pages_collected": 4132, "total_unique_events": 1553})

    result_err = CliRunner().invoke(app, ["validate", "--severity", "error"])
    assert "005930" not in result_err.stdout

    result_warn = CliRunner().invoke(app, ["validate", "--severity", "warn"])
    assert "005930" in result_warn.stdout
    assert "collection.unique_events_ratio" in result_warn.stdout


def test_validate_fix_writes_archival_field(tmp_path, monkeypatch):
    """--fix rewrites the invariant_violations archival field. Data untouched."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    meta = _healthy() | {"regular_session_close_ms": 0}
    _seed(tmp_path, "20260518", "003490", meta)

    before = json.loads((tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text())
    assert "invariant_violations" not in before

    result = CliRunner().invoke(app, ["validate", "--fix"])
    assert result.exit_code == 0

    after = json.loads((tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text())
    assert "invariant_violations" in after
    ids = {v["invariant_id"] for v in after["invariant_violations"]}
    assert "meta.close_after_open" in ids
    # Original fields preserved.
    assert after["regular_session_open_ms"] == meta["regular_session_open_ms"]


def test_validate_fix_is_idempotent(tmp_path, monkeypatch):
    """Running --fix twice produces the same file content."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    _seed(tmp_path, "20260518", "003490", _healthy() | {"regular_session_close_ms": 0})

    CliRunner().invoke(app, ["validate", "--fix"])
    snap1 = (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    CliRunner().invoke(app, ["validate", "--fix"])
    snap2 = (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    assert snap1 == snap2


def _seed_with_candles(data_dir, date, code, meta, candle_ts_list):
    """Seed parquet with meta.json + candles.parquet (no snapshots/trades)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    d = data_dir / "parquet" / date / code
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    pq.write_table(
        pa.table({
            "ts_ms": pa.array(candle_ts_list, type=pa.int64()),
            "open_": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "close_": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "high": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "low": pa.array([100] * len(candle_ts_list), type=pa.int64()),
            "vol_a": pa.array([0] * len(candle_ts_list), type=pa.int64()),
            "vol_b": pa.array([0] * len(candle_ts_list), type=pa.int64()),
        }),
        d / "candles.parquet",
    )


def test_validate_deep_runs_series_invariants(tmp_path, monkeypatch):
    """--deep loads candles.parquet and reports series violations."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # Healthy meta but ts_ms regression in candles.
    _seed_with_candles(
        tmp_path, "20260520", "005930", _healthy(),
        candle_ts_list=[90_001_000, 90_001_000],  # duplicate ts_ms
    )

    result_shallow = CliRunner().invoke(app, ["validate", "--severity", "all"])
    # Without --deep, only meta-level checks run → clean for healthy meta.
    assert "series.candles_ts_monotonic" not in result_shallow.stdout

    result_deep = CliRunner().invoke(app, ["validate", "--deep", "--severity", "all"])
    assert result_deep.exit_code == 0
    assert "series.candles_ts_monotonic" in result_deep.stdout


def _seed_with_snapshots(data_dir, date, code, meta, snap_ts_list):
    """Seed parquet with meta.json + snapshots.parquet using the production
    flattened schema (ask_p1..p10, bid_p1..p10, ...). Required because the
    Orderbook dataclass takes tuples but parquet stores 60 scalar columns."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    from hoga.tables.snapshots import PARQUET_SCHEMA

    d = data_dir / "parquet" / date / code
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    n = len(snap_ts_list)
    cols = {"ts_ms": pa.array(snap_ts_list, type=pa.int64()),
            "seq": pa.array(list(range(1, n + 1)), type=pa.int32())}
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            cols[f"{prefix}{i}"] = pa.array([0] * n, type=pa.int32())
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        cols[total] = pa.array([0] * n, type=pa.int32())
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), d / "snapshots.parquet")


def test_validate_deep_fires_snapshots_no_gaps_through_real_parquet(tmp_path, monkeypatch):
    """Regression: snapshots.parquet uses flattened columns (ask_p1..p10
    etc.). An earlier _run_series_for built Orderbook(**r) which raised
    TypeError on every parquet row — the bare except in _read swallowed it,
    making series.snapshots_no_gaps a dead invariant for --deep.

    This test seeds an actual snapshots.parquet with a >60s in-session gap
    and verifies the violation surfaces through the CLI."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # Two snapshots, 130s apart inside the continuous session window.
    # has_meaningful_gaps fires on any ≥60s gap.
    _seed_with_snapshots(
        tmp_path, "20260520", "005930", _healthy(),
        snap_ts_list=[90_000_000, 90_130_000],
    )

    result = CliRunner().invoke(app, ["validate", "--deep", "--severity", "warn"])
    assert result.exit_code == 0, result.stdout
    assert "series.snapshots_no_gaps" in result.stdout


def test_validate_deep_unreadable_parquet_emits_warning(tmp_path, monkeypatch):
    """When a parquet file exists but can't be loaded (corrupt / schema drift),
    the CLI must surface a yellow warning — not silently treat the data as
    clean. Diagnostic tool must distinguish 'no violations' from 'I couldn't
    check'."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    d = tmp_path / "parquet" / "20260520" / "005930"
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps(_healthy()), encoding="utf-8")
    # Write garbage to snapshots.parquet — pyarrow will fail to read it.
    (d / "snapshots.parquet").write_bytes(b"not a valid parquet file")

    result = CliRunner().invoke(app, ["validate", "--deep", "--severity", "all"])
    assert result.exit_code == 0
    # The warning surfaces in stdout (via console.print) — rich colors may be
    # absent in test runner but the substring is present.
    assert "warning:" in result.stdout
    assert "snapshots.parquet" in result.stdout


def test_validate_deep_fix_writes_combined_archival(tmp_path, monkeypatch):
    """--deep --fix archives both meta and series violations."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    # Broken meta close + bad candles → both meta and series violations.
    bad_meta = _healthy() | {"regular_session_close_ms": 0}
    _seed_with_candles(
        tmp_path, "20260518", "003490", bad_meta,
        # Duplicate ts_ms is the only post-sort failure mode that survives
        # candles.write_parquet's canonical ASC sort — this is what actually
        # breaks the chart library. Raw-order regressions get silently fixed
        # by the sort, so they aren't valid invariant inputs anymore.
        candle_ts_list=[90_001_000, 90_001_000],
    )

    result = CliRunner().invoke(app, ["validate", "--deep", "--fix"])
    assert result.exit_code == 0

    after = json.loads(
        (tmp_path / "parquet" / "20260518" / "003490" / "meta.json").read_text()
    )
    assert "invariant_violations" in after
    ids = {v["invariant_id"] for v in after["invariant_violations"]}
    assert "meta.close_after_open" in ids
    assert "series.candles_ts_monotonic" in ids


def test_validate_fix_clears_stale_archival_when_now_clean(tmp_path, monkeypatch):
    """--fix must reconcile both directions — also CLEAR stale archival
    entries when the underlying invariants no longer fire. Regression for the
    skip-when-display-empty short-circuit: when the candles_ts_monotonic fix
    landed (false-positive removal), running --fix on the corpus rewrote only
    files with at least one remaining display violation; files whose entire
    archival list became empty kept the stale entries forever, because the
    fix-write block sat below the ``if not violations: continue`` guard."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))

    # Seed a meta.json that's healthy NOW but carries a stale archival entry
    # from a prior (broken / loosened) invariant pass. With the bug, --fix
    # finds no current violations and skips the file, leaving the lie.
    d = tmp_path / "parquet" / "20260520" / "005930"
    d.mkdir(parents=True)
    seeded = _healthy() | {
        "invariant_violations": [
            {
                "invariant_id": "series.candles_ts_monotonic",
                "severity": "error",
                "message": "candles ts_ms must be strictly ascending",
                "ctx": {"index": 1, "prev_ts_ms": 90_002_000, "curr_ts_ms": 90_001_000},
            },
        ],
    }
    (d / "meta.json").write_text(json.dumps(seeded), encoding="utf-8")

    result = CliRunner().invoke(app, ["validate", "--deep", "--fix", "--severity", "all"])
    assert result.exit_code == 0, result.stdout

    after = json.loads((d / "meta.json").read_text())
    # Stale field removed entirely (preferred over leaving an empty list).
    assert "invariant_violations" not in after
    # User-visible signal that --fix did real work even when display is clean.
    assert "cleared stale" in result.stdout

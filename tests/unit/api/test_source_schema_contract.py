"""Cross-source schema contract tests (ADR-0037 invariant).

Both `hogaplay` parser and `kis_live` Today/Daily Promotion must produce
`snapshots.parquet` and `trades.parquet` files whose column names satisfy
the read-path queries in `hoga/api/bundle.py`. These tests pin the
contract so a future schema drift on either side fails CI loudly instead
of silently corrupting `/api/range` responses.

Historical context — the 2026-05-28 incident:
  - hogaplay parser wrote snapshots with column `ts_ms` (canonical).
  - kis_live promote wrote snapshots with column `t_ms` (drifted).
  - read path queried `ts_ms`.
  - Bug stayed hidden because the source-aware data slice was broken
    elsewhere (fell back to hogaplay top-level parquet which happened to
    have `ts_ms`). Once the source-aware fix landed, kis_live's `t_ms`
    schema was exposed and DuckDB raised BinderException.
"""
from __future__ import annotations

import json
from pathlib import Path

from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.live.promote import _parse_jsonl_to_records

# ADR-0049: tests must use Unix ms inside the promotion `date`'s KST day
# window so the writer's HHMMSSmmm conversion succeeds (rows outside the
# window are dropped with midnight_race_skip).
_DATE = "20260528"
_T_MS_AT_OPEN = hhmmssms_to_unix_ms(_DATE, 90000000)  # 09:00:00.000 KST


# Columns the read path queries. Derived from inspection of
# hoga/api/bundle.py — keep in sync if those queries change.
READ_PATH_SNAPSHOT_COLUMNS = {
    "ts_ms",
    *(f"bid_q{i}" for i in range(1, 11)),
    *(f"ask_q{i}" for i in range(1, 11)),
}
READ_PATH_TRADE_COLUMNS = {"ts_ms", "price", "qty", "side"}


def test_kis_live_promote_snapshot_columns_match_read_path(tmp_path: Path) -> None:
    """kis_live Today/Daily Promotion output must contain every column the
    bundle's snapshot query references (ts_ms + 10-level bid_q/ask_q)."""
    jsonl = tmp_path / "in.jsonl"
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "ob",
        "payload": {
            "bids": [{"price": 26800, "qty": 879}],
            "asks": [{"price": 26850, "qty": 6141}],
            "total_bid_qty": 95085,
            "total_ask_qty": 102768,
            "phase": "regular",
        },
    }) + "\n")

    snapshots, _, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )
    assert len(snapshots) == 1
    actual_cols = set(snapshots[0].keys())
    missing = READ_PATH_SNAPSHOT_COLUMNS - actual_cols
    assert not missing, (
        f"kis_live promote snapshot missing columns required by build_quote_ratio_slice: "
        f"{missing}. Read path queries {READ_PATH_SNAPSHOT_COLUMNS}, "
        f"promote produced {actual_cols}."
    )


def test_kis_live_promote_trade_columns_match_read_path(tmp_path: Path) -> None:
    """kis_live Today/Daily Promotion trade output must contain every column
    the bundle's fill-strength + volume-profile queries reference."""
    jsonl = tmp_path / "in.jsonl"
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "trade",
        "payload": {
            "trades": [{
                "t_ms": _T_MS_AT_OPEN, "price": 26900, "qty": 10, "side": 1,
                "side_source": "inferred",
            }],
            "phase": "regular",
        },
    }) + "\n")

    _, trades, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )
    assert len(trades) == 1
    actual_cols = set(trades[0].keys())
    missing = READ_PATH_TRADE_COLUMNS - actual_cols
    assert not missing, (
        f"kis_live promote trade missing columns: {missing}. "
        f"Read path queries {READ_PATH_TRADE_COLUMNS}, "
        f"promote produced {actual_cols}."
    )


def test_hogaplay_snapshot_schema_matches_read_path() -> None:
    """hogaplay parser's pyarrow PARQUET_SCHEMA must satisfy the read-path
    column set. Pinning this surfaces drift if either side adds/renames cols.
    """
    from hoga.tables.snapshots import PARQUET_SCHEMA

    hogaplay_cols = {f.name for f in PARQUET_SCHEMA}
    missing = READ_PATH_SNAPSHOT_COLUMNS - hogaplay_cols
    assert not missing, (
        f"hogaplay parser PARQUET_SCHEMA missing read-path columns: "
        f"{missing}. Read path queries {READ_PATH_SNAPSHOT_COLUMNS}, "
        f"hogaplay schema has {hogaplay_cols}."
    )


def test_hogaplay_and_kis_live_share_read_path_columns(tmp_path: Path) -> None:
    """Both sources must share the read-path column subset. They may have
    additional source-specific columns (e.g. hogaplay's `seq`, `ask_d`,
    `tot_ask`; kis_live's `phase`, `total_bid_qty`) — those don't break the
    contract. What matters is that read-path queries can bind on BOTH.
    """
    from hoga.tables.snapshots import PARQUET_SCHEMA

    hogaplay_cols = {f.name for f in PARQUET_SCHEMA}

    jsonl = tmp_path / "in.jsonl"
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")
    snapshots, _, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )
    kis_live_cols = set(snapshots[0].keys())

    shared_required = hogaplay_cols & kis_live_cols
    missing_from_shared = READ_PATH_SNAPSHOT_COLUMNS - shared_required
    assert not missing_from_shared, (
        f"Columns required by read path not present in BOTH sources: "
        f"{missing_from_shared}. hogaplay={hogaplay_cols}, "
        f"kis_live={kis_live_cols}."
    )


def test_read_path_columns_round_trip_through_kis_live_parquet(tmp_path: Path) -> None:
    """Integration smoke: write a kis_live snapshot via the actual promote
    path (atomic_write_parquet → polars.write_parquet), then verify a
    DuckDB query mimicking build_quote_ratio_slice can SELECT the column
    set without BinderException."""
    import duckdb

    from hoga.api._atomic_write import atomic_write_parquet

    jsonl = tmp_path / "in.jsonl"
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "ob",
        "payload": {
            "bids": [{"price": 26800, "qty": 879}],
            "asks": [{"price": 26850, "qty": 6141}],
            "total_bid_qty": 95085,
            "total_ask_qty": 102768,
            "phase": "regular",
        },
    }) + "\n")
    snapshots, _, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )

    parquet_path = tmp_path / "snapshots.parquet"
    atomic_write_parquet(parquet_path, snapshots)
    assert parquet_path.exists()

    # Mimic build_quote_ratio_slice's column references.
    con = duckdb.connect()
    try:
        result = con.execute(
            "SELECT ts_ms, "
            "(bid_q1+bid_q2+bid_q3+bid_q4+bid_q5+bid_q6+bid_q7+bid_q8+bid_q9+bid_q10) AS bid_total, "
            "(ask_q1+ask_q2+ask_q3+ask_q4+ask_q5+ask_q6+ask_q7+ask_q8+ask_q9+ask_q10) AS ask_total "
            "FROM read_parquet(?)",
            [str(parquet_path)],
        ).fetchall()
    finally:
        con.close()
    assert len(result) == 1
    ts_ms, bid_total, ask_total = result[0]
    # ADR-0049: parquet ts_ms stores HHMMSSmmm (90000000 = 09:00:00.000), not Unix ms.
    assert ts_ms == 90000000
    assert bid_total == 879  # only level 1 set in fixture
    assert ask_total == 6141

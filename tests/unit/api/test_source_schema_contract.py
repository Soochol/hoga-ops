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
# hoga/api/bundle.py (build_quote_ratio_slice, build_fill_strength_slice)
# AND hoga/tables/snapshots.query_at (/api/orderbook hover spot path).
# Keep in sync if those queries change.
READ_PATH_SNAPSHOT_COLUMNS = {
    "ts_ms",
    "seq",  # query_at SELECTs seq for tie-break and ApiOrderbookSnapshot ctor.
    *(f"bid_p{i}" for i in range(1, 11)),
    *(f"bid_q{i}" for i in range(1, 11)),
    *(f"ask_p{i}" for i in range(1, 11)),
    *(f"ask_q{i}" for i in range(1, 11)),
    "tot_ask", "tot_bid",  # query_at returns ApiOrderbookSnapshot.tot_*.
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

    import pyarrow.parquet as pq

    from hoga.tables.snapshots import write_parquet as write_snapshots_parquet

    snapshots, _, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )
    assert len(snapshots) == 1
    out = tmp_path / "snapshots.parquet"
    write_snapshots_parquet(snapshots, out)
    actual_cols = set(pq.read_table(out).column_names)
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

    import pyarrow.parquet as pq

    from hoga.tables.trades import write_parquet as write_trades_parquet

    _, trades, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )
    assert len(trades) == 1
    out = tmp_path / "trades.parquet"
    write_trades_parquet(trades, out)
    actual_cols = set(pq.read_table(out).column_names)
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
    """Both sources go through the same canonical PARQUET_SCHEMA writer, so
    a kis_live-promoted parquet must expose the read-path columns even
    though KIS REST is delta-free (depth deltas / tot deltas synthesized
    as 0). This locks the writer contract: both sources land in the same
    column shape on disk.
    """
    import pyarrow.parquet as pq

    from hoga.tables.snapshots import PARQUET_SCHEMA, write_parquet as write_snapshots_parquet

    hogaplay_cols = {f.name for f in PARQUET_SCHEMA}

    jsonl = tmp_path / "in.jsonl"
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")
    snapshots, _, _, _ = _parse_jsonl_to_records(
        jsonl, code="003490", date=_DATE,
    )
    out = tmp_path / "snapshots.parquet"
    write_snapshots_parquet(snapshots, out)
    kis_live_cols = set(pq.read_table(out).column_names)

    shared_required = hogaplay_cols & kis_live_cols
    missing_from_shared = READ_PATH_SNAPSHOT_COLUMNS - shared_required
    assert not missing_from_shared, (
        f"Columns required by read path not present in BOTH sources: "
        f"{missing_from_shared}. hogaplay={hogaplay_cols}, "
        f"kis_live={kis_live_cols}."
    )


def test_kis_live_snapshots_query_at_round_trip(tmp_path: Path) -> None:
    """/api/orderbook hover spot path: snapshots.query_at against a kis_live
    promoted parquet must return a fully-populated ApiOrderbookSnapshot —
    no BinderException, no None on a row that's present.

    This is the regression seam for the 2026-05-29 hover bug: the previous
    schema omitted `seq`, `ask_d*`, `bid_d*`, `tot_ask`, `tot_bid`, causing
    query_at's SELECT to BinderException → /api/orderbook 500 →
    hover spot empty for today's date.
    """
    import asyncio

    import duckdb

    from hoga.live.promote import promote_one
    from hoga.tables.snapshots import query_at

    jsonl = tmp_path / "live" / _DATE / "005930.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "ob",
        "payload": {
            "bids": [{"price": 26800 - i, "qty": 100 + i} for i in range(10)],
            "asks": [{"price": 26850 + i, "qty": 200 + i} for i in range(10)],
            "total_bid_qty": 95085,
            "total_ask_qty": 102768,
            "phase": "regular",
        },
    }) + "\n")

    parquet_root = tmp_path / "parquet"
    asyncio.run(promote_one(jsonl, parquet_root, code="005930", date=_DATE))
    snapshots_path = parquet_root / _DATE / "005930" / "kis_live" / "snapshots.parquet"

    con = duckdb.connect()
    try:
        snap = query_at(con, path=snapshots_path, t_ms=200_000_000)
    finally:
        con.close()
    assert snap is not None
    assert snap.ts_ms == 90000000
    assert snap.bid[0].price == 26800 and snap.bid[0].qty == 100
    assert snap.ask[0].price == 26850 and snap.ask[0].qty == 200
    assert snap.tot_bid == 95085 and snap.tot_ask == 102768


def test_kis_live_trades_full_schema_round_trip(tmp_path: Path) -> None:
    """trades.parquet must expose every canonical PARQUET_SCHEMA column,
    not just the four (ts_ms/price/qty/side) current bundle.py readers use.

    Guards against the same class of bug as the snapshots round-trip:
    if promote.py ever regresses to a dict-form path that drops forensic
    columns (cum_vol, change_pct, net_pressure, unknown_*), any analytics
    endpoint that later SELECTs those will BinderException at runtime.
    Locking the full shape at write time makes that drift fail in CI.
    """
    import asyncio

    import duckdb

    from hoga.live.promote import promote_one
    from hoga.tables.trades import PARQUET_SCHEMA as TRADES_PARQUET_SCHEMA

    jsonl = tmp_path / "live" / _DATE / "005930.jsonl"
    jsonl.parent.mkdir(parents=True)
    jsonl.write_text(json.dumps({
        "t_ms": _T_MS_AT_OPEN, "kind": "trade",
        "payload": {
            "trades": [
                {"price": 26900, "qty": 10, "side": 1, "side_source": "inferred"},
                {"price": 26890, "qty": 5, "side": -1, "side_source": "inferred"},
            ],
        },
    }) + "\n")

    parquet_root = tmp_path / "parquet"
    asyncio.run(promote_one(jsonl, parquet_root, code="005930", date=_DATE))
    trades_path = parquet_root / _DATE / "005930" / "kis_live" / "trades.parquet"

    canonical_cols = [f.name for f in TRADES_PARQUET_SCHEMA]
    select_clause = ", ".join(canonical_cols)
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT {select_clause} FROM read_parquet(?) ORDER BY seq",
            [str(trades_path)],
        ).fetchall()
    finally:
        con.close()
    assert len(rows) == 2
    # seq is the 2nd column, monotonic per the writer contract.
    seq_idx = canonical_cols.index("seq")
    assert [r[seq_idx] for r in rows] == [1, 2]


def test_read_path_columns_round_trip_through_kis_live_parquet(tmp_path: Path) -> None:
    """Integration smoke: write a kis_live snapshot via the canonical writer
    (snapshots.write_parquet → PARQUET_SCHEMA-enforced pyarrow table), then
    verify a DuckDB query mimicking build_quote_ratio_slice can SELECT the
    column set without BinderException."""
    import duckdb

    from hoga.tables.snapshots import write_parquet as write_snapshots_parquet

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
    write_snapshots_parquet(snapshots, parquet_path)
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

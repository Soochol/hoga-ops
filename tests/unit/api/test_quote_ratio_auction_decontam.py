"""Closing-auction straddle-bucket de-contamination (2026-06-03 spec).

build_quote_ratio_slice must represent a bucket that straddles the closing
Auction Window (15:20–15:30) with its LAST pre-15:20 snapshot, not the auction
snapshot it also contains. Fully-auction buckets fall back to the last snapshot
(legacy). Half-day sessions anchor auction_start at session_close − 10min.
"""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl

from hoga.api.bundle import build_quote_ratio_slice
from hoga.api.queries import QueryEngine
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms

DATE = "20260529"
CODE = "005930"
DAY_START = hhmmssms_to_unix_ms(DATE, 0)  # 00:00:00.000 KST = day start

CLOSE_FULL = 153000000  # 15:30:00.000 (full-day Regular Session close, HHMMSSmmm)
CLOSE_HALF = 123000000  # 12:30:00.000 (half-day close, HHMMSSmmm)

BUCKET_3M = 180_000
BUCKET_5M = 300_000


def _hms_unix(h: int, m: int, s: int = 0) -> int:
    """Unix ms for HH:MM:SS KST on DATE."""
    return DAY_START + ((h * 3600 + m * 60 + s) * 1000)


def _write_snaps(path: Path, snaps: list[tuple[int, int, int]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total). bid_q1/ask_q1 carry the total and
    q2..q10 = 0, so the slice's SUM(bid_q1..q10) == bid_total — lets each
    snapshot have a distinct, identifiable representative value."""
    rows = []
    for unix_ms, bid_total, ask_total in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        row["bid_q1"] = bid_total
        row["ask_q1"] = ask_total
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _engine(tmp_path: Path, snaps: list[tuple[int, int, int]], close_ms: int) -> QueryEngine:
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": "kis_live", "code": CODE, "date": DATE,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": close_ms,
        "collection_complete": True, "is_partial": False,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta))
    _write_snaps(code_dir / "snapshots.parquet", snaps)
    return QueryEngine(tmp_path)


def test_straddle_bucket_uses_last_pre_auction_snapshot(tmp_path: Path) -> None:
    # 3m bucket [15:18,15:21): 15:18 & 15:19 are continuous; 15:20:30 is auction.
    snaps = [
        (_hms_unix(15, 18, 0), 11, 21),
        (_hms_unix(15, 19, 0), 12, 22),    # last pre-auction → must win
        (_hms_unix(15, 20, 30), 99, 98),   # auction → must be excluded
    ]
    engine = _engine(tmp_path, snaps, CLOSE_FULL)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_3M,
        source="kis_live", session_close_ms=CLOSE_FULL,
    )
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)

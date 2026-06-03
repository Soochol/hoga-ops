"""Closing-auction structural-boundary de-contamination (2026-06-03 spec).

build_quote_ratio_slice marks a snapshot as closing-auction by ORDERBOOK STRUCTURE
(the book collapses from 10 visible levels to 3 — ask_q4..ask_q10 / bid_q4..bid_q10
all zero), NOT by a 15:20 wall-clock threshold. `last_continuous_ms` = the last
continuous-book snapshot at/before the session close; snapshots after it are the
closing auction. The `<= session_close` bound is load-bearing (every stock shows a
post-cross book re-expansion ~15:30:14). Intraday VI single-price runs sit before
the threshold and are intentionally retained (v1 = closing-only).
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

CLOSE_FULL = 153000000  # 15:30:00.000 (full-day close, HHMMSSmmm)
CLOSE_HALF = 123000000  # 12:30:00.000 (half-day close, HHMMSSmmm)

BUCKET_3M = 180_000
BUCKET_5M = 300_000


def _hms_unix(h: int, m: int, s: int = 0) -> int:
    """Unix ms for HH:MM:SS KST on DATE."""
    return DAY_START + ((h * 3600 + m * 60 + s) * 1000)


def _write_snaps(path: Path, snaps: list[tuple[int, int, int, bool]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total, is_continuous).

    SUM(bid_q1..q10) == bid_total in both cases so the slice's representative value
    is identifiable. Structural distinction:
      - continuous (10-level book): bid_q1 = total-1, bid_q4 = 1 → deep level > 0.
      - auction (3-level book): bid_q1 = total, q2..q10 = 0 → deep levels == 0.
    (totals require >= 1 for the continuous split; all test values are >= 11.)
    """
    rows = []
    for unix_ms, bid_total, ask_total, is_cont in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        if is_cont:
            row["bid_q1"] = bid_total - 1
            row["bid_q4"] = 1
            row["ask_q1"] = ask_total - 1
            row["ask_q4"] = 1
        else:
            row["bid_q1"] = bid_total
            row["ask_q1"] = ask_total
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _engine(tmp_path: Path, snaps: list[tuple[int, int, int, bool]], close_ms: int) -> QueryEngine:
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


def _slice(engine: QueryEngine, bucket_ms: int, close_ms: int):
    return build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=bucket_ms,
        source="kis_live", session_close_ms=close_ms,
    )


def test_straddle_bucket_uses_last_continuous_snapshot(tmp_path: Path) -> None:
    # 3m bucket [15:18,15:21): 15:18 & 15:19 continuous; 15:20:30 auction (3-level).
    snaps = [
        (_hms_unix(15, 18, 0), 11, 21, True),
        (_hms_unix(15, 19, 0), 12, 22, True),    # last continuous → must win
        (_hms_unix(15, 20, 30), 99, 98, False),  # auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)


def test_jitter_early_transition_excludes_pre_1520_auction(tmp_path: Path) -> None:
    # Auction starts BEFORE 15:20 (15:19:55). The old time-based code treated this
    # 3-level snapshot as pre-auction and let it contaminate the bucket. Structural
    # detection classifies it as auction regardless of the clock.
    snaps = [
        (_hms_unix(15, 18, 0), 11, 21, True),
        (_hms_unix(15, 19, 30), 12, 22, True),   # last continuous → must win
        (_hms_unix(15, 19, 55), 99, 98, False),  # 3-level BEFORE 15:20 → auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)


def test_jitter_late_transition_keeps_post_1520_continuous(tmp_path: Path) -> None:
    # Auction starts AFTER 15:20 (15:20:05). The continuous snapshot at 15:20:03
    # must NOT be dropped (old time-based code would treat >=15:20 as auction).
    snaps = [
        (_hms_unix(15, 19, 0), 11, 21, True),
        (_hms_unix(15, 20, 3), 12, 22, True),    # continuous AFTER 15:20 → must win
        (_hms_unix(15, 20, 5), 99, 98, False),   # auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (12, 22)


def test_fully_auction_bucket_falls_back_to_last(tmp_path: Path) -> None:
    # A continuous snapshot at 15:19 defines the threshold; the [15:21,15:24)
    # bucket is fully auction → no continuous member → fallback to last (15:22).
    snaps = [
        (_hms_unix(15, 19, 0), 53, 63, True),    # threshold anchor (bucket [15:18,15:21))
        (_hms_unix(15, 21, 0), 31, 41, False),
        (_hms_unix(15, 22, 0), 32, 42, False),   # last auction → fallback wins
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 2
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (53, 63)
    assert (qr.points[1].bid_total, qr.points[1].ask_total) == (32, 42)


def test_clean_timeframe_unchanged_5m(tmp_path: Path) -> None:
    # 5m, all continuous — no auction in the data. Last in [15:15,15:20) = 15:19.
    snaps = [
        (_hms_unix(15, 15, 0), 51, 61, True),
        (_hms_unix(15, 18, 0), 52, 62, True),
        (_hms_unix(15, 19, 0), 53, 63, True),
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_5M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (53, 63)


def test_half_day_boundary_via_structure(tmp_path: Path) -> None:
    # Half-day 12:30 close. Structure (not a -10min offset) lands the threshold at
    # 12:19; 12:20:30 (3-level) is excluded. 3m bucket [12:18,12:21).
    snaps = [
        (_hms_unix(12, 18, 0), 71, 81, True),
        (_hms_unix(12, 19, 0), 72, 82, True),    # last continuous → wins
        (_hms_unix(12, 20, 30), 99, 98, False),  # auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_HALF), BUCKET_3M, CLOSE_HALF)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (72, 82)


def test_after_hours_continuous_excluded_by_close_bound(tmp_path: Path) -> None:
    # A post-cross book re-expansion at 15:30:14 (continuous) must NOT push the
    # threshold past the closing auction. Without the `<= close` bound,
    # last_continuous_ms would be 15:30:14 and 15:20:30 would be wrongly kept.
    snaps = [
        (_hms_unix(15, 19, 0), 11, 21, True),    # last continuous <= close → threshold
        (_hms_unix(15, 20, 30), 99, 98, False),  # auction → excluded
        (_hms_unix(15, 30, 14), 77, 88, True),   # post-cross continuous (> close)
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 2
    # bucket [15:18,15:21) represented by 15:19 (NOT the 15:20:30 auction).
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (11, 21)


def test_intraday_vi_run_retained(tmp_path: Path) -> None:
    # v1 = closing-only. An intraday VI single-price run (3-level at 11:39/11:40)
    # sits before last_continuous_ms (~15:19) so it is classified pre-auction and
    # RETAINED (its 3-level value is kept — documented v1 trade-off).
    snaps = [
        (_hms_unix(11, 39, 0), 11, 21, False),   # VI 3-level
        (_hms_unix(11, 40, 0), 12, 22, False),   # VI 3-level (last in its bucket)
        (_hms_unix(15, 19, 0), 50, 60, True),    # continuous → threshold anchor
        (_hms_unix(15, 20, 30), 99, 98, False),  # closing auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    vi_bucket = [p for p in qr.points if p.bid_total == 12 and p.ask_total == 22]
    assert vi_bucket, "intraday VI bucket must be retained (closing-only v1)"


def test_no_continuous_snapshot_falls_back_legacy(tmp_path: Path) -> None:
    # Degenerate: every snapshot is 3-level (no continuous). last_continuous_ms is
    # undefined → legacy last-in-bucket (does NOT blank the series).
    snaps = [
        (_hms_unix(15, 21, 0), 31, 41, False),
        (_hms_unix(15, 22, 0), 32, 42, False),   # last → wins
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (32, 42)

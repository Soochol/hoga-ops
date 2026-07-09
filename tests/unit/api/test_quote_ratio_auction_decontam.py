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


def test_fully_auction_bucket_excluded_as_zero(tmp_path: Path) -> None:
    # A continuous snapshot at 15:19 defines the threshold; the [15:21,15:24)
    # bucket is fully auction (no continuous member) → the closing-auction 3-level
    # book is EXCLUDED from the calculation: the bucket emits 0, not the auction
    # fallback (ADR-0062). The point is kept (at 0) so the display mask / overlay
    # band / day-boundary handling stay intact.
    snaps = [
        (_hms_unix(15, 19, 0), 53, 63, True),    # threshold anchor (bucket [15:18,15:21))
        (_hms_unix(15, 21, 0), 31, 41, False),
        (_hms_unix(15, 22, 0), 32, 42, False),   # fully-auction bucket → excluded (0)
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 2
    assert (qr.points[0].bid_total, qr.points[0].ask_total) == (53, 63)
    assert (qr.points[1].bid_total, qr.points[1].ask_total) == (0, 0)


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


def test_intraday_vi_run_excluded(tmp_path: Path) -> None:
    # ADR-0062 v2 (VI 통일): 장중 VI 단일가 붕괴책(3-level, 11:39/11:40)은 이제 마감
    # 동시호가와 동일하게 `_DEEP_BOOK_SQL`로 구조적 배제된다 — 붕괴값 (11,21)/(12,22)이
    # 호가비 계산에 들어가지 않고, VI-only 버킷은 (0,0) 센티넬로 방출된다(피크와 동일 술어).
    snaps = [
        (_hms_unix(11, 39, 0), 11, 21, False),   # VI 3-level → excluded
        (_hms_unix(11, 40, 0), 12, 22, False),   # VI 3-level → excluded
        (_hms_unix(15, 19, 0), 50, 60, True),    # continuous → threshold anchor
        (_hms_unix(15, 20, 30), 99, 98, False),  # closing auction → excluded
    ]
    qr = _slice(_engine(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    values = {(p.bid_total, p.ask_total) for p in qr.points}
    assert (11, 21) not in values, "VI 3-level book must be excluded (ADR-0062 v2)"
    assert (12, 22) not in values, "VI 3-level book must be excluded (ADR-0062 v2)"
    # VI-only 버킷은 마감 동시호가와 동일하게 (0,0) 센티넬로 방출(슬롯 보존).
    assert (0, 0) in values
    # 연속거래 버킷은 그대로 대표값 유지.
    assert (50, 60) in values


def _write_multi(path: Path, snaps: list[tuple[int, int, int]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total) — 전부 연속거래(10-레벨) 스냅샷.
    bid_q1=total-1, bid_q4=1 로 deep level>0 (연속거래 구조)."""
    rows = []
    for unix_ms, bid_total, ask_total in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        row["bid_q1"] = bid_total - 1
        row["bid_q4"] = 1
        row["ask_q1"] = ask_total - 1
        row["ask_q4"] = 1
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _engine_multi(tmp_path: Path, snaps: list[tuple[int, int, int]], close_ms: int) -> QueryEngine:
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": "kis_live", "code": CODE, "date": DATE,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": close_ms,
        "collection_complete": True, "is_partial": False,
    }
    (code_dir / "meta.json").write_text(json.dumps(meta))
    _write_multi(code_dir / "snapshots.parquet", snaps)
    return QueryEngine(tmp_path)


def test_quote_ratio_slice_carries_intra_max_fields(tmp_path: Path) -> None:
    """슬라이스 QuoteRatioPoint가 종가 옆에 Intra-Bar Max 4필드를 싣는다(직접 쿼리 경로).
    한 3m 버킷 안 bid max@t1, ask max@t2, 종가=마지막."""
    snaps = [
        (_hms_unix(9, 0, 10), 900, 100),  # bid max
        (_hms_unix(9, 1, 10), 50, 800),   # ask max
        (_hms_unix(9, 2, 10), 11, 21),    # 종가
    ]
    qr = _slice(_engine_multi(tmp_path, snaps, CLOSE_FULL), BUCKET_3M, CLOSE_FULL)
    assert len(qr.points) == 1
    p = qr.points[0]
    assert (p.bid_total, p.ask_total) == (11, 21)  # 종가
    assert p.bid_max == 900 and p.ask_max == 800   # 독립 max
    # |imb| 극값 스냅샷: (900,100) mag=9, (50,800) mag=16, (11,21) mag≈1.9 → (50,800).
    assert (p.imb_max_bid, p.imb_max_ask) == (50, 800)


def test_quote_ratio_slice_intra_max_via_cache_reaggregation(tmp_path: Path) -> None:
    """과거일 캐시 재집계 경로(today_kst != date)도 max 필드를 배선한다.
    1m 캐시 → reaggregate_ratio → QuoteRatioPoint."""
    from hoga.api.past_indicators_cache import PastIndicatorsCache
    snaps = [
        (_hms_unix(9, 0, 10), 900, 100),
        (_hms_unix(9, 1, 10), 50, 800),
        (_hms_unix(9, 2, 10), 11, 21),
    ]
    engine = _engine_multi(tmp_path, snaps, CLOSE_FULL)
    cache = PastIndicatorsCache(tmp_path / "cache")
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=BUCKET_3M,
        source="kis_live", session_close_ms=CLOSE_FULL,
        cache=cache, today_kst="20260530",  # date != today → cacheable 재집계 경로
    )
    assert len(qr.points) == 1
    p = qr.points[0]
    assert p.bid_max == 900 and p.ask_max == 800
    assert (p.imb_max_bid, p.imb_max_ask) == (50, 800)


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

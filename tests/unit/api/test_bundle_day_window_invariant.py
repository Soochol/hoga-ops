"""ADR-0049 regression — series builders must return t in the date's day window.

Locks the invariant that no encoding regression (writer-side or reader-side)
can cause quote_ratio.points[*].t or fill_strength.points[*].t to escape
the [KST_midnight(date), KST_midnight(date) + 86_400_000) range.

Also covers fill_strength's source-priority branch (그릴링 Q4):
fills.parquet preferred, trades.parquet fallback.
"""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest

from hoga.api.bundle import build_fill_strength_slice, build_quote_ratio_slice
from hoga.api.queries import QueryEngine

# NOTE: per Task 1 code review, tests do NOT import the private
# _date_unix_ms_at_kst_midnight. Use hhmmssms_to_unix_ms(date, 0) instead
# (= 00:00:00.000 KST = day start), a stable public contract.
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms
from hoga.tables.fills import Fill, write_fills_parquet

DATE = "20260529"
CODE = "005930"
DAY_START = hhmmssms_to_unix_ms(DATE, 0)  # 00:00:00.000 KST = day start
DAY_END = DAY_START + 86_400_000


def _meta_dict() -> dict:
    return {
        "source": "kis_live",
        "code": CODE,
        "date": DATE,
        "regular_session_open_ms": 90000000,
        "regular_session_close_ms": 153000000,
        "collection_complete": True,
        "is_partial": False,
        "row_counts": {"snapshots": 3, "trades": 3, "brokers": 0},
    }


def _write_snapshot_parquet(path: Path, unix_ms_list: list[int]) -> None:
    """Write snapshots.parquet with ts_ms encoded as HHMMSSmmm (ADR-0049 contract)."""
    rows = []
    for ts_unix_ms in unix_ms_list:
        row = {"ts_ms": unix_ms_to_hhmmssms(DATE, ts_unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"bid_q{i}"] = 10
            row[f"ask_p{i}"] = 101
            row[f"ask_q{i}"] = 10
        row["total_bid_qty"] = 100
        row["total_ask_qty"] = 100
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _write_trade_parquet(path: Path, unix_ms_list: list[int]) -> None:
    rows = [
        {
            "ts_ms": unix_ms_to_hhmmssms(DATE, ts_unix_ms),
            "price": 100,
            "qty": 10,
            "side": 1,
            "side_source": "inferred",
            "phase": "regular",
        }
        for ts_unix_ms in unix_ms_list
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


@pytest.fixture
def kis_live_fixture(tmp_path: Path) -> Path:
    """A kis_live Source dir with a few rows spanning 09:00-10:00:30 KST.

    Returns the data_dir (parent of parquet/) so callers can construct
    QueryEngine(data_dir) — established pattern from
    tests/unit/api/test_bundle_source.py:27.
    """
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    (code_dir / "meta.json").write_text(json.dumps(_meta_dict()))
    sample_unix = [
        DAY_START + (9 * 3600 + 0) * 1000,    # 09:00:00 KST
        DAY_START + (10 * 3600 + 0) * 1000,   # 10:00:00 KST
        DAY_START + (10 * 3600 + 30) * 1000,  # 10:00:30 KST
    ]
    _write_snapshot_parquet(code_dir / "snapshots.parquet", sample_unix)
    _write_trade_parquet(code_dir / "trades.parquet", sample_unix)
    return tmp_path


def test_quote_ratio_t_within_day_window(kis_live_fixture: Path) -> None:
    """All quote_ratio.points[*].t must fall in [DAY_START, DAY_END)."""
    engine = QueryEngine(kis_live_fixture)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    assert len(qr.points) > 0, "fixture should produce at least one point"
    for p in qr.points:
        assert DAY_START <= p.t < DAY_END, (
            f"point t={p.t} outside day window [{DAY_START}, {DAY_END}) for {DATE}. "
            f"This is the ADR-0049 / spec invariant 3 regression."
        )


def test_fill_strength_t_within_day_window(kis_live_fixture: Path) -> None:
    """All fill_strength.points[*].t must fall in [DAY_START, DAY_END)."""
    engine = QueryEngine(kis_live_fixture)
    fs = build_fill_strength_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    assert len(fs.points) > 0, "fixture should produce at least one point"
    for p in fs.points:
        assert DAY_START <= p.t < DAY_END, (
            f"point t={p.t} outside day window [{DAY_START}, {DAY_END}) for {DATE}. "
            f"This is the ADR-0049 / spec invariant 3 regression."
        )


def test_quote_ratio_breaks_when_writer_skips_encoding(tmp_path: Path) -> None:
    """Proof that this test would have caught the original bug.

    If we deliberately write Unix ms (NOT HHMMSSmmm) into ts_ms — the exact
    bug ADR-0049 fixes — the day-window assertion must fail.
    """
    code_dir = tmp_path / "parquet" / DATE / CODE / "kis_live"
    code_dir.mkdir(parents=True, exist_ok=True)
    (code_dir / "meta.json").write_text(json.dumps(_meta_dict()))
    sample_unix = [
        DAY_START + (10 * 3600 + 0) * 1000,
        DAY_START + (10 * 3600 + 30) * 1000,
    ]
    # Bug simulation: write Unix ms directly (skipping the HHMMSSmmm conversion).
    rows = []
    for ts_unix_ms in sample_unix:
        row = {"ts_ms": ts_unix_ms, "phase": "regular"}  # ← the bug
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"bid_q{i}"] = 10
            row[f"ask_p{i}"] = 101
            row[f"ask_q{i}"] = 10
        row["total_bid_qty"] = 100
        row["total_ask_qty"] = 100
        rows.append(row)
    pl.DataFrame(rows).write_parquet(code_dir / "snapshots.parquet")

    engine = QueryEngine(tmp_path)
    qr = build_quote_ratio_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    # All resulting t values should be outside the day window because Unix ms
    # decoded-as-HHMMSSmmm lands in year 2046.
    outside = [p for p in qr.points if not (DAY_START <= p.t < DAY_END)]
    assert outside, (
        "Bug-simulation fixture should produce out-of-window t values. "
        "If this assertion fails, the day-window guard isn't actually catching the bug."
    )


def test_fill_strength_prefers_fills_parquet(kis_live_fixture: Path) -> None:
    """fills.parquet이 있으면 trades.parquet 대신 fills 기준 집계를 반환한다.

    kis_live_fixture에는 이미 trades.parquet(side=1, qty=10, 3행 →
    버킷 [(10, 0) @09:00, (20, 0) @10:00])이 있다. 그 위에
    fills.parquet(buy 15/sell 5, ts=09:00:00) 1장을 추가로 쓴다.
    build_fill_strength_slice가 fills를 우선해야 하므로
    결과는 trades 기반 첫 버킷 (10, 0)이 아닌 fills 기반 (15, 5) 단일 포인트.
    """
    code_dir = kis_live_fixture / "parquet" / DATE / CODE / "kis_live"
    # Fill의 ts_ms는 HHMMSSmmm 인코딩 — 09:00:00.000 = 90000000
    fill = Fill(ts_ms=90000000, seq=1, buy_qty=15, sell_qty=5)
    write_fills_parquet([fill], code_dir / "fills.parquet")

    engine = QueryEngine(kis_live_fixture)
    fs = build_fill_strength_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    # fills 1장 → 정확히 1 포인트. trades(2버킷)와 concat-병합하는 구현이
    # 우연히 첫 버킷 검사를 통과하는 구멍을 점 개수로 차단.
    assert len(fs.points) == 1, (
        f"fills.parquet 1장은 정확히 1 포인트여야 함: got {len(fs.points)}"
    )
    buy_sell = [(p.buy_qty, p.sell_qty) for p in fs.points]
    # fills 기준: buy=15, sell=5 (trades 기준이면 첫 버킷 (10, 0)이 나온다)
    assert buy_sell[0] == (15, 5), (
        f"fills 우선 분기가 동작하지 않음: got {buy_sell}, expected first bucket (15, 5)"
    )


def test_fill_strength_falls_back_to_trades_when_no_fills(kis_live_fixture: Path) -> None:
    """fills.parquet이 없으면 trades.parquet 기반 집계로 폴백한다(회귀 가드).

    kis_live_fixture는 fills.parquet 없이 trades.parquet만 갖는다
    (side=1, qty=10 × [09:00:00, 10:00:00, 10:00:30] 3행).
    60초 버킷 집계의 정확값을 고정: 09:00 버킷 (10, 0), 10:00 버킷 (20, 0).
    """
    engine = QueryEngine(kis_live_fixture)
    fs = build_fill_strength_slice(
        engine, code=CODE, date=DATE, bucket_ms=60_000, source="kis_live",
    )
    assert [(p.buy_qty, p.sell_qty) for p in fs.points] == [(10, 0), (20, 0)], (
        "trades.parquet 폴백 집계가 기대값과 다름"
    )
    for p in fs.points:
        assert DAY_START <= p.t < DAY_END, (
            f"폴백 경로의 t={p.t}가 day window [{DAY_START}, {DAY_END}) 밖"
        )

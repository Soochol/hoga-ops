"""Stage 5 / Task 5.1 — Promotion tests.

Also includes Task 2 tests for _parse_jsonl_to_records helper + regression.
"""
import asyncio
import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import polars as pl
import pytest

from hoga.live.promote import _parse_jsonl_to_records


@pytest.mark.asyncio
async def test_promote_one_writes_parquet_and_meta(tmp_path: Path) -> None:
    from hoga.live.promote import promote_one

    live_root = tmp_path / "live"
    jsonl_path = live_root / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    # 2 cycles worth
    lines = []
    for tick in range(2):
        t = 1748332800000 + tick * 10_000
        lines.append(json.dumps({"t_ms": t, "kind": "ob", "payload": {
            "code": "005930", "t_ms": t,
            "asks": [{"price": 75000 + i, "qty": 100 + i} for i in range(10)],
            "bids": [{"price": 74990 - i, "qty": 200 + i} for i in range(10)],
            "total_ask_qty": 1500, "total_bid_qty": 2500, "phase": "regular",
        }}))
        lines.append(json.dumps({"t_ms": t, "kind": "trade", "payload": {
            "trades": [{"t_ms": t, "price": 75000, "qty": 5, "side": 1, "side_source": "inferred"}],
            "phase": "regular",
        }}))
        lines.append(json.dumps({"t_ms": t, "kind": "broker", "payload": {
            "code": "005930", "t_ms": t,
            "buy_top": [{"name": f"b{i}", "qty": i} for i in range(5)],
            "sell_top": [{"name": f"s{i}", "qty": i} for i in range(5)],
            "phase": "regular",
        }}))
    jsonl_path.write_text("\n".join(lines) + "\n")

    parquet_root = tmp_path / "parquet"
    await promote_one(jsonl_path, parquet_root, code="005930", date="20260527")

    target = parquet_root / "20260527" / "005930" / "kis_live"
    assert (target / "snapshots.parquet").exists()
    assert (target / "trades.parquet").exists()
    assert (target / "brokers.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["source"] == "kis_live"
    assert meta["code"] == "005930"
    assert meta["date"] == "20260527"
    assert meta["row_counts"] == {"snapshots": 2, "trades": 2, "brokers": 2}
    # ADR-0003 HHMMSSmmm session bounds — required so build_range_bundle can
    # compose RangeSegments from kis_live promoted Parquet without KeyError.
    # Discovered via /investigate 2026-05-28 against /api/range 003490 fallback.
    assert meta["regular_session_open_ms"] == 90000000
    assert meta["regular_session_close_ms"] == 153000000

    snaps = pl.read_parquet(target / "snapshots.parquet")
    assert snaps.height == 2
    assert "ask_p1" in snaps.columns and "bid_q10" in snaps.columns
    assert "total_ask_qty" in snaps.columns
    assert "phase" in snaps.columns

    trades = pl.read_parquet(target / "trades.parquet")
    assert trades.height == 2
    assert {"t_ms", "price", "qty", "side", "side_source"} <= set(trades.columns)
    assert trades["side"][0] == 1
    assert trades["side_source"][0] == "inferred"

    # Long-format schema matches hogaplay parser output so /api/brokers/series
    # (DuckDB on brokers.parquet) can read KIS-promoted parquets too.
    import duckdb

    from hoga.tables.brokers import query_day_series

    brokers = pl.read_parquet(target / "brokers.parquet")
    # 2 snapshots × (5 sell + 5 buy) = 20 long rows.
    assert brokers.height == 20
    assert set(brokers.columns) == {
        "ts_ms", "seq", "side", "rank", "broker", "qty_today", "qty_delta",
    }
    # meta still counts snapshots, not long rows — operator-meaningful metric.
    assert meta["row_counts"]["brokers"] == 2

    # The promoted parquet must be readable via query_day_series — this is the
    # bug the schema unification closes (kis_live previously stored a wide
    # schema that query_day_series can't read).
    entries = query_day_series(duckdb.connect(), path=target / "brokers.parquet")
    assert entries, "query_day_series must produce entries from KIS-promoted parquet"


@pytest.mark.asyncio
async def test_promote_idempotent_skips_if_meta_exists(tmp_path: Path) -> None:
    from hoga.live.promote import promote_one

    parquet_root = tmp_path / "parquet"
    target = parquet_root / "20260527" / "005930" / "kis_live"
    target.mkdir(parents=True)
    (target / "meta.json").write_text(
        json.dumps({"source": "kis_live", "code": "005930", "preserved": True})
    )

    live_root = tmp_path / "live"
    jsonl_path = live_root / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    jsonl_path.write_text(json.dumps({"t_ms": 1, "kind": "ob", "payload": {}}) + "\n")

    await promote_one(jsonl_path, parquet_root, code="005930", date="20260527")

    meta = json.loads((target / "meta.json").read_text())
    assert meta.get("preserved") is True  # not overwritten
    assert not (target / "snapshots.parquet").exists()


@pytest.mark.asyncio
async def test_promote_tolerates_partial_last_line(tmp_path: Path) -> None:
    """ADR-0038: a torn last line from a crash is silently dropped."""
    from hoga.live.promote import promote_one

    jsonl_path = tmp_path / "live" / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    full = json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {
            "asks": [{"price": 1, "qty": 1}] * 10,
            "bids": [{"price": 1, "qty": 1}] * 10,
            "code": "005930", "t_ms": 1,
            "total_ask_qty": 10, "total_bid_qty": 10,
            "phase": "regular",
        },
    })
    jsonl_path.write_text(full + '\n{"t_ms": 2, "kind":')  # truncated last line

    await promote_one(jsonl_path, tmp_path / "parquet", code="005930", date="20260527")
    snaps = pl.read_parquet(
        tmp_path / "parquet" / "20260527" / "005930" / "kis_live" / "snapshots.parquet"
    )
    assert snaps.height == 1  # partial line discarded


@pytest.mark.asyncio
async def test_promote_missing_jsonl_is_noop(tmp_path: Path) -> None:
    """Missing JSONL doesn't error — just no-op."""
    from hoga.live.promote import promote_one

    await promote_one(
        tmp_path / "live" / "20260527" / "999999.jsonl",
        tmp_path / "parquet",
        code="999999",
        date="20260527",
    )
    # No parquet, no meta created
    assert not (tmp_path / "parquet" / "20260527" / "999999").exists()


@pytest.mark.asyncio
async def test_promote_pending_walks_live_root_and_archives(tmp_path: Path) -> None:
    from hoga.live.promote import promote_pending

    live_root = tmp_path / "live"
    for code in ("005930", "000660"):
        jsonl = live_root / "20260527" / f"{code}.jsonl"
        jsonl.parent.mkdir(parents=True, exist_ok=True)
        jsonl.write_text(json.dumps({
            "t_ms": 1, "kind": "ob",
            "payload": {
                "asks": [], "bids": [], "code": code, "t_ms": 1,
                "total_ask_qty": 0, "total_bid_qty": 0, "phase": "regular",
            },
        }) + "\n")

    await promote_pending(tmp_path)

    parquet_root = tmp_path / "parquet"
    for code in ("005930", "000660"):
        assert (parquet_root / "20260527" / code / "kis_live" / "meta.json").exists()
        # archive movement
        assert (live_root / "_archive" / "20260527" / f"{code}.jsonl").exists()
        assert not (live_root / "20260527" / f"{code}.jsonl").exists()


@pytest.mark.asyncio
async def test_promote_pending_skips_archive_directory(tmp_path: Path) -> None:
    """The _archive subdir under live_root must NOT be traversed."""
    from hoga.live.promote import promote_pending

    live_root = tmp_path / "live"
    archive_jsonl = live_root / "_archive" / "20260101" / "001234.jsonl"
    archive_jsonl.parent.mkdir(parents=True)
    archive_jsonl.write_text("ignored")

    await promote_pending(tmp_path)
    # Archive must remain untouched and no parquet generated from it
    assert archive_jsonl.exists()
    assert not (tmp_path / "parquet" / "20260101" / "001234").exists()


@pytest.mark.asyncio
async def test_archive_cleanup_removes_files_older_than_7d(tmp_path: Path) -> None:
    from hoga.live.promote import cleanup_archive

    old_path = tmp_path / "live" / "_archive" / "20260101" / "005930.jsonl"
    old_path.parent.mkdir(parents=True)
    old_path.write_text("old")
    eight_days_ago = time.time() - 8 * 86400
    os.utime(old_path, (eight_days_ago, eight_days_ago))

    recent_path = tmp_path / "live" / "_archive" / "20260520" / "000660.jsonl"
    recent_path.parent.mkdir(parents=True)
    recent_path.write_text("recent")

    await cleanup_archive(tmp_path, retention_days=7)

    assert not old_path.exists()
    assert recent_path.exists()


@pytest.mark.asyncio
async def test_cleanup_archive_noop_when_dir_missing(tmp_path: Path) -> None:
    from hoga.live.promote import cleanup_archive
    # Should not raise
    await cleanup_archive(tmp_path)


# ---------------------------------------------------------------------------
# Task 2: _parse_jsonl_to_records helper tests
# ---------------------------------------------------------------------------

def test_parse_jsonl_to_records_basic(tmp_path: Path) -> None:
    jsonl = tmp_path / "in.jsonl"
    rows = [
        {"t_ms": 1, "kind": "ob", "payload": {
            "bids": [{"price": 26800, "qty": 879}],
            "asks": [{"price": 26850, "qty": 6141}],
            "total_bid_qty": 95085, "total_ask_qty": 102768,
        }},
        {"t_ms": 2, "kind": "trade", "payload": {
            "trades": [{"t_ms": 2, "price": 26850, "qty": 10, "side": 1}],
            "phase": "regular",
        }},
        {"t_ms": 3, "kind": "broker", "payload": {
            "buy_top": [{"name": "키움", "qty": 100}],
            "sell_top": [{"name": "신한", "qty": 50}],
        }},
    ]
    jsonl.write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
        jsonl, code="003490", date="20260528",
    )

    assert len(snapshots) == 1
    assert snapshots[0]["bid_p1"] == 26800
    assert snapshots[0]["total_bid_qty"] == 95085
    assert len(trades) == 1
    assert trades[0]["price"] == 26850
    assert len(broker_rows) == 2  # 1 buy + 1 sell
    assert meta["source"] == "kis_live"
    assert meta["code"] == "003490"
    assert meta["row_counts"]["snapshots"] == 1
    assert meta["row_counts"]["trades"] == 1
    assert meta["row_counts"]["brokers"] == 1  # snapshot count, not row count


def test_parse_jsonl_to_records_skips_torn_line(tmp_path: Path, caplog) -> None:
    jsonl = tmp_path / "in.jsonl"
    good = json.dumps({"t_ms": 1, "kind": "ob", "payload": {
        "bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0,
    }})
    jsonl.write_text(good + "\n{ malformed\n")

    with caplog.at_level("WARNING"):
        snapshots, _, _, meta = _parse_jsonl_to_records(
            jsonl, code="003490", date="20260528",
        )

    assert len(snapshots) == 1
    assert any("partial_line" in r.message for r in caplog.records)


def test_promote_one_archive_move_regression(tmp_path: Path) -> None:
    """eng-review Suggestion #6 — promote_one refactor 후에도 archive 이동 유지."""
    from hoga.live.promote import promote_pending

    kst = timezone(timedelta(hours=9))
    yesterday = (datetime.now(kst) - timedelta(days=1)).strftime("%Y%m%d")
    jsonl = tmp_path / "live" / yesterday / "003490.jsonl"
    jsonl.parent.mkdir(parents=True, exist_ok=True)
    jsonl.write_text(json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    asyncio.run(promote_pending(tmp_path))

    # parquet 생성
    assert (tmp_path / "parquet" / yesterday / "003490" / "kis_live" / "meta.json").exists()
    # archive 이동 — 핵심 회귀
    assert not jsonl.exists()
    assert (tmp_path / "live" / "_archive" / yesterday / "003490.jsonl").exists()


@pytest.mark.asyncio
async def test_promote_pending_skips_today(tmp_path: Path) -> None:
    """ADR-0043 invariant — promote_pending은 오늘 날짜를 건드리지 않음.

    오늘 jsonl이 archive로 옮겨지면 Today Promotion이 빈 jsonl을 만지게 됨.
    """
    from hoga.live.promote import promote_pending

    kst = timezone(timedelta(hours=9))
    today = datetime.now(kst).strftime("%Y%m%d")
    yesterday = (datetime.now(kst) - timedelta(days=1)).strftime("%Y%m%d")

    # 오늘 jsonl (skip 대상)
    today_jsonl = tmp_path / "live" / today / "003490.jsonl"
    today_jsonl.parent.mkdir(parents=True, exist_ok=True)
    today_jsonl.write_text(json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    # 어제 jsonl (정상 promote 대상)
    yesterday_jsonl = tmp_path / "live" / yesterday / "003490.jsonl"
    yesterday_jsonl.parent.mkdir(parents=True, exist_ok=True)
    yesterday_jsonl.write_text(json.dumps({
        "t_ms": 1, "kind": "ob",
        "payload": {"bids": [], "asks": [], "total_bid_qty": 0, "total_ask_qty": 0},
    }) + "\n")

    await promote_pending(tmp_path)

    # 오늘은 live/에 그대로
    assert today_jsonl.exists()
    assert not (tmp_path / "live" / "_archive" / today / "003490.jsonl").exists()
    # 오늘 parquet도 안 만들어짐 (promote_pending이 건드리지 않음)
    assert not (tmp_path / "parquet" / today / "003490" / "kis_live").exists()

    # 어제는 archive로 이동 + parquet 생성
    assert not yesterday_jsonl.exists()
    assert (tmp_path / "live" / "_archive" / yesterday / "003490.jsonl").exists()
    assert (tmp_path / "parquet" / yesterday / "003490" / "kis_live" / "meta.json").exists()

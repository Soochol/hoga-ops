"""Stage 5 / Task 5.1 — Promotion tests."""
import json
import os
import time
from pathlib import Path

import polars as pl
import pytest


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

    brokers = pl.read_parquet(target / "brokers.parquet")
    assert brokers.height == 2
    for prefix in ("buy_name", "buy_qty", "sell_name", "sell_qty"):
        for i in range(1, 6):
            assert f"{prefix}{i}" in brokers.columns


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

"""Live Capture JSONL → captures Parquet conversion (ADR-0038 cold path).

This module IS allowed to import polars/pyarrow — it's the cold-path
converter that runs at 18:00 KST after Live Session ends, not the hot
write path. The hot path (writer.py, poller.py) must stay polars-free.

Idempotency: presence of {target}/meta.json marks this (date, code) as
already promoted; subsequent calls skip silently.

Partial-line tolerance: a JSONL line that fails to parse is logged and
skipped. This handles the case where a crash mid-cycle left a torn last
line on disk — per ADR-0038 the rest of the file is still recoverable.
"""
from __future__ import annotations

import json
import logging
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

_log = logging.getLogger(__name__)


async def promote_one(
    jsonl_path: Path,
    parquet_root: Path,
    *,
    code: str,
    date: str,
) -> None:
    """Convert one JSONL file to Parquet artifacts under `parquet/{date}/{code}/kis_live/`.

    Idempotent: if `meta.json` already exists at the target, skip.
    """
    target = parquet_root / date / code / "kis_live"
    meta_path = target / "meta.json"
    if meta_path.exists():
        _log.info(
            "live.promote.skip code=%s date=%s reason=already_promoted", code, date
        )
        return

    if not jsonl_path.exists():
        return

    snapshots: list[dict] = []
    trades: list[dict] = []
    brokers: list[dict] = []

    with jsonl_path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                # Torn last line from a crash mid-cycle — drop silently.
                _log.warning(
                    "live.promote.partial_line code=%s date=%s", code, date
                )
                continue
            kind = row.get("kind")
            t_ms = row.get("t_ms")
            p = row.get("payload") or {}
            phase = p.get("phase", "regular")
            if kind == "ob":
                bids = p.get("bids") or []
                asks = p.get("asks") or []
                snap: dict = {"t_ms": t_ms, "phase": phase}
                for i in range(10):
                    snap[f"bid_p{i + 1}"] = bids[i]["price"] if i < len(bids) else 0
                    snap[f"bid_q{i + 1}"] = bids[i]["qty"] if i < len(bids) else 0
                    snap[f"ask_p{i + 1}"] = asks[i]["price"] if i < len(asks) else 0
                    snap[f"ask_q{i + 1}"] = asks[i]["qty"] if i < len(asks) else 0
                snap["total_bid_qty"] = p.get("total_bid_qty", 0)
                snap["total_ask_qty"] = p.get("total_ask_qty", 0)
                snapshots.append(snap)
            elif kind == "trade":
                for tr in p.get("trades") or []:
                    trades.append({
                        "t_ms": tr.get("t_ms"),
                        "price": tr.get("price"),
                        "qty": tr.get("qty"),
                        "side": tr.get("side"),
                        "side_source": tr.get("side_source", "inferred"),
                        "phase": phase,
                    })
            elif kind == "broker":
                buy = p.get("buy_top") or []
                sell = p.get("sell_top") or []
                broker_row: dict = {"t_ms": t_ms, "phase": phase}
                for i in range(5):
                    broker_row[f"buy_name{i + 1}"] = buy[i]["name"] if i < len(buy) else ""
                    broker_row[f"buy_qty{i + 1}"] = buy[i]["qty"] if i < len(buy) else 0
                    broker_row[f"sell_name{i + 1}"] = sell[i]["name"] if i < len(sell) else ""
                    broker_row[f"sell_qty{i + 1}"] = sell[i]["qty"] if i < len(sell) else 0
                brokers.append(broker_row)

    target.mkdir(parents=True, exist_ok=True)
    if snapshots:
        pl.DataFrame(snapshots).write_parquet(target / "snapshots.parquet")
    if trades:
        pl.DataFrame(trades).write_parquet(target / "trades.parquet")
    if brokers:
        pl.DataFrame(brokers).write_parquet(target / "brokers.parquet")

    meta = {
        "source": "kis_live",
        "code": code,
        "date": date,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "row_counts": {
            "snapshots": len(snapshots),
            "trades": len(trades),
            "brokers": len(brokers),
        },
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    _log.info(
        "live.promote.done code=%s date=%s row_counts=%s",
        code, date, meta["row_counts"],
    )


async def promote_pending(data_dir: Path) -> None:
    """Walk `<data_dir>/live/{date}/*.jsonl` and promote each, then archive.

    Skipped entries:
    - `_archive/` subdirectory (we don't re-promote our own backup).
    - Non-jsonl files.
    - (date, code) pairs already promoted (handled by promote_one's idempotency).
    """
    live_root = data_dir / "live"
    archive_root = live_root / "_archive"
    parquet_root = data_dir / "parquet"
    if not live_root.exists():
        return
    for date_dir in live_root.iterdir():
        if not date_dir.is_dir() or date_dir.name == "_archive":
            continue
        for jsonl in date_dir.iterdir():
            if jsonl.suffix != ".jsonl" or not jsonl.is_file():
                continue
            code = jsonl.stem
            await promote_one(jsonl, parquet_root, code=code, date=date_dir.name)
            arch_target = archive_root / date_dir.name / jsonl.name
            arch_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(jsonl), str(arch_target))


async def cleanup_archive(data_dir: Path, retention_days: int = 7) -> None:
    """Remove archived JSONL files older than `retention_days`.

    Called by Daily Scheduler at 18:00 KST after promote_pending. Keeps the
    `_archive` tree from growing unbounded.
    """
    archive_root = data_dir / "live" / "_archive"
    if not archive_root.exists():
        return
    cutoff = time.time() - retention_days * 86400
    for path in archive_root.rglob("*.jsonl"):
        if path.stat().st_mtime < cutoff:
            path.unlink()

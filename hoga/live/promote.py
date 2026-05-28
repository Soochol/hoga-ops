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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl

from hoga.tables.brokers import BrokerRow, write_parquet as write_brokers_parquet

_log = logging.getLogger(__name__)


def _parse_jsonl_to_records(
    jsonl_path: Path,
    *,
    code: str,
    date: str,
) -> tuple[list[dict], list[dict], list[BrokerRow], dict]:
    """Parse one Live Capture JSONL into (snapshots, trades, broker_rows, meta) tuples.

    Shared by promote_one (ADR-0038 daily batch) and promote_today
    (ADR-0043 in-session N-minute overwrite). Torn last lines are skipped
    with a `live.promote.partial_line` warn log.

    `meta` is the JSON dict ready to write to meta.json — caller decides
    when/how to persist it.

    If `jsonl_path` does not exist, returns empty lists and meta with
    row_counts=0.
    """
    snapshots: list[dict] = []
    trades: list[dict] = []
    broker_rows: list[BrokerRow] = []
    broker_snapshot_count = 0
    broker_seq = 0  # monotonic per stock-date; KIS has no native seq.

    if not jsonl_path.exists():
        meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count)
        return snapshots, trades, broker_rows, meta

    with jsonl_path.open("r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
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
                broker_snapshot_count += 1
                broker_seq += 1
                for rank, e in enumerate(sell[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=int(t_ms),
                        seq=broker_seq,
                        side="sell",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))
                for rank, e in enumerate(buy[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=int(t_ms),
                        seq=broker_seq,
                        side="buy",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))

    meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count)
    return snapshots, trades, broker_rows, meta


def _build_meta(
    code: str, date: str, snapshots: list, trades: list, broker_snapshot_count: int,
) -> dict:
    return {
        "source": "kis_live",
        "code": code,
        "date": date,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "row_counts": {
            "snapshots": len(snapshots),
            "trades": len(trades),
            "brokers": broker_snapshot_count,
        },
        # ADR-0003 HHMMSSmmm encoding.
        "regular_session_open_ms": 90000000,    # 09:00:00.000
        "regular_session_close_ms": 153000000,  # 15:30:00.000
    }


def _today_kst_yyyymmdd() -> str:
    """오늘 날짜 YYYYMMDD KST."""
    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


async def promote_today(data_dir: Path, *, code: str) -> None:
    """ADR-0043 Today Promotion — overwrite, no archive move.

    promote_one과 다른 점:
      - idempotent skip 안 함 (meta.json 있어도 다시 처리)
      - archive 이동 안 함 (jsonl 계속 polling 중)
      - parquet 파일들은 atomic_write_parquet으로 원자 교체

    Midnight race protection (eng-review Blocker 1):
      - today_kst를 함수 진입 시점에 한 번만 evaluate.
      - 그 시점 이후 자정이 지나도 이 사이클은 "yesterday" jsonl을 처리.
      - 다음 사이클(5분 후)이 새 today_kst를 picking → 어제는 Daily Promotion 담당.

    Candles invariant (ADR-0040): snapshots/trades/brokers.parquet만 생성.
    candles는 Live Candle Backfill의 별도 캐시가 담당하므로 절대 생성하지 않는다.
    """
    from hoga.api._atomic_write import atomic_write_parquet, atomic_write_json

    # CRITICAL: today_kst를 한 번만 evaluate해서 자정 race 회피
    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live" / today / f"{code}.jsonl"
    parquet_root = data_dir / "parquet"
    target = parquet_root / today / code / "kis_live"

    if not jsonl_path.exists():
        return

    start_ms = int(time.time() * 1000)
    _log.info("live.today_promote.start code=%s date=%s", code, today)

    try:
        snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
            jsonl_path, code=code, date=today,
        )
    except Exception:
        _log.exception(
            "live.today_promote.parse_failed code=%s date=%s", code, today,
        )
        raise

    target.mkdir(parents=True, exist_ok=True)
    try:
        atomic_write_parquet(target / "snapshots.parquet", snapshots)
        atomic_write_parquet(target / "trades.parquet", trades)
        # brokers는 BrokerRow dataclass 리스트 → dict 리스트로 변환
        atomic_write_parquet(
            target / "brokers.parquet",
            [
                {
                    "ts_ms": r.ts_ms, "seq": r.seq, "side": r.side,
                    "rank": r.rank, "broker": r.broker,
                    "qty_today": r.qty_today, "qty_delta": r.qty_delta,
                }
                for r in broker_rows
            ],
        )
        atomic_write_json(target / "meta.json", meta, indent=2)
    except OSError as e:
        _log.warning(
            "live.today_promote.write_failed code=%s date=%s reason=%s",
            code, today, e,
        )
        raise

    elapsed = int(time.time() * 1000) - start_ms
    _log.info(
        "live.today_promote.done code=%s date=%s row_counts=%s elapsed_ms=%d",
        code, today, meta["row_counts"], elapsed,
    )

    # design-review B2 — 사용자가 /api/live/status에서 마지막 promote 시각 확인 가능
    # Task 5에서 lifecycle.record_today_promote_success가 추가되면 작동.
    # 그 전엔 ImportError fallback으로 noop.
    try:
        from hoga.live import lifecycle
        record_fn = getattr(lifecycle, "record_today_promote_success", None)
        if record_fn is not None:
            record_fn(code, int(time.time() * 1000))
    except ImportError:
        pass


async def promote_one(
    jsonl_path: Path,
    parquet_root: Path,
    *,
    code: str,
    date: str,
) -> None:
    """Convert one JSONL file to Parquet artifacts under `parquet/{date}/{code}/kis_live/`.

    Idempotent: if `meta.json` already exists at the target, skip.
    See ADR-0038 (deferred batch promotion) and ADR-0043 (sister Today
    Promotion that this helper coexists with).
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

    snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
        jsonl_path, code=code, date=date,
    )

    target.mkdir(parents=True, exist_ok=True)
    if snapshots:
        pl.DataFrame(snapshots).write_parquet(target / "snapshots.parquet")
    if trades:
        pl.DataFrame(trades).write_parquet(target / "trades.parquet")
    if broker_rows:
        write_brokers_parquet(broker_rows, target / "brokers.parquet")
    meta_path.write_text(json.dumps(meta, indent=2))
    _log.info(
        "live.promote.done code=%s date=%s row_counts=%s",
        code, date, meta["row_counts"],
    )


async def promote_pending(data_dir: Path) -> None:
    """Walk `<data_dir>/live/{date}/*.jsonl` and promote each, then archive.

    Skipped entries:
    - `_archive/` subdirectory (we don't re-promote our own backup).
    - **Today's date** — owned by Today Promotion (ADR-0043). Skipping prevents
      archive-move from racing the still-appending jsonl writer.
    - Non-jsonl files.
    - (date, code) pairs already promoted (handled by promote_one's idempotency).
    """
    today = _today_kst_yyyymmdd()
    live_root = data_dir / "live"
    archive_root = live_root / "_archive"
    parquet_root = data_dir / "parquet"
    if not live_root.exists():
        return
    for date_dir in live_root.iterdir():
        if not date_dir.is_dir() or date_dir.name == "_archive":
            continue
        if date_dir.name == today:  # ADR-0043 — owned by Today Promotion
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

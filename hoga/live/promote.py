"""Live Capture JSONL → captures Parquet conversion (ADR-0038 cold path).

This module IS allowed to import polars/pyarrow — it's the cold-path
converter that runs at 17:00 KST after Live Session ends, not the hot
write path. The hot path (writer.py, stream.py) must stay polars-free.

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
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

from hoga.api.timeenc import unix_ms_to_hhmmssms
from hoga.tables.brokers import BrokerRow
from hoga.tables.brokers import write_parquet as write_brokers_parquet
from hoga.tables.fills import Fill, write_fills_parquet
from hoga.tables.snapshots import Orderbook
from hoga.tables.snapshots import write_parquet as write_snapshots_parquet
from hoga.tables.trades import Trade
from hoga.tables.trades import write_parquet as write_trades_parquet

_ZERO_LEVELS: tuple[int, ...] = (0,) * 10

_log = logging.getLogger(__name__)


def _atomic_write_table(writer, records, path: Path) -> None:
    """Bridge: call the canonical table writer if non-empty, else unlink.

    ADR-0043 today_promoter's contract is "no records → no file" (DuckDB
    chokes on zero-row parquet in some configs; readers handle missing
    file via FileNotFoundError, which is the standard pattern). The
    canonical writers always emit a row group, so apply the unlink-on-
    empty policy at this seam instead of inside the table modules.
    """
    if records:
        writer(records, path)
    else:
        path.unlink(missing_ok=True)


def _parse_jsonl_to_records(  # noqa: PLR0912, PLR0915
    jsonl_path: Path,
    *,
    code: str,
    date: str,
) -> tuple[list[Orderbook], list[Trade], list[BrokerRow], list[Fill], dict]:
    """Parse one Live Capture JSONL into typed table records + meta.

    Shared by promote_one (ADR-0038 daily batch) and promote_today
    (ADR-0043 in-session N-minute overwrite). Torn last lines are skipped
    with a `live.promote.partial_line` warn log.

    Returns canonical dataclasses (Orderbook / Trade / BrokerRow / Fill), not
    dicts — the table writers enforce PARQUET_SCHEMA at construction time,
    so a missing column or wrong dtype fails fast here instead of as a
    DuckDB BinderException in a downstream reader.

    KIS REST doesn't carry hogaplay's forensic fields (depth deltas,
    cum_vol, change_pct, unknown_*); they are synthesized as 0 / 0.0 so
    the wire schema stays uniform across sources (ADR-0049).

    `meta` is the JSON dict ready to write to meta.json — caller decides
    when/how to persist it. If `jsonl_path` does not exist, returns empty
    lists and meta with row_counts=0.
    """
    snapshots: list[Orderbook] = []
    trades: list[Trade] = []
    broker_rows: list[BrokerRow] = []
    fills: list[Fill] = []
    broker_snapshot_count = 0
    # Monotonic per stock-date counters; KIS has no native seq, but the
    # parquet schemas (snapshots/trades/brokers/fills) require an int seq column
    # so readers (snapshots.query_at, trades selectors) can SELECT it
    # without DuckDB BinderException. Each `kind` gets its own counter so
    # ts_ms-collision tie-breaks are unambiguous within a kind.
    # fills의 seq는 reader가 없고 스키마 균일성 목적(PARQUET_SCHEMA 일관성 유지).
    snap_seq = 0
    trade_seq = 0
    broker_seq = 0
    fill_seq = 0

    if not jsonl_path.exists():
        meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count, fill_count=0)
        return snapshots, trades, broker_rows, fills, meta

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
            t_ms_raw = row.get("t_ms")
            # ADR-0049: convert Unix ms → HHMMSSmmm so the on-disk `ts_ms`
            # column honors the ADR-0010 invariant (series-builder SQL
            # decodes ts_ms as HHMMSSmmm via hhmmssms_to_intra_ms_sql).
            try:
                t_ms_int = int(t_ms_raw)
            except (TypeError, ValueError):
                _log.warning(
                    "live.promote.malformed_t_ms_skip code=%s date=%s t_ms_raw=%r",
                    code, date, t_ms_raw,
                )
                continue
            try:
                ts_ms_encoded = unix_ms_to_hhmmssms(date, t_ms_int)
            except ValueError:
                _log.warning(
                    "live.promote.midnight_race_skip code=%s date=%s t_ms=%d",
                    code, date, t_ms_int,
                )
                continue
            p = row.get("payload") or {}
            # `phase` ("regular" / "premarket" / "afterhours") is preserved in
            # the JSONL forensic record but not in canonical parquet — no
            # downstream reader queries it. If a future use case needs it,
            # extend Orderbook/Trade dataclasses and PARQUET_SCHEMA.
            if kind == "ob":
                bids = p.get("bids") or []
                asks = p.get("asks") or []
                # ADR-0010 invariant: parquet `ts_ms` column = HHMMSSmmm packed-decimal.
                # ADR-0049: kis_live writer converts JSONL's Unix-ms `t_ms` to
                # HHMMSSmmm at promote time so reader-side decoding is source-uniform.
                # Forensic columns (ask_d/bid_d/tot_*_d) — KIS REST is delta-free.
                snap_seq += 1
                snapshots.append(Orderbook(
                    ts_ms=ts_ms_encoded,
                    seq=snap_seq,
                    ask_p=tuple(asks[i]["price"] if i < len(asks) else 0 for i in range(10)),
                    ask_q=tuple(asks[i]["qty"] if i < len(asks) else 0 for i in range(10)),
                    ask_d=_ZERO_LEVELS,
                    bid_p=tuple(bids[i]["price"] if i < len(bids) else 0 for i in range(10)),
                    bid_q=tuple(bids[i]["qty"] if i < len(bids) else 0 for i in range(10)),
                    bid_d=_ZERO_LEVELS,
                    tot_ask=int(p.get("total_ask_qty") or 0),
                    tot_ask_d=0,
                    tot_bid=int(p.get("total_bid_qty") or 0),
                    tot_bid_d=0,
                ))
            elif kind == "trade":
                for tr in p.get("trades") or []:
                    # Inner trade's t_ms can drift micro-seconds from the outer tick.
                    # Use the outer ts_ms_encoded so the entire row's encoding is uniform
                    # per cycle. If inner-vs-outer divergence ever matters, revisit at that
                    # signal. Forensic / cumulative fields (change_pct, cum_vol,
                    # cum_trades, low/high_so_far, net_pressure, unknown_*) are
                    # hogaplay-TSV-only — synthesize zero so the canonical schema
                    # stays uniform across sources.
                    trade_seq += 1
                    trades.append(Trade(
                        ts_ms=ts_ms_encoded,
                        seq=trade_seq,
                        price=int(tr.get("price") or 0),
                        change_pct=0.0,
                        qty=int(tr.get("qty") or 0),
                        side=int(tr.get("side") or 0),
                        cum_vol=0,
                        cum_trades=0,
                        low_so_far=0,
                        high_so_far=0,
                        net_pressure=0,
                        unknown_14=0,
                        unknown_16=0.0,
                        unknown_17=0.0,
                        unknown_18=0.0,
                    ))
            elif kind == "broker":
                buy = p.get("buy_top") or []
                sell = p.get("sell_top") or []
                broker_snapshot_count += 1
                broker_seq += 1
                for rank, e in enumerate(sell[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=ts_ms_encoded,
                        seq=broker_seq,
                        side="sell",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))
                for rank, e in enumerate(buy[:5], start=1):
                    broker_rows.append(BrokerRow(
                        ts_ms=ts_ms_encoded,
                        seq=broker_seq,
                        side="buy",
                        rank=rank,
                        broker=str(e.get("name") or ""),
                        qty_today=int(e.get("qty") or 0),
                        qty_delta=0,
                    ))
            elif kind == "fill":
                # 그릴링 Q4: 10초 체결강도 구간합 → fills.parquet.
                # side 분류는 다운샘플러가 write-time에 적용 완료(±1만, side=0 제외).
                fill_seq += 1
                fills.append(Fill(
                    ts_ms=ts_ms_encoded,
                    seq=fill_seq,
                    buy_qty=int(p.get("buy_qty") or 0),
                    sell_qty=int(p.get("sell_qty") or 0),
                ))

    meta = _build_meta(code, date, snapshots, trades, broker_snapshot_count, fill_count=len(fills))
    return snapshots, trades, broker_rows, fills, meta


def _build_meta(
    code: str, date: str, snapshots: list, trades: list, broker_snapshot_count: int,
    fill_count: int = 0,
) -> dict:
    return {
        "source": "kis_live",
        "code": code,
        "date": date,
        "promoted_at": datetime.now(UTC).isoformat(),
        "row_counts": {
            "snapshots": len(snapshots),
            "trades": len(trades),
            "brokers": broker_snapshot_count,
            "fills": fill_count,
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

    Candles invariant (ADR-0040): snapshots/trades/brokers/fills.parquet만 생성.
    candles는 Live Candle Backfill의 별도 캐시가 담당하므로 절대 생성하지 않는다.
    """
    from hoga.api._atomic_write import atomic_write_json

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
        snapshots, trades, broker_rows, fills, meta = _parse_jsonl_to_records(
            jsonl_path, code=code, date=today,
        )
    except Exception:
        _log.exception(
            "live.today_promote.parse_failed code=%s date=%s", code, today,
        )
        raise

    target.mkdir(parents=True, exist_ok=True)
    try:
        _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
        _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
        _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
        _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
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

    snapshots, trades, broker_rows, fills, meta = _parse_jsonl_to_records(
        jsonl_path, code=code, date=date,
    )

    target.mkdir(parents=True, exist_ok=True)
    _atomic_write_table(write_snapshots_parquet, snapshots, target / "snapshots.parquet")
    _atomic_write_table(write_trades_parquet, trades, target / "trades.parquet")
    _atomic_write_table(write_brokers_parquet, broker_rows, target / "brokers.parquet")
    _atomic_write_table(write_fills_parquet, fills, target / "fills.parquet")
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

    Called by Daily Scheduler at 17:00 KST after promote_pending. Keeps the
    `_archive` tree from growing unbounded.
    """
    archive_root = data_dir / "live" / "_archive"
    if not archive_root.exists():
        return
    cutoff = time.time() - retention_days * 86400
    for path in archive_root.rglob("*.jsonl"):
        if path.stat().st_mtime < cutoff:
            path.unlink()

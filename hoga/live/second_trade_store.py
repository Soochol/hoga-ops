"""Bounded live seconds and an append-only, replayable observed-trade journal.

One journal record includes OHLC and price quantities. Full bucket revisions
make retry after an uncertain append idempotent. Late trades have receive IDs.
Parquet publication is cold-path and publishes both projections by manifest.
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import logging
import os
import re
import shutil
import time
import uuid
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Any

from hoga.util.timeenc import KST

from .second_trade_agg import SecondTradeBar, valid_trades
from .ticks import WsTick

_log = logging.getLogger(__name__)
RETAIN_MS = 60_000
MAX_CELLS = 200_000
CACHE_LIMIT = 4


def trade_date(t_ms: int) -> str:
    from datetime import datetime  # noqa: PLC0415

    return datetime.fromtimestamp(t_ms / 1000, KST).strftime("%Y%m%d")


class SecondTradeStore:
    def __init__(self, root: Path, *, max_cells: int = MAX_CELLS) -> None:
        self.root = root
        self._bars: dict[tuple[str, str, int], SecondTradeBar] = {}
        self._saved: dict[tuple[str, str, int], int] = {}
        self._late: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        self._seq = time.time_ns()
        self._cells = 0
        self._max_cells = max_cells
        self._sealed_before = int(time.time() * 1000) - RETAIN_MS
        self._flush_lock = asyncio.Lock()
        self._cache: dict[Path, tuple[int, dict[int, dict[str, Any]]]] = {}
        self._cache_lock = RLock()
        self._late_count = 0
        self._prepared: set[tuple[str, str]] = set()
        self._failed_recovery: set[tuple[str, str, str]] = set()
        self.storage_error: str | None = None

    def path(self, code: str, venue: str, date: str) -> Path:
        return self.root / date / venue / f"{code}.jsonl"

    async def prepare(self, codes: list[str]) -> None:
        """Recover recent revisions before subscribing; disk reads stay off ingest."""
        now = int(time.time() * 1000)
        date = trade_date(now)
        self._prepared = {key for key in self._prepared if key[1] == date}
        self._failed_recovery = {key for key in self._failed_recovery if key[2] == date}
        for code in codes:
            if (code, date) in self._prepared:
                continue
            for venue in ("KRX", "NXT", "UN"):
                path = self.path(code, venue, date)
                try:
                    rows, receive_seq = await asyncio.to_thread(self._read_recent, path, now - RETAIN_MS)
                except OSError:
                    # An optional seconds store must not prevent legacy WS capture.
                    self.storage_error = "second_trade_recovery_error"
                    self._failed_recovery.add((code, venue, date))
                    _log.exception("second_trade.recovery_failed code=%s venue=%s", code, venue)
                    continue
                self._seq = max(self._seq, receive_seq)
                for row in rows:
                    key = (code, venue, row["t_ms"])
                    if key in self._bars:
                        continue
                    bar = SecondTradeBar.restore(row)
                    if self._cells + self._late_count + len(bar.prices) > self._max_cells:
                        # Never overwrite an un-restored durable revision with
                        # a fresh partial bucket after exhausting recovery space.
                        self.storage_error = "second_trade_queue_full"
                        self._failed_recovery.add((code, venue, date))
                        break
                    self._bars[key] = bar
                    self._saved[key] = bar.revision
                    self._cells += len(bar.prices)
                    self._seq = max(self._seq, bar.last[1], bar.first[1], bar.applied_late_seq)
            self._prepared.add((code, date))

    @staticmethod
    def _read_recent(path: Path, since: int) -> tuple[list[dict[str, Any]], int]:
        if not path.exists():
            return [], 0
        checkpoint = path.with_suffix(".recent.json")
        try:
            saved = json.loads(checkpoint.read_text(encoding="utf-8"))
            offset = saved["journal_bytes"]
            receive_seq = saved.get("receive_seq", 0)
            initial = {row["t_ms"]: row for row in saved["bars"]}
            if offset > path.stat().st_size:
                raise ValueError("checkpoint exceeds journal")
        except (OSError, ValueError, KeyError, TypeError):
            offset, initial, receive_seq = 0, {}, 0
        rows = SecondTradeStore._replay(path, initial=initial, offset=offset)
        for row in rows.values():
            receive_seq = max(receive_seq, row["first"][1], row["last"][1], row.get("applied_late_seq", 0))
        return [row for row in rows.values() if row["t_ms"] >= since], receive_seq

    def ingest(self, tick: WsTick) -> None:
        for trade in valid_trades(tick):
            if self._failed_recovery and (tick.code, tick.venue, trade_date(trade["t_ms"])) in self._failed_recovery:
                continue
            self._seq += 1
            t = trade["t_ms"] // 1000 * 1000
            key = (tick.code, tick.venue, t)
            bar = self._bars.get(key)
            if bar is None and t < self._sealed_before:
                journal_key = (tick.code, tick.venue, trade_date(t))
                pending = self._late.setdefault(journal_key, [])
                if self._late_count + self._cells >= self._max_cells:
                    self.storage_error = "second_trade_queue_full"
                    continue
                pending.append({"kind": "late", "seq": self._seq, "trade": trade})
                self._late_count += 1
                continue
            new_cell = bar is None or (trade["price"], trade["side"]) not in bar.prices
            if new_cell and self._cells + self._late_count >= self._max_cells:
                self.storage_error = "second_trade_queue_full"
                continue
            if bar is None:
                bar = self._bars.setdefault(key, SecondTradeBar(t_ms=t))
            if new_cell:
                self._cells += 1
            bar.ingest(seq=self._seq, **trade)

    async def flush(self, *, now_ms: int, force: bool = False) -> None:
        async with self._flush_lock:
            batches: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
            revision_batches: dict[tuple[str, str, str], list[tuple[tuple[str, str, int], int]]] = {}
            recent_by_file: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
            for key, bar in self._bars.items():
                eligible = force or bar.t_ms + 3000 <= now_ms
                saved = self._saved.get(key, 0)
                code, venue, t = key
                file_key = (code, venue, trade_date(t))
                row = None
                if bar.t_ms >= now_ms - RETAIN_MS and (eligible or saved == bar.revision):
                    row = bar.record()
                    recent_by_file.setdefault(file_key, []).append(row)
                if not eligible or saved >= bar.revision:
                    continue
                record = {"kind": "bar", "schema_version": 1, "bar": row or bar.record()}
                batches.setdefault(file_key, []).append(record)
                revision_batches.setdefault(file_key, []).append((key, bar.revision))
            late_snapshots = {key: list(rows) for key, rows in self._late.items() if rows}
            for key, rows in late_snapshots.items():
                batches.setdefault(key, []).extend(rows)
            for (code, venue, date), records in batches.items():
                try:
                    await asyncio.to_thread(self._append, self.path(code, venue, date), records)
                except OSError:
                    self.storage_error = "second_trade_storage_error"
                    _log.exception("second_trade.append_failed code=%s venue=%s", code, venue)
                    continue
                file_key = (code, venue, date)
                for key, rev in revision_batches.get(file_key, []):
                    self._saved[key] = rev
                path = self.path(code, venue, date)
                recent = recent_by_file.get(file_key, [])
                # No await between snapshot and offset: append is serialized by
                # this lock. Young, unflushed buckets are never checkpointed.
                offset = path.stat().st_size
                try:
                    await asyncio.to_thread(self._checkpoint, path, recent, offset, self._seq)
                except OSError:
                    _log.warning("second_trade.checkpoint_failed", exc_info=True)
                pending = self._late.get((code, venue, date))
                if pending:
                    n = len(late_snapshots.get((code, venue, date), []))
                    del pending[:n]
                    self._late_count -= n
                    if not pending:
                        self._late.pop((code, venue, date), None)
            self._sealed_before = now_ms - RETAIN_MS
            for key in list(self._bars):
                bar = self._bars[key]
                if bar.t_ms < self._sealed_before and self._saved.get(key) == bar.revision:
                    self._cells -= len(bar.prices)
                    del self._bars[key]
                    del self._saved[key]

    @staticmethod
    def _sync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _checkpoint(path: Path, rows: list[dict[str, Any]], offset: int, receive_seq: int) -> None:
        target = path.with_suffix(".recent.json")
        tmp = target.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as out:
            json.dump({"journal_bytes": offset, "receive_seq": receive_seq, "bars": rows}, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, target)
        SecondTradeStore._sync_directory(target.parent)

    @staticmethod
    def _append(path: Path, rows: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # A previous interrupted append can end mid-line. Terminate that line;
        # replay skips it and can still read every following complete record.
        prefix = ""
        if path.exists() and path.stat().st_size:
            with path.open("rb") as old:
                old.seek(-1, os.SEEK_END)
                if old.read(1) != b"\n":
                    prefix = "\n"
        with path.open("a", encoding="utf-8") as out:
            out.write(prefix + "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows))
            out.flush()
            os.fsync(out.fileno())
        SecondTradeStore._sync_directory(path.parent)

    @staticmethod
    def _replay(path: Path, *, initial: dict[int, dict[str, Any]] | None = None,
                offset: int = 0, end: int | None = None) -> dict[int, dict[str, Any]]:
        rows: dict[int, dict[str, Any]] = dict(initial or {})
        late: dict[int, dict[str, int]] = {}
        if not path.exists():
            return rows
        with path.open("rb") as source:
            source.seek(offset)
            limit = end if end is not None else os.fstat(source.fileno()).st_size
            while source.tell() < limit:
                line = source.readline(limit - source.tell())
                if not line.endswith(b"\n"):
                    break
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                try:
                    if record.get("kind") == "bar":
                        bar = record["bar"]
                        SecondTradeBar.restore(bar)
                        old = rows.get(bar["t_ms"])
                        if old is None or old["revision"] < bar["revision"]:
                            rows[bar["t_ms"]] = bar
                    elif record.get("kind") == "late":
                        trade = record["trade"]
                        if not all(type(trade[k]) is int for k in ("t_ms", "price", "qty", "side")):
                            continue
                        late[int(record["seq"])] = trade
                except (KeyError, TypeError, ValueError, AttributeError):
                    _log.warning("second_trade.invalid_record path=%s", path)
        for seq, trade in sorted(late.items()):
            t = trade["t_ms"] // 1000 * 1000
            bar = SecondTradeBar.restore(rows[t]) if t in rows else SecondTradeBar(t)
            if seq <= bar.applied_late_seq:
                continue
            bar.ingest(seq=seq, **trade)
            bar.applied_late_seq = seq
            rows[t] = bar.record()
        return rows

    def _generation_rows(self, code: str, venue: str, date: str) -> tuple[dict[int, dict[str, Any]], int]:
        import pyarrow.parquet as pq  # noqa: PLC0415

        base = self.root / date / venue / code
        if not (base / "manifest.json").exists():
            return {}, 0
        # Reader leases protect a generation while another process publishes
        # and removes old projections. Both tables always come from one manifest.
        with (base / ".generation.lock").open("a") as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_SH)
            manifest = json.loads((base / "manifest.json").read_text())
            generation = manifest["generation"]
            if not re.fullmatch(r"[0-9a-f]{32}", generation):
                raise ValueError("invalid second-trade generation")
            target = base / generation
            rows = {row["t_ms"]: {**row, "prices": []}
                    for row in pq.read_table(target / "trade_seconds.parquet").to_pylist()}
            for cell in pq.read_table(target / "trade_second_prices.parquet").to_pylist():
                rows[cell["t_ms"]]["prices"].append([cell[k] for k in ("price", "side", "qty", "count")])
            return rows, manifest["journal_bytes"]

    def disk_rows(self, code: str, venue: str, date: str) -> list[dict[str, Any]]:
        path = self.path(code, venue, date)
        stamp = path.stat().st_mtime_ns if path.exists() else 0
        with self._cache_lock:
            cached = self._cache.get(path)
            if cached is None or cached[0] != stamp:
                try:
                    initial, offset = self._generation_rows(code, venue, date)
                except (OSError, ValueError, KeyError):
                    _log.warning("second_trade.generation_unreadable", exc_info=True)
                    initial, offset = {}, 0
                cached = (stamp, self._replay(path, initial=initial, offset=offset))
                if len(self._cache) >= CACHE_LIMIT:
                    self._cache.pop(next(iter(self._cache)))
                self._cache[path] = cached
            return list(cached[1].values())

    def pending_corrections(self, code: str, venue: str, date: str) -> list[dict[str, Any]]:
        return list(self._late.get((code, venue, date), []))

    def live_rows(self, code: str, venue: str, date: str) -> list[dict[str, Any]]:
        return [bar.record() for (c, v, t), bar in self._bars.items()
                if c == code and v == venue and trade_date(t) == date]

    @staticmethod
    def _complete_prefix_size(path: Path) -> int:
        with path.open("rb") as source:
            size = os.fstat(source.fileno()).st_size
            end = size
            while end:
                start = max(0, end - 65_536)
                source.seek(start)
                chunk = source.read(end - start)
                newline = chunk.rfind(b"\n")
                if newline >= 0:
                    return start + newline + 1
                end = start
        return 0

    def publish(self, code: str, venue: str, date: str) -> Path | None:
        """Cold-path generation: manifest is written only after both tables exist."""
        import pyarrow as pa  # noqa: PLC0415
        import pyarrow.parquet as pq  # noqa: PLC0415

        journal = self.path(code, venue, date)
        if not journal.exists():
            return None
        journal_bytes = self._complete_prefix_size(journal)
        rows = list(self._replay(journal, end=journal_bytes).values())
        if not rows:
            return None
        base = self.root / date / venue / code
        manifest_path = base / "manifest.json"
        if manifest_path.exists():
            try:
                old = json.loads(manifest_path.read_text())
                if old["journal_bytes"] == journal_bytes:
                    return base / old["generation"]
            except (OSError, ValueError, KeyError):
                pass
        generation = uuid.uuid4().hex
        target = base / generation
        target.mkdir(parents=True)
        columns = ("t_ms", "open", "high", "low", "close", "volume", "count", "trade_value",
                   "revision", "first", "last", "applied_late_seq")
        bars = [{k: row[k] for k in columns} for row in rows]
        prices = [{"t_ms": row["t_ms"], "price": p, "side": side, "qty": qty, "count": count}
                  for row in rows for p, side, qty, count in row["prices"]]
        pq.write_table(pa.Table.from_pylist(bars), target / "trade_seconds.parquet")
        pq.write_table(pa.Table.from_pylist(prices), target / "trade_second_prices.parquet")
        for filename in ("trade_seconds.parquet", "trade_second_prices.parquet"):
            with (target / filename).open("rb") as table:
                os.fsync(table.fileno())
        tmp = base / f"manifest.{generation}.tmp"
        with tmp.open("w", encoding="utf-8") as out:
            json.dump({"schema_version": 1, "generation": generation, "journal_bytes": journal_bytes,
                       "coverage": "unverified"}, out)
            out.flush()
            os.fsync(out.fileno())
        with (base / ".generation.lock").open("a") as lease:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX)
            previous = None
            if manifest_path.exists():
                with contextlib.suppress(ValueError, KeyError):
                    previous = json.loads(manifest_path.read_text())["generation"]
            os.replace(tmp, manifest_path)
            self._sync_directory(base)
            for old_dir in base.iterdir():
                if (old_dir.is_dir() and re.fullmatch(r"[0-9a-f]{32}", old_dir.name)
                        and old_dir.name not in (generation, previous)):
                    shutil.rmtree(old_dir)
        return target


@lru_cache(maxsize=8)
def second_trade_store(data_dir: Path) -> SecondTradeStore:
    return SecondTradeStore(data_dir / "second_trades")

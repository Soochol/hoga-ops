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
_FLUSH_SLICE = 128
_FLUSH_WARN_MS = 250.0

_BarKey = tuple[str, str, int]
_FileKey = tuple[str, str, str]
_Record = dict[str, Any] | str


def _record_json(record: _Record) -> str:
    """Private encoded bar snapshots and ordinary late/cold-path records."""
    return record if isinstance(record, str) else json.dumps(record, separators=(",", ":"))


@lru_cache(maxsize=512)
def trade_date(t_ms: int) -> str:
    from datetime import datetime  # noqa: PLC0415

    return datetime.fromtimestamp(t_ms / 1000, KST).strftime("%Y%m%d")


class SecondTradeStore:
    def __init__(self, root: Path, *, max_cells: int = MAX_CELLS) -> None:
        self.root = root
        self._bars: dict[tuple[str, str, int], SecondTradeBar] = {}
        self._saved: dict[tuple[str, str, int], int] = {}
        # Only immutable JSON crosses awaits. A retained, unchanged second
        # must not rebuild its sorted price cells at every 10-second checkpoint.
        # Strings also avoid a second retained graph of price-cell containers.
        # Entries are bounded by _bars/max_cells and removed with their bars.
        self._flush_records: dict[_BarKey, tuple[int, str]] = {}
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

    def _flush_record(self, key: _BarKey, bar: SecondTradeBar) -> str:
        cached = self._flush_records.get(key)
        if cached is not None and cached[0] == bar.revision:
            return cached[1]
        # Encode a changed revision once, in a cooperative preparation slice.
        # Both journal and checkpoint reuse it. Never expose this private cache
        # through live_rows/API responses or reference mutable price cells.
        row = _record_json(bar.record())
        self._flush_records[key] = (bar.revision, row)
        return row

    async def _prepare_flush(self, now_ms: int, force: bool) -> tuple[
        dict[_FileKey, list[_Record]],
        dict[_FileKey, list[tuple[_BarKey, int]]],
        dict[_FileKey, list[_Record]],
        dict[_FileKey, list[dict[str, Any]]],
    ]:
        batches: dict[_FileKey, list[_Record]] = {}
        revisions: dict[_FileKey, list[tuple[_BarKey, int]]] = {}
        recent: dict[_FileKey, list[_Record]] = {}
        late = {key: list(rows) for key, rows in self._late.items() if rows}
        dirty_files = set(late)
        keys = tuple(self._bars)
        # Ingest may add keys while we yield. New bars and late rows not in this
        # pass's snapshots remain pending for the next flush; no dict iterator
        # is held across an await. A changed revision is acknowledged only after
        # its own immutable record has been appended and fsynced.
        for start in range(0, len(keys), _FLUSH_SLICE):
            await asyncio.sleep(0)
            for key in keys[start:start + _FLUSH_SLICE]:
                bar = self._bars[key]
                if (force or bar.t_ms + 3000 <= now_ms) and self._saved.get(key, 0) < bar.revision:
                    dirty_files.add((key[0], key[1], trade_date(key[2])))
        for start in range(0, len(keys), _FLUSH_SLICE):
            await asyncio.sleep(0)
            for key in keys[start:start + _FLUSH_SLICE]:
                bar = self._bars[key]
                eligible = force or bar.t_ms + 3000 <= now_ms
                saved = self._saved.get(key, 0)
                code, venue, t = key
                file_key = (code, venue, trade_date(t))
                if file_key not in dirty_files:
                    continue
                row = None
                if bar.t_ms >= now_ms - RETAIN_MS and (eligible or saved == bar.revision):
                    row = self._flush_record(key, bar)
                    recent.setdefault(file_key, []).append(row)
                if not eligible or saved >= bar.revision:
                    continue
                row = row or self._flush_record(key, bar)
                record = '{"kind":"bar","schema_version":1,"bar":' + row + '}'
                batches.setdefault(file_key, []).append(record)
                revisions.setdefault(file_key, []).append((key, bar.revision))
        for key, rows in late.items():
            batches.setdefault(key, []).extend(rows)
        return batches, revisions, recent, late

    async def flush(self, *, now_ms: int, force: bool = False) -> None:
        async with self._flush_lock:
            started = time.perf_counter()
            batches, revision_batches, recent_by_file, late_snapshots = await self._prepare_flush(now_ms, force)
            elapsed_ms = (time.perf_counter() - started) * 1000
            if elapsed_ms >= _FLUSH_WARN_MS:
                _log.warning("second_trade.flush_prepare elapsed_ms=%.1f bars=%d files=%d records=%d",
                             elapsed_ms, len(self._bars), len(batches),
                             sum(len(rows) for rows in batches.values()))
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
            keys = tuple(self._bars)
            for start in range(0, len(keys), _FLUSH_SLICE):
                await asyncio.sleep(0)
                for key in keys[start:start + _FLUSH_SLICE]:
                    bar = self._bars[key]
                    if bar.t_ms < self._sealed_before and self._saved.get(key) == bar.revision:
                        self._cells -= len(bar.prices)
                        del self._bars[key]
                        del self._saved[key]
                        self._flush_records.pop(key, None)

    @staticmethod
    def _sync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _checkpoint(path: Path, rows: list[_Record], offset: int, receive_seq: int) -> None:
        target = path.with_suffix(".recent.json")
        tmp = target.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as out:
            # Reuse each frozen JSON body rather than serializing the same
            # recent price ladder again in the I/O thread (ADR-0169: same GIL).
            header = json.dumps({"journal_bytes": offset, "receive_seq": receive_seq})[:-1]
            out.write(header + ',"bars":[' + ','.join(_record_json(row) for row in rows) + ']}')
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, target)
        SecondTradeStore._sync_directory(target.parent)

    @staticmethod
    def _append(path: Path, rows: list[_Record]) -> None:
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
            out.write(prefix + "".join(_record_json(row) + "\n" for row in rows))
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

    def live_dates(self, code: str, venue: str) -> set[str]:
        return {trade_date(t) for c, v, t in self._bars if c == code and v == venue}

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

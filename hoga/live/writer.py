"""JSONL append-only writer for Live Capture (ADR-0038).

The writer is the hot-path write side of Live Capture. Per ADR-0038's
invariant this module never imports pyarrow / polars / any Parquet
writer. JSONL → Parquet conversion happens later in `hoga/live/promote.py`
(Stage 5), not here.

Concurrency: per-code asyncio.Lock serializes appends to the same
(date, code) file. Cross-code appends run concurrently. fsync is
deferred to `fsync_all()` which the stream's flush loop calls once per 10s window.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Iterable

from .snapshot import LiveSnapshot


class LiveWriter:
    """Append-only JSONL writer keyed by (date, code).

    Files land at `<live_root>/{date}/{code}.jsonl`. Lazily creates parent
    dirs on first append. Holds no open file handles between calls; each
    append opens-writes-closes (fast on Linux, atomic at OS write
    boundary for small <= PIPE_BUF writes which JSONL lines almost
    always are).
    """

    def __init__(self, live_root: Path):
        self._root = live_root
        self._code_locks: dict[str, asyncio.Lock] = {}

    def _lock_for(self, code: str) -> asyncio.Lock:
        return self._code_locks.setdefault(code, asyncio.Lock())

    async def append(
        self,
        date: str,
        code: str,
        snapshots: Iterable[LiveSnapshot],
    ) -> None:
        """Append the given snapshots to `<root>/{date}/{code}.jsonl`."""
        # Materialize once outside the lock to keep the critical section short.
        lines = "".join(s.to_jsonl() + "\n" for s in snapshots)
        if not lines:
            return
        async with self._lock_for(code):
            target = self._root / date / f"{code}.jsonl"
            target.parent.mkdir(parents=True, exist_ok=True)
            await asyncio.to_thread(self._append_sync, target, lines)

    @staticmethod
    def _append_sync(path: Path, data: str) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(data)

    async def fsync_all(self) -> None:
        """Force-fsync every JSONL under live_root. Called once per Poller cycle.

        ADR-0038: one fsync per cycle is the crash-safety boundary. A crash
        between fsync_all calls loses at most the current cycle's data;
        partial lines from a torn write are tolerated by the promote reader.
        """
        if not self._root.exists():
            return
        targets: list[Path] = []
        for date_dir in self._root.iterdir():
            if not date_dir.is_dir():
                continue
            for f in date_dir.iterdir():
                if f.suffix == ".jsonl" and f.is_file():
                    targets.append(f)
        for path in targets:
            await asyncio.to_thread(self._fsync_one, path)

    @staticmethod
    def _fsync_one(path: Path) -> None:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

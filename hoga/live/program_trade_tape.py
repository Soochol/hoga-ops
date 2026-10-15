"""Append-only 0w event history, independent of the 30-second cumulative sidecar.

Capture is the sole writer. Disk I/O runs in the collector's thread work, never
in the WS callback. Byte cursors remain stable while later events are appended.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from hoga.util.timeenc import KST


class ProgramTradeTapeStore:
    def __init__(self, data_dir: Path):
        self.root = data_dir / "program_trade_ticks"

    def path(self, code: str, venue: str, date: str) -> Path:
        return self.root / date / venue / f"{code}.jsonl"

    def append(self, events: list[tuple[str, str, dict]]) -> None:
        groups: dict[Path, list[dict]] = defaultdict(list)
        for code, venue, row in events:
            date = datetime.fromtimestamp(row["t_ms"] / 1000, KST).strftime("%Y%m%d")
            groups[self.path(code, venue, date)].append(row)
        for path, rows in groups.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("ab+") as stream:
                stream.seek(0, 2)
                if stream.tell():
                    stream.seek(-1, 2)
                    if stream.read(1) != b"\n":
                        stream.write(b"\n")  # isolate a torn final line after a crash
                stream.write(b"".join((json.dumps(row, separators=(",", ":")) + "\n").encode() for row in rows))

    def page(
        self, code: str, venue: str, date: str, *, before: int | None, limit: int,
    ) -> tuple[list[dict], int | None]:
        path = self.path(code, venue, date)
        if not path.exists():
            return [], None
        rows: list[dict] = []
        seen: set[str] = set()
        oldest = 0
        with path.open("rb") as stream:
            stream.seek(0, 2)
            end = stream.tell() if before is None else min(before, stream.tell())
            for offset, line in _reverse_lines(stream, end):
                try:
                    row = json.loads(line)
                    event_id = row["event_id"]
                    if (not isinstance(event_id, str) or event_id in seen
                            or type(row["t_ms"]) is not int or row["t_ms"] <= 0
                            or datetime.fromtimestamp(row["t_ms"] / 1000, KST).strftime("%Y%m%d") != date
                            or type(row["event_delta_qty"]) is not int or row["event_delta_qty"] == 0):
                        continue
                except (ValueError, KeyError, TypeError, OverflowError, OSError):
                    continue  # a partial final write cannot poison older complete events
                seen.add(event_id)
                if len(rows) == limit:
                    return rows, oldest
                rows.append(row)
                oldest = offset
        return rows, None


def _reverse_lines(stream, end: int):
    tail = b""
    position = end
    while position:
        start = max(0, position - 65536)
        stream.seek(start)
        block = stream.read(position - start) + tail
        parts = block.splitlines(keepends=True)
        tail = parts.pop(0) if start else b""
        offset = start + len(block)
        for part in reversed(parts):
            offset -= len(part)
            yield offset, part
        position = start

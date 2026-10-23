"""Optional native peak invalidations and a revisioned shadow replica.

No vendor IO, timers or serialization on ingestion. The legacy snapshot remains
the oracle and the only production response. Histories are never truncated.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .collector_ipc import DISPLAY_MAX_FRAME_BYTES, encode

if TYPE_CHECKING:
    from .ask_peak_state import _TodaySidePeakState

MINUTES = {"traded_bar_peaks": "traded_bar_max", "all_bar_peaks": "all_bar_max",
           "unreached_bar_peaks": "unreached_bar_max"}
RECORD = "all_record_peaks"
PART_CHARS = 32_768


@dataclass(slots=True)
class PeakChanges:
    revision: int = 1
    full: bool = True
    minutes: dict[str, set[int]] = field(default_factory=dict)
    record_start: int | None = None
    _marked: bool = False

    def begin(self) -> None:
        self._marked = False

    def mark(self) -> None:
        if not self._marked:
            self.revision += 1
            self._marked = True

    def minute(self, name: str, minute: int) -> None:
        self.mark()
        self.minutes.setdefault(name, set()).add(minute)

    def record(self, start: int) -> None:
        self.mark()
        self.record_start = start if self.record_start is None else min(start, self.record_start)

    def reset(self) -> None:
        self.begin()
        self.mark()
        self.full = True
        self.minutes.clear()
        self.record_start = None

    def clear(self) -> None:
        self.full = False
        self.minutes.clear()
        self.record_start = None


def point(value) -> dict:
    return {"price": value.price, "qty": value.qty, "t_ms": value.t_ms}


def json_tokens(value):
    """Iterative JSON traversal without json.encoder's recursive closure cycles.

    Only container depth is retained; large history arrays are not copied onto
    the stack. Scalar encoding still uses the standard JSON encoder for strings
    and floats. The peak protocol has string-only object keys.
    """
    stack = [("value", value, True)]
    while stack:
        kind, current, first = stack.pop()
        if kind != "value":
            try:
                item = next(current)
            except StopIteration:
                yield "}" if kind == "dict" else "]"
                continue
            stack.append((kind, current, False))
            if kind == "dict":
                key, child = item
                if not isinstance(key, str):
                    raise TypeError("peak wire object keys must be strings")
                yield ("" if first else ",") + json.dumps(key, ensure_ascii=False) + ":"
            else:
                child = item
                if not first:
                    yield ","
            stack.append(("value", child, True))
        elif isinstance(current, dict):
            yield "{"
            stack.append(("dict", iter(current.items()), True))
        elif isinstance(current, (list, tuple)):
            yield "["
            stack.append(("list", iter(current), True))
        elif type(current) is int:
            yield str(current)
        else:
            yield json.dumps(current, separators=(",", ":"), ensure_ascii=False)


def history_points(state: _TodaySidePeakState) -> int:
    return (len(state.all_record) + len(state.traded_record)
            + sum(len(getattr(state, name)) for name in MINUTES.values()))


def prepare(state: _TodaySidePeakState, *, base: int, generation: str, empty: bool) -> dict | None:
    changes = state.changes
    if changes is None or changes.revision == base:
        return None
    full = changes.full or empty or state.all_peak is None
    message = {"generation": generation, "base": base, "revision": changes.revision, "full": full}
    if full:
        return {**message, "value": state.snapshot()}
    metadata = state.snapshot(include_history=False)
    minutes = {}
    for name, dirty in changes.minutes.items():
        values = getattr(state, MINUTES[name])
        minutes[name] = {"set": {str(minute): point(values[minute]) for minute in dirty if minute in values},
                         "remove": [str(minute) for minute in dirty if minute not in values]}
    record = None
    if changes.record_start is not None:
        record = {"start": changes.record_start, "values": [point(p) for p in state.all_record[changes.record_start:]]}
    return {**message, "metadata": metadata, "minutes": minutes, "record": record}


class PeakReplica:
    def __init__(self, generation: str):
        self.generation = generation
        self.revision = 0
        self.metadata: dict | None = None
        self.minutes: dict[str, dict[int, dict]] = {}
        self.records: list[dict] = []

    def apply(self, message: dict) -> None:
        if message["generation"] != self.generation:
            raise ValueError("peak generation mismatch")
        if message["revision"] <= self.revision:
            raise ValueError("peak revision regression")
        if not message["full"] and message["base"] != self.revision:
            raise ValueError("peak base mismatch")
        if message["full"]:
            value = message["value"]
            self.metadata = None if value is None else {k: v for k, v in value.items() if k not in (*MINUTES, RECORD)}
            self.minutes = {name: {p["t_ms"] // 60_000: p for p in (value or {}).get(name, [])} for name in MINUTES}
            self.records = [] if value is None else value[RECORD]
        else:
            self.metadata = message["metadata"]
            for name, changes in message["minutes"].items():
                values = self.minutes[name]
                values.update({int(minute): p for minute, p in changes["set"].items()})
                for minute in changes["remove"]:
                    values.pop(int(minute), None)
            record = message["record"]
            if record is not None:
                if record["start"] > len(self.records):
                    raise ValueError("peak record splice gap")
                self.records[record["start"]:] = record["values"]
        self.revision = message["revision"]

    def snapshot(self) -> dict | None:
        if self.metadata is None:
            return None
        return {**self.metadata, RECORD: self.records,
                **{name: [values[minute] for minute in sorted(values)] for name, values in self.minutes.items()}}

    def points(self) -> int:
        return (len(self.records) + sum(map(len, self.minutes.values()))
                + len((self.metadata or {}).get("traded_record_peaks", [])))


def wire_roundtrip(message: dict, *, byte_limit: int = 8 * 1024 * 1024) -> tuple[dict, int, int]:
    """Exercise bounded intra-key wire parts without a second full encoded outbox.

    The caller enforces a point cap before building a message. This function is
    synchronous and reserved for sampled shadow checks, never the tick callback.
    """
    fragments, staging, size, wire_bytes, parts = [], [], 0, 0, 0

    def receive(last: bool) -> None:
        nonlocal wire_bytes, parts
        frame = encode({"generation": message["generation"], "revision": message["revision"],
                        "part": parts, "last": last, "data": "".join(staging)}, limit=DISPLAY_MAX_FRAME_BYTES)
        value = json.loads(frame[4:])
        if (value["part"] != parts or value["generation"] != message["generation"]
                or value["revision"] != message["revision"]):
            raise ValueError("peak wire part mismatch")
        fragments.append(value["data"])
        wire_bytes += len(frame)
        parts += 1

    total = 0
    for token in json_tokens(message):
        for offset in range(0, len(token), PART_CHARS):
            piece = token[offset:offset + PART_CHARS]
            total += len(piece.encode())
            if total > byte_limit:
                raise ValueError("peak shadow staging byte budget exceeded")
            if size + len(piece) > PART_CHARS and staging:
                receive(False)
                staging, size = [], 0
            staging.append(piece)
            size += len(piece)
    receive(True)
    return json.loads("".join(fragments)), wire_bytes, parts

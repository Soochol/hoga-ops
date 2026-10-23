"""Incremental private IPC trees: bounded frames, one atomic logical result.

Large peak arrays are sliced by reference, encoded in small batches and extended
directly into the receiving tree. No complete JSON string or encoded part queue
is retained. The logical result itself deliberately has no 8MiB byte limit.
"""
from __future__ import annotations

import asyncio
import json
import struct
from collections.abc import Iterator
from itertools import chain

TRANSFER_FRAME_BYTES = 256 * 1024
ARRAY_BATCH_ITEMS = 256
MAX_PATH_DEPTH = 16
OPERATION_FIELDS = 3


def _json(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def _operations(value, path: list[str]) -> Iterator[list]:
    if len(path) > MAX_PATH_DEPTH:
        raise ValueError("collector transfer path too deep")
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("collector transfer keys must be strings")
        yield ["put", path, {k: v for k, v in value.items() if not isinstance(v, (dict, list))}]
        for key, child in value.items():
            if isinstance(child, (dict, list)):
                yield from _operations(child, [*path, key])
    elif isinstance(value, list):
        yield ["list", path, len(value)]
        for start in range(0, len(value), ARRAY_BATCH_ITEMS):
            yield ["append", start, value[start:start + ARRAY_BATCH_ITEMS]]
    else:
        yield ["put", path, value]


def _encoded_operations(operation: list, budget: int) -> Iterator[bytes]:
    data = _json(operation)
    if len(data) <= budget:
        yield data
    elif operation[0] == "append" and len(operation[2]) > 1:
        # Also honor small test frames and unusual point widths, without ever
        # serializing the entire history in order to discover its byte size.
        middle = len(operation[2]) // 2
        yield from _encoded_operations(["append", operation[1], operation[2][:middle]], budget)
        yield from _encoded_operations(["append", operation[1] + middle, operation[2][middle:]], budget)
    else:
        raise ValueError("collector transfer scalar exceeds frame byte limit")


def tree_frames(message: dict, identity: dict, *, limit: int = TRANSFER_FRAME_BYTES) -> Iterator[bytes]:
    """Lazily serialize one immutable snapshot; finish before another message."""
    part, entries = 0, []

    def header(last: bool) -> bytes:
        return _json({"_transfer": identity, "part": part, "last": last})[:-1] + b',"ops":['

    def frame(last: bool) -> bytes:
        body = header(last) + b",".join(entries) + b"]}"
        return struct.pack("!I", len(body)) + body

    size = len(header(False)) + 2
    # Reserve the maximum part-number width rather than encoding history twice.
    budget = limit - size - 20
    if budget < 1:
        raise ValueError("collector transfer header exceeds frame byte limit")
    for operation in chain(_operations(message, []), [["end", [], None]]):
        for data in _encoded_operations(operation, budget):
            added = len(data) + bool(entries)
            if size + added > limit and entries:
                yield frame(False)
                part, entries = part + 1, []
                size = len(header(False)) + 2
                added = len(data)
            if size + added > limit:
                raise ValueError("collector transfer operation exceeds frame byte limit")
            entries.append(data)
            size += added
    yield frame(True)


class _Tree:
    def __init__(self):
        self.value = None
        self.ended = False
        self.active: tuple[list, int] | None = None

    def _complete_array(self):
        if self.active is not None and len(self.active[0]) != self.active[1]:
            raise ValueError("collector transfer incomplete array")
        self.active = None

    def apply(self, operation):
        if self.ended or not isinstance(operation, list) or len(operation) != OPERATION_FIELDS:
            raise ValueError("collector transfer invalid operation")
        kind, path, value = operation
        if kind == "append":
            if (self.active is None or type(path) is not int or not isinstance(value, list)
                    or not value or path != len(self.active[0])
                    or path + len(value) > self.active[1]):
                raise ValueError("collector transfer array offset mismatch")
            self.active[0].extend(value)
            return
        self._complete_array()
        if kind == "end" and path == [] and value is None:
            self.ended = True
            return
        if (kind not in {"put", "list"} or not isinstance(path, list) or len(path) > MAX_PATH_DEPTH
                or any(not isinstance(key, str) for key in path)):
            raise ValueError("collector transfer invalid path")
        if kind == "list":
            if type(value) is not int or value < 0:
                raise ValueError("collector transfer invalid array length")
            value, length = [], value
            self.active = (value, length)
        if not path:
            if self.value is not None or not isinstance(value, dict):
                raise ValueError("collector transfer duplicate root")
            self.value = value
            return
        target = self.value
        for key in path[:-1]:
            if not isinstance(target, dict) or key not in target:
                raise ValueError("collector transfer missing parent")
            target = target[key]
        if not isinstance(target, dict) or path[-1] in target:
            raise ValueError("collector transfer duplicate path")
        target[path[-1]] = value

    def finish(self):
        self._complete_array()
        if self.value is None or not self.ended:
            raise ValueError("collector transfer missing root or end marker")
        return self.value


async def read_tree(reader, first: dict, read_frame, *, kind: str, accept=lambda: True):
    """Validate every part; a canceled RPC drains without accumulating a tree."""
    identity = first.get("_transfer")
    if not isinstance(identity, dict) or identity.get("kind") != kind:
        raise ValueError("collector transfer identity mismatch")
    tree = _Tree()
    part, current = 0, first
    while True:
        if (current.get("_transfer") != identity or type(current.get("part")) is not int
                or current["part"] != part or type(current.get("last")) is not bool
                or not isinstance(current.get("ops"), list) or not current["ops"]):
            raise ValueError("collector transfer part mismatch")
        if not accept():
            tree = None  # Drop a canceled waiter's already assembled prefix too.
        if tree is not None:
            for operation in current["ops"]:
                tree.apply(operation)
        if current["last"]:
            if tree is None:
                return None
            result = tree.finish()
            if any(result.get(key) != value for key, value in identity.items() if key != "kind"):
                raise ValueError("collector transfer result identity mismatch")
            return result
        part += 1
        await asyncio.sleep(0)  # Buffered reads may otherwise monopolize the loop.
        current = await read_frame(reader, limit=TRANSFER_FRAME_BYTES)


async def write_frames(writer, frames):
    for frame in frames:
        writer.write(frame)
        await writer.drain()
        # drain() often completes synchronously; always allow capture/storage,
        # shutdown and other channel tasks to run between bounded work batches.
        await asyncio.sleep(0)

"""Bounded, coalesced JSONL parsing for the two investor-flow readers.

Cache parsed raw samples, never response payloads: confirmation, units and receipt
health can change independently. Callers must treat cached models as read-only.
"""
from __future__ import annotations

import logging
from collections import OrderedDict
from pathlib import Path
from threading import Lock
from typing import TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)
log = logging.getLogger(__name__)
_lock = Lock()
_cache: OrderedDict[tuple[Path, type[BaseModel]], tuple[tuple[int, ...], tuple[BaseModel, ...]]] = OrderedDict()
_MAX_FILES = 4


def _signature(path: Path) -> tuple[int, ...]:
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns


def load_flow_samples(path: Path, model: type[T]) -> list[T]:
    """Read a stable file version once across threads/store instances.

    A concurrent append may yield a valid older snapshot, but it is never cached
    under the newer signature. Partial tails are retried on the next file change.
    """
    key = (path.resolve(), model)
    with _lock:
        try:
            before = _signature(path)
        except FileNotFoundError:
            _cache.pop(key, None)
            return []
        cached = _cache.get(key)
        if cached is not None and cached[0] == before:
            _cache.move_to_end(key)
            return list(cached[1])  # type: ignore[return-value]
        try:
            raw = path.read_bytes()
            after = _signature(path)
        except FileNotFoundError:
            _cache.pop(key, None)
            return []
        samples: list[T] = []
        for line in raw.split(b"\n")[:-1]:
            if not line.strip():
                continue
            try:
                samples.append(model.model_validate_json(line))
            except ValidationError:
                log.warning("flow: invalid sample skipped file=%s", path.name)
        if before == after:
            _cache[key] = (after, tuple(samples))
            _cache.move_to_end(key)
            while len(_cache) > _MAX_FILES:
                _cache.popitem(last=False)
        else:
            _cache.pop(key, None)
        return samples

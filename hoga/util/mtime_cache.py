"""Read-only file cache with identity validation and shared concurrent loads.

Values are shared by reference. Writers must use a fresh read-modify-write load.
Callbacks for the same path must have the same semantics and must not recursively
load that path through this cache. An unstable file is returned uncached after
three attempts; the cache does not promise a transactional snapshot of arbitrary
in-place writes.
"""
from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from pathlib import Path
from threading import Lock
from typing import Generic, TypeVar

_T = TypeVar("_T")
_FileVersion = tuple[int, int, int, int, int]
_MAX_LOAD_ATTEMPTS = 3


def _version(path: Path) -> _FileVersion | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size


class MtimeLruCache(Generic[_T]):
    def __init__(self, max_entries: int) -> None:
        self._max = max(0, int(max_entries))
        self._entries: OrderedDict[str, tuple[_FileVersion, _T]] = OrderedDict()
        self._inflight: dict[str, Future[None]] = {}
        self._epoch = 0
        self._lock = Lock()

    def get_or_load(self, path: Path, load: Callable[[Path], _T]) -> _T:
        key = str(path)
        if self._max == 0:
            return load(path)
        while True:
            version = _version(path)
            if version is None:
                return load(path)
            with self._lock:
                cached = self._entries.get(key)
                if cached is not None and cached[0] == version:
                    self._entries.move_to_end(key)
                    return cached[1]
                flight = self._inflight.get(key)
                owner = flight is None
                if owner:
                    flight = Future()
                    self._inflight[key] = flight
                epoch = self._epoch
            if not owner:
                flight.result()
                # Re-stat after waiting: the file may have changed or clear() may have run.
                continue
            try:
                value, stable = self._load_stable(path, load, version)
                with self._lock:
                    if stable is not None and epoch == self._epoch:
                        self._entries[key] = (stable, value)
                        self._entries.move_to_end(key)
                        while len(self._entries) > self._max:
                            self._entries.popitem(last=False)
                    self._inflight.pop(key, None)
                flight.set_result(None)
                return value
            except BaseException as error:
                with self._lock:
                    self._inflight.pop(key, None)
                flight.set_exception(error)
                raise

    @staticmethod
    def _load_stable(path, load, version):
        for _ in range(_MAX_LOAD_ATTEMPTS):
            value = load(path)
            after = _version(path)
            if version is not None and after == version:
                return value, after
            version = after
        return value, None

    def clear(self) -> None:
        with self._lock:
            self._epoch += 1
            self._entries.clear()

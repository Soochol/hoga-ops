"""Bounded, copy-isolated daily snapshot facts; never cache live predicates.

Only process-created pickle bytes are retained in RAM. Reads still attest file
identity, so replacing/tampering with a referenced object cannot hide behind a
cached result. Concurrent requests share preparation, including its failures.
"""
from __future__ import annotations

import pickle
import threading
from collections import OrderedDict
from concurrent.futures import Future
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path

MAX_BYTES = 64 * 1024 * 1024
MAX_ENTRY_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 1536


def signature(path):
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@dataclass
class Reads:
    files: dict = field(default_factory=dict)
    stable: bool = True

    def add(self, path, stamp):
        if path in self.files and self.files[path] != stamp:
            self.stable = False
        self.files[path] = stamp


_reads: ContextVar[Reads | None] = ContextVar('screener_snapshot_reads', default=None)


def before_read(path):
    return signature(path) if _reads.get() is not None else None


def after_read(path, stamp):
    reads = _reads.get()
    if reads is not None and stamp is not None:
        path = Path(path).absolute()
        reads.add(path, stamp)
        if signature(path) != stamp:
            reads.stable = False


@dataclass
class Entry:
    payload: bytes
    reads: Reads
    size: int


class SnapshotCache:
    def __init__(self):
        self.entries = OrderedDict()
        self.flights = {}
        self.bytes = 0
        self.lock = threading.Lock()
        self.generation = 0

    def clear(self):
        with self.lock:
            self.entries.clear()
            self.bytes = 0
            self.generation += 1

    @staticmethod
    def valid(entry):
        try:
            return entry.reads.stable and all(signature(path) == stamp for path, stamp in entry.reads.files.items())
        except OSError:
            return False

    def obtain(self, key, loader):
        while True:
            with self.lock:
                entry = self.entries.get(key)
                generation = self.generation
            if entry is not None and self.valid(entry):
                with self.lock:
                    if self.entries.get(key) is entry:
                        self.entries.move_to_end(key)
                return self.unpack(entry)
            with self.lock:
                if self.generation != generation or self.entries.get(key) is not entry:
                    continue
                if entry is not None:
                    self.bytes -= self.entries.pop(key).size
                flight = (self.generation, key)
                future = self.flights.get(flight)
                owner = future is None
                if owner:
                    future = self.flights[flight] = Future()
                break
        if not owner:
            return self.unpack(future.result())
        token = _reads.set(Reads())
        try:
            value = loader()
            reads = _reads.get()
            payload = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
            size = len(payload) + sum(len(str(path).encode()) + 128 for path in reads.files) + len(repr(key))
            entry = Entry(payload, reads, size)
            reads.stable &= self.valid(entry)
            with self.lock:
                if (flight[0] == self.generation and reads.stable and size <= MAX_ENTRY_BYTES
                        and size <= MAX_BYTES and MAX_ENTRIES > 0):
                    previous = self.entries.pop(key, None)
                    self.bytes -= previous.size if previous else 0
                    self.entries[key] = entry
                    self.bytes += size
                    while len(self.entries) > MAX_ENTRIES or self.bytes > MAX_BYTES:
                        _, previous = self.entries.popitem(last=False)
                        self.bytes -= previous.size
            future.set_result(entry)
        except BaseException as exc:
            future.set_exception(exc)
            raise
        finally:
            _reads.reset(token)
            with self.lock:
                self.flights.pop(flight, None)
        return self.unpack(entry)

    @staticmethod
    def unpack(entry):
        parent = _reads.get()
        if parent is not None:
            parent.stable &= entry.reads.stable
            for path, stamp in entry.reads.files.items():
                parent.add(path, stamp)
        return pickle.loads(entry.payload)


shared = SnapshotCache()


def obtain(data_dir, manifest, kind, inputs, loader):
    # Import at the call boundary: store records dependencies using this module.
    from hoga.api.screener_series_store import digest  # noqa: PLC0415
    key = (str(Path(data_dir).resolve()), digest(manifest), kind, inputs)
    return shared.obtain(key, loader)

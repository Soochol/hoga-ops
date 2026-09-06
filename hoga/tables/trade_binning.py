"""Shared continuous-trade bins and bounded, exact-time prefix indexes.

Table-only data: no wire models. Cache instances belong to a QueryEngine, and
keys include the resolved parquet identity and every numerical query boundary.
"""

from __future__ import annotations

import sys
import threading
from array import array
from bisect import bisect_left
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypeVar, cast

import duckdb
import polars as pl

from hoga.util.timeenc import hhmmssms_to_intra_ms_sql

T = TypeVar("T")
MAX_INDEX_ROWS = 500_000


@dataclass(frozen=True)
class BinningSpec:
    price_lo: int
    price_hi: int
    bins: int
    lower: int
    upper: int

    @property
    def width(self) -> float:
        return max((self.price_hi - self.price_lo) / self.bins, 0) or 1.0


# (raw bin index, total quantity, first time, last time). Raw upper-edge bin is
# intentionally preserved; distribution and POC historically clamp at different stages.
Statistics = tuple[tuple[int, int, int, int], ...]


def _query(
    con: duckdb.DuckDBPyConnection, path: Path, spec: BinningSpec, *, timeline: bool
) -> duckdb.DuckDBPyConnection:
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    group = "bin_idx, intra_ms" if timeline else "bin_idx"
    fields = "intra_ms, SUM(qty)" if timeline else "SUM(qty), MIN(intra_ms), MAX(intra_ms)"
    limit = f"LIMIT {MAX_INDEX_ROWS + 1}" if timeline else ""
    return con.execute(
        f"""WITH filtered AS (
          SELECT FLOOR((price - ?) / ?)::BIGINT AS bin_idx,
                 qty, {intra} AS intra_ms
          FROM read_parquet(?)
          WHERE side IN (1, -1) AND price > 0 AND qty > 0
            AND price BETWEEN ? AND ?
        )
        SELECT bin_idx, {fields} FROM filtered
        WHERE intra_ms >= ? AND intra_ms < ?
        GROUP BY {group} ORDER BY {group} {limit}
        """,
        [spec.price_lo, spec.width, str(path), spec.price_lo, spec.price_hi, spec.lower, spec.upper],
    )


def query_statistics(con: duckdb.DuckDBPyConnection, path: Path, spec: BinningSpec) -> Statistics:
    return tuple(tuple(int(v) for v in row) for row in _query(con, path, spec, timeline=False).fetchall())


@dataclass(frozen=True)
class TimeIndex:
    # Arrays remain private to the cache; consumers only receive immutable Statistics.
    bins: tuple[tuple[int, array, array], ...]

    @property
    def nbytes(self) -> int:
        return (
            sys.getsizeof(self)
            + sys.getsizeof(self.bins)
            + sum(
                sys.getsizeof(entry) + sys.getsizeof(entry[0]) + sys.getsizeof(entry[1]) + sys.getsizeof(entry[2])
                for entry in self.bins
            )
        )

    def before(self, upper: int) -> Statistics:
        out = []
        for idx, times, cumulative in self.bins:
            pos = bisect_left(times, upper)
            if pos:
                out.append((idx, cumulative[pos - 1], times[0], times[pos - 1]))
        return tuple(out)


def query_time_index(con: duckdb.DuckDBPyConnection, path: Path, spec: BinningSpec) -> TimeIndex | None:
    frame = _query(con, path, spec, timeline=True).pl()
    if frame.height > MAX_INDEX_ROWS:
        return None  # bounded negative cache; oversized inputs keep the direct query
    if frame.height == 0:
        return TimeIndex(())
    frame = frame.rename({frame.columns[-1]: "qty"}).with_columns(
        pl.col("qty").cast(pl.Int128).cum_sum().over("bin_idx").alias("cumulative"),
    )
    if frame["cumulative"].max() > sys.maxsize:
        # DuckDB SUM is wider than int64. Keep exact arithmetic on that rare input.
        return None
    groups: list[tuple[int, array, array]] = []
    for part in frame.partition_by("bin_idx", maintain_order=True):
        times, cumulative = array("q"), array("q")
        times.frombytes(part["intra_ms"].cast(pl.Int64).to_numpy().tobytes())
        cumulative.frombytes(part["cumulative"].cast(pl.Int64).to_numpy().tobytes())
        groups.append((int(part["bin_idx"][0]), times, cumulative))
    return TimeIndex(tuple(groups))


class TradeBinningCache:
    """Byte/entry bounded LRU with per-key single-flight; unrelated keys run concurrently."""

    def __init__(self, max_bytes: int = 32 * 1024 * 1024, max_entries: int = 64) -> None:
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self._bytes = 0
        self._entries: OrderedDict[tuple, tuple[object, int]] = OrderedDict()
        self._pending: dict[tuple, Future] = {}
        self._lock = threading.Lock()

    @property
    def nbytes(self) -> int:
        with self._lock:
            return self._bytes

    def _cached(self, key: tuple, load: Callable[[], T], weigh: Callable[[T], int]) -> T:
        with self._lock:
            if key in self._entries:
                self._entries.move_to_end(key)
                return cast("T", self._entries[key][0])
            future = self._pending.get(key)
            leader = future is None
            if leader:
                future = Future()
                self._pending[key] = future
        assert future is not None
        if not leader:
            return cast("T", future.result())
        try:
            result = load()
            weight = weigh(result)
            with self._lock:
                if weight <= self.max_bytes and self.max_entries > 0:
                    self._entries[key] = (result, weight)
                    self._bytes += weight
                    while self._bytes > self.max_bytes or len(self._entries) > self.max_entries:
                        _, (_, evicted) = self._entries.popitem(last=False)
                        self._bytes -= evicted
            future.set_result(result)
            return result
        except BaseException as exc:
            future.set_exception(exc)
            raise
        finally:
            with self._lock:
                self._pending.pop(key, None)

    def read(
        self,
        con: duckdb.DuckDBPyConnection,
        path: Path,
        spec: BinningSpec,
        *,
        cutoff: int | None = None,
    ) -> Statistics:
        stat = path.stat()
        key = (str(path.resolve()), stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, spec)
        if cutoff is not None:
            index = self._cached(
                ("timeline", *key),
                lambda: query_time_index(con, path, spec),
                lambda value: value.nbytes if value is not None else sys.getsizeof(None),
            )
            if index is not None:
                return index.before(min(cutoff, spec.upper))
            return query_statistics(con, path, replace(spec, upper=min(cutoff, spec.upper)))
        return self._cached(
            ("full", *key),
            lambda: query_statistics(con, path, spec),
            lambda rows: sys.getsizeof(rows) + sum(sys.getsizeof(row) + sum(map(sys.getsizeof, row)) for row in rows),
        )

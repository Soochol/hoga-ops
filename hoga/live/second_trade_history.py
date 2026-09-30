"""Read original hogaplay executions as observed seconds, never live 10s aggregates."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

from hoga.util.timeenc import hhmmssms_to_unix_ms

from .second_trade_agg import SecondTradeBar

HOURS_PER_DAY = 24
UNITS_PER_MINUTE = 60


@lru_cache(maxsize=4)
def _read_seconds(path: str, date: str, stamp_ns: int, size: int) -> tuple[dict[str, Any], ...]:
    # File identity invalidates the bounded cache after capture replacement.
    del stamp_ns, size
    bars: dict[int, SecondTradeBar] = {}
    table = pq.ParquetFile(path)
    for batch in table.iter_batches(columns=["ts_ms", "seq", "price", "qty", "side"]):
        for row in batch.to_pylist():
            native, price, qty, side = (row[k] for k in ("ts_ms", "price", "qty", "side"))
            # Auction summaries carry price=0 and are not actual executions.
            if price <= 0 or qty <= 0 or side not in (-1, 0, 1):
                continue
            hour, minute, second = native // 10_000_000, native // 100_000 % 100, native // 1000 % 100
            if not (0 <= hour < HOURS_PER_DAY and 0 <= minute < UNITS_PER_MINUTE and 0 <= second < UNITS_PER_MINUTE):
                continue
            t = hhmmssms_to_unix_ms(date, native)
            bucket = t // 1000 * 1000
            bar = bars.setdefault(bucket, SecondTradeBar(bucket))
            bar.ingest(t_ms=t, seq=row["seq"], price=price, qty=qty, side=side)
    return tuple(bar.record() for _, bar in sorted(bars.items()))


def historical_second_rows(data_dir: Path, code: str, venue: str, date: str) -> tuple[dict[str, Any], ...]:
    # Hogaplay records KRX. NXT/UN must not silently receive another market.
    if venue != "KRX":
        return ()
    path = data_dir / "parquet" / date / code / "hogaplay" / "trades.parquet"
    if not path.is_file():
        return ()
    stat = path.stat()
    return _read_seconds(str(path), date, stat.st_mtime_ns, stat.st_size)

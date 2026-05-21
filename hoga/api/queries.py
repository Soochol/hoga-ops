"""Cross-table query coordinator. Per-table queries live in ``hoga/tables/``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb

from hoga.api.disk_state import DiskState, classify_from_meta
from hoga.api.models import StockDate
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.tables import snapshots


class StockDateNotFound(LookupError):
    """No parquet directory for (date, code)."""


class QueryEngine:
    """Owns the shared DuckDB connection; exposes cross-table queries (inventory + meta).

    Per-table queries (orderbook, trades, candles, brokers) live in the table
    modules and are called by routes.py directly with this engine's connection.
    """

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._conn = duckdb.connect(database=":memory:", read_only=False)

    def close(self) -> None:
        self._conn.close()

    @property
    def conn(self) -> duckdb.DuckDBPyConnection:
        return self._conn

    def parquet_dir(self, date: str, code: str) -> Path:
        d = self.data_dir / "parquet" / date / code
        if not d.exists():
            raise StockDateNotFound(f"{date}/{code}")
        return d

    def list_stock_dates(self) -> list[StockDate]:
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[StockDate] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            date = date_dir.name
            for code_dir in sorted(date_dir.iterdir()):
                if not (code_dir / "meta.json").exists():
                    continue
                meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
                _state = classify_from_meta(meta)
                snap_path = code_dir / "snapshots.parquet"
                # snapshots.ts_ms is stored as HHMMSSmmm (per existing tests
                # asserting e.g. ts_ms == 90010435). Convert to Unix ms here.
                bounds = (
                    snapshots.query_time_bounds(self._conn, path=snap_path)
                    if snap_path.exists()
                    else None
                )
                open_ms = hhmmssms_to_unix_ms(date, meta["regular_session_open_ms"])
                close_ms = hhmmssms_to_unix_ms(date, meta["regular_session_close_ms"])
                if bounds is not None:
                    first_ms = hhmmssms_to_unix_ms(date, bounds[0])
                    last_ms = hhmmssms_to_unix_ms(date, bounds[1])
                else:
                    first_ms = open_ms
                    last_ms = close_ms

                # Price range + total volume from candles.parquet.
                candles_path = code_dir / "candles.parquet"
                if candles_path.exists():
                    row = self._conn.execute(
                        "SELECT MIN(low), MAX(high), "
                        "COALESCE(SUM(CAST(vol_a AS BIGINT) + CAST(vol_b AS BIGINT)), 0) "
                        "FROM read_parquet(?)",
                        [str(candles_path)],
                    ).fetchone()
                    if row is None or row[0] is None:
                        price_min = 0
                        price_max = 0
                        total_volume = 0
                    else:
                        price_min = int(row[0])
                        price_max = int(row[1])
                        total_volume = int(row[2])
                else:
                    price_min = 0
                    price_max = 0
                    total_volume = 0

                # Stock-Date dirs are flat by construction (parse_stock_date emits
                # only top-level parquet/meta files), so non-recursive iteration is
                # sufficient and intentional here.
                files = [p for p in code_dir.iterdir() if p.is_file()]
                captured_at = (
                    int(max(p.stat().st_mtime for p in files) * 1000) if files else 0
                )
                file_size_bytes = sum(p.stat().st_size for p in files)

                out.append(
                    StockDate(
                        date=date,
                        code=code_dir.name,
                        name=meta["name"],
                        regular_session_open_ms=open_ms,
                        regular_session_close_ms=close_ms,
                        data_window_first_ms=first_ms,
                        data_window_last_ms=last_ms,
                        price_min=price_min,
                        price_max=price_max,
                        captured_at=captured_at,
                        total_volume=total_volume,
                        pages_collected=int(meta["pages_collected"]),
                        file_size_bytes=file_size_bytes,
                        today_open=int(meta["today_open"]),
                        today_high=int(meta["today_high"]),
                        today_low=int(meta["today_low"]),
                        today_close=int(meta["today_close"]),
                        # Single source of truth for meta → completeness bits.
                        # The DiskState enum normalizes the rule "if collection
                        # didn't finish, is_partial is True regardless of what
                        # meta says" — see classify_from_meta docstring.
                        collection_complete=_state in (
                            DiskState.COMPLETE, DiskState.SOURCE_PARTIAL,
                        ),
                        is_partial=_state in (
                            DiskState.SOURCE_PARTIAL, DiskState.CLIENT_INCOMPLETE,
                        ),
                    )
                )
        return out

    def get_meta(self, date: str, code: str) -> dict[str, Any]:
        path = self.parquet_dir(date, code) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))

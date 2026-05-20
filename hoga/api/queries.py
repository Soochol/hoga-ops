"""Cross-table query coordinator. Per-table queries live in ``hoga/tables/``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb

from hoga.api.models import StockDate
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
            for code_dir in sorted(date_dir.iterdir()):
                if not (code_dir / "meta.json").exists():
                    continue
                meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
                snap_path = code_dir / "snapshots.parquet"
                bounds = (
                    snapshots.query_time_bounds(self._conn, path=snap_path)
                    if snap_path.exists()
                    else None
                )
                out.append(
                    StockDate(
                        date=date_dir.name,
                        code=code_dir.name,
                        name=meta["name"],
                        regular_session_open_ms=meta["regular_session_open_ms"],
                        regular_session_close_ms=meta["regular_session_close_ms"],
                        data_window_first_ms=bounds[0]
                        if bounds
                        else meta["regular_session_open_ms"],
                        data_window_last_ms=bounds[1]
                        if bounds
                        else meta["regular_session_close_ms"],
                    )
                )
        return out

    def get_meta(self, date: str, code: str) -> dict[str, Any]:
        path = self.parquet_dir(date, code) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))

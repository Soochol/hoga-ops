"""DuckDB queries against the Parquet data lake."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb


class StockDateNotFound(LookupError):
    """No parquet directory for (code, date)."""


class QueryEngine:
    """One-process shared DuckDB connection."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self._conn = duckdb.connect(database=":memory:", read_only=False)

    def close(self) -> None:
        self._conn.close()

    def parquet_dir(self, date: str, code: str) -> Path:
        d = self.data_dir / "parquet" / date / code
        if not d.exists():
            raise StockDateNotFound(f"{date}/{code}")
        return d

    def list_stock_dates(self) -> list[dict[str, Any]]:
        base = self.data_dir / "parquet"
        if not base.exists():
            return []
        out: list[dict[str, Any]] = []
        for date_dir in sorted(base.iterdir()):
            if not date_dir.is_dir():
                continue
            for code_dir in sorted(date_dir.iterdir()):
                if not (code_dir / "meta.json").exists():
                    continue
                meta = json.loads((code_dir / "meta.json").read_text(encoding="utf-8"))
                ts_range = self._snapshot_time_bounds(code_dir / "snapshots.parquet")
                out.append(
                    {
                        "date": date_dir.name,
                        "code": code_dir.name,
                        "name": meta["name"],
                        "regular_session_open_ms": meta["regular_session_open_ms"],
                        "regular_session_close_ms": meta["regular_session_close_ms"],
                        "data_window_first_ms": ts_range[0]
                        if ts_range
                        else meta["regular_session_open_ms"],
                        "data_window_last_ms": ts_range[1]
                        if ts_range
                        else meta["regular_session_close_ms"],
                    }
                )
        return out

    def _snapshot_time_bounds(self, parquet_path: Path) -> tuple[int, int] | None:
        if not parquet_path.exists():
            return None
        row = self._conn.execute(
            "SELECT min(ts_ms), max(ts_ms) FROM read_parquet(?)",
            [str(parquet_path)],
        ).fetchone()
        if row is None or row[0] is None:
            return None
        return int(row[0]), int(row[1])

    def get_meta(self, date: str, code: str) -> dict[str, Any]:
        path = self.parquet_dir(date, code) / "meta.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def get_orderbook_at(self, date: str, code: str, t_ms: int) -> dict[str, Any] | None:
        path = self.parquet_dir(date, code) / "snapshots.parquet"
        row = self._conn.execute(
            "SELECT * FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1",
            [str(path), t_ms],
        ).fetchone()
        if row is None:
            return None
        cols = [d[0] for d in self._conn.description]
        return dict(zip(cols, row, strict=True))

    def first_snapshot_ts(self, date: str, code: str) -> int | None:
        path = self.parquet_dir(date, code) / "snapshots.parquet"
        row = self._conn.execute("SELECT min(ts_ms) FROM read_parquet(?)", [str(path)]).fetchone()
        if row is None or row[0] is None:
            return None
        return int(row[0])

    def get_trades_up_to(self, date: str, code: str, t_ms: int, limit: int) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "trades.parquet"
        rows = self._conn.execute(
            "SELECT ts_ms, seq, price, change_pct, qty, side, cum_vol, cum_trades, "
            "low_so_far, high_so_far, net_pressure FROM read_parquet(?) "
            "WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
            [str(path), t_ms, limit],
        ).fetchall()
        cols = [
            "ts_ms",
            "seq",
            "price",
            "change_pct",
            "qty",
            "side",
            "cum_vol",
            "cum_trades",
            "low_so_far",
            "high_so_far",
            "net_pressure",
        ]
        return [dict(zip(cols, r, strict=True)) for r in rows]

    def get_trades_in_range(
        self, date: str, code: str, from_ms: int, to_ms: int, limit: int
    ) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "trades.parquet"
        rows = self._conn.execute(
            "SELECT ts_ms, seq, price, change_pct, qty, side, cum_vol, cum_trades, "
            "low_so_far, high_so_far, net_pressure FROM read_parquet(?) "
            "WHERE ts_ms >= ? AND ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
            [str(path), from_ms, to_ms, limit],
        ).fetchall()
        cols = [
            "ts_ms",
            "seq",
            "price",
            "change_pct",
            "qty",
            "side",
            "cum_vol",
            "cum_trades",
            "low_so_far",
            "high_so_far",
            "net_pressure",
        ]
        return [dict(zip(cols, r, strict=True)) for r in rows]

    def get_candles(self, date: str, code: str) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "candles.parquet"
        rows = self._conn.execute(
            'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
            "FROM read_parquet(?) ORDER BY ts_ms ASC",
            [str(path)],
        ).fetchall()
        cols = ["ts_ms", "open", "close", "high", "low", "vol_a", "vol_b"]
        return [dict(zip(cols, r, strict=True)) for r in rows]

    def get_brokers_at(self, date: str, code: str, t_ms: int) -> list[dict[str, Any]]:
        path = self.parquet_dir(date, code) / "brokers.parquet"
        latest = self._conn.execute(
            "SELECT max(ts_ms) FROM read_parquet(?) WHERE ts_ms <= ?",
            [str(path), t_ms],
        ).fetchone()
        if latest is None or latest[0] is None:
            return []
        rows = self._conn.execute(
            "SELECT ts_ms, side, rank, broker, qty_today, qty_delta FROM read_parquet(?) "
            "WHERE ts_ms = ? ORDER BY side, rank",
            [str(path), latest[0]],
        ).fetchall()
        cols = ["ts_ms", "side", "rank", "broker", "qty_today", "qty_delta"]
        return [dict(zip(cols, r, strict=True)) for r in rows]

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import polars as pl

_KST = timezone(timedelta(hours=9))


def _daily_t_ms(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, 9, 0, tzinfo=_KST).timestamp() * 1000)


def read_screener_daily_candles(
    data_dir: Path,
    *,
    code: str,
    frm: date,
    too: date,
    from_label: str,
    to_label: str,
) -> dict:
    path = data_dir / "screener" / "daily_adjusted.parquet"
    warnings: list[dict] = []
    if not path.exists():
        warnings.append({
            "batch": f"{from_label}__{to_label}",
            "reason": "screener_daily_missing",
            "msg": "screener daily_adjusted.parquet not found",
        })
        rows: list[dict] = []
    else:
        df = (
            pl.scan_parquet(path)
            .filter(
                (pl.col("code") == code)
                & (pl.col("date") >= frm)
                & (pl.col("date") <= too)
            )
            .sort("date")
            .select(["date", "open", "high", "low", "close", "volume"])
            .collect()
        )
        rows = [
            {
                "t_ms": _daily_t_ms(row["date"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": int(row["volume"]),
            }
            for row in df.iter_rows(named=True)
        ]
    return {
        "code": code,
        "from": from_label,
        "to": to_label,
        "source": "screener_daily",
        "candles": rows,
        "data_warnings": warnings,
    }

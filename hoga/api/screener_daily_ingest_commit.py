"""Recoverable append with bounded batches; existing OHLCV values are never recalculated."""

from __future__ import annotations

import datetime as dt
import tempfile
from pathlib import Path

import polars as pl
import pyarrow.parquet as pq

from hoga.api.screener_store import _DAILY_PL_SCHEMA, derive_adjusted, last_raw_date, read_status, write_status
from hoga.api.screener_write_lock import publish_history, screener_write_lock
from hoga.util.timeenc import KST

COPY_BATCH_ROWS = 65_536


class StoredRowConflict(ValueError):
    def __init__(self, rows):
        super().__init__("Stored daily rows changed during confirmation")
        self.rows = rows


def _copy_append(source, target, fresh):
    """Parquet has no logical row-order contract. Preserve old rows, append new rows in batches."""
    parquet = pq.ParquetFile(source)
    schema = parquet.schema_arrow
    with pq.ParquetWriter(target, schema, compression="zstd") as writer:
        for batch in parquet.iter_batches(batch_size=COPY_BATCH_ROWS):
            writer.write_batch(batch)
        writer.write_table(fresh.select(schema.names).to_arrow().cast(schema))


def _fresh_rows(sdir, incoming):
    dates = incoming["date"]
    stored = (
        pl.scan_parquet(sdir / "daily_unadjusted.parquet")
        .filter(
            pl.col("code").is_in(incoming["code"].unique().to_list()),
            pl.col("date").is_between(dates.min(), dates.max()),
        )
        .collect()
    )
    overlap = incoming.join(stored, on=["code", "date"], suffix="_stored")
    conflicts = overlap.filter(
        pl.any_horizontal(
            [pl.col(key) != pl.col(key + "_stored") for key in ("open", "high", "low", "close", "volume")]
        )
    )
    if not conflicts.is_empty():
        raise StoredRowConflict(conflicts.to_dicts())
    return incoming.join(stored.select("code", "date"), on=["code", "date"], how="anti")


def _derive_new(sdir, stage, fresh):
    # Legacy fallback uses future closes. Include its bounded historical context
    # for missing factor Codes, then retain only fresh keys from the result.
    from hoga.api.screener_factors import read_factors  # noqa: PLC0415

    factors = read_factors(sdir / "factors.parquet")
    covered = set(factors["code"].to_list()) if factors is not None else set()
    missing = sorted(set(fresh["code"].to_list()) - covered)
    context = fresh
    if missing:
        historical = (
            pl.scan_parquet(sdir / "daily_unadjusted.parquet")
            .filter(pl.col("code").is_in(missing), pl.col("date") >= fresh["date"].min())
            .collect()
        )
        context = pl.concat([historical, fresh]).unique(subset=["code", "date"], keep="last")
    elapsed = derive_adjusted(
        sdir / "daily_unadjusted.parquet",
        stage / "new_adjusted.parquet",
        factors_path=sdir / "factors.parquet",
        unadjusted_df=context,
    )
    derived = pl.read_parquet(stage / "new_adjusted.parquet").join(
        fresh.select("code", "date"), on=["code", "date"], how="semi"
    )
    return derived, elapsed


def _status(sdir, derive_ms, *, force=False):
    last = last_raw_date(sdir / "daily_unadjusted.parquet")
    status = read_status(sdir / "status.json")
    if force or status is None or status.last_raw_date != last:
        write_status(
            sdir / "status.json",
            last_raw_date=last,
            universe_size=pl.scan_parquet(sdir / "daily_unadjusted.parquet")
            .select(pl.col("code").n_unique())
            .collect()
            .item(),
            derive_ms=derive_ms,
            now_ms=int(dt.datetime.now(KST).timestamp() * 1000),
        )


def append_confirmed_rows(data_dir, rows):
    if not rows:
        return 0
    sdir = data_dir / "screener"
    with screener_write_lock(sdir):
        incoming = pl.DataFrame(
            [{**r, "date": dt.date.fromisoformat(r["date"])} for r in rows], schema=_DAILY_PL_SCHEMA
        )
        fresh = _fresh_rows(sdir, incoming)
        if fresh.is_empty():
            _status(sdir, 0)  # repairs a crash after journal publication but before status
            return 0
        with tempfile.TemporaryDirectory(prefix="daily-ingest-", dir=sdir) as directory:
            stage = Path(directory)
            derived, derive_ms = _derive_new(sdir, stage, fresh)
            _copy_append(sdir / "daily_unadjusted.parquet", stage / "daily_unadjusted.parquet", fresh)
            _copy_append(sdir / "daily_adjusted.parquet", stage / "daily_adjusted.parquet", derived)
            publish_history(sdir, stage)
        _status(sdir, derive_ms, force=True)
        return fresh["date"].n_unique()

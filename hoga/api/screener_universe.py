from __future__ import annotations

from pathlib import Path

import polars as pl

from hoga.api.models import ScreenerUniverse


def duckdb_wheres(universe: ScreenerUniverse) -> tuple[list[str], list]:
    wheres, params = [], []
    if universe.markets:
        placeholders = ",".join(["?"] * len(universe.markets))
        wheres.append(f"stk.market IN ({placeholders})")
        params += list(universe.markets)
    if universe.exclude_etf:
        wheres.append("NOT stk.is_etf")
    if universe.exclude_halted:
        wheres.append("NOT stk.is_halted")
    return wheres, params


def filter_stocks_df(df: pl.DataFrame, universe: ScreenerUniverse) -> pl.DataFrame:
    if universe.markets:
        df = df.filter(pl.col("market").is_in(universe.markets))
    if universe.exclude_etf:
        df = df.filter(~pl.col("is_etf"))
    if universe.exclude_halted:
        df = df.filter(~pl.col("is_halted"))
    return df.filter(
        pl.col("code").is_not_null()
        & pl.col("name").is_not_null()
        & pl.col("market").is_in(["KOSPI", "KOSDAQ"])
    )


def codes_for_universe(stocks_path: Path, universe: ScreenerUniverse) -> list[str]:
    return (
        filter_stocks_df(pl.read_parquet(stocks_path), universe)
        .select("code")
        .to_series()
        .cast(pl.Utf8)
        .to_list()
    )

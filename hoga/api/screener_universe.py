from __future__ import annotations

import logging
from pathlib import Path

import polars as pl

from hoga.api.models import ScreenerUniverse

log = logging.getLogger(__name__)


def scope_codes(data_dir: Path, scopes: list[str]) -> set[str] | None:
    """유니버스 스코프(watchlist/heatmap) 코드 집합. scopes 비면 None(무제한).

    체크된 스코프의 합집합. 로더 실패(파일 부재/손상)가 스캔을 죽이면 안 되므로
    per-source try/except — screener_depth._depth_universe 와 동일 관용구. import
    cycle 회피 위해 함수 내부 지연 import. 반환이 빈 set 이면 스코프는 켰지만 대상이
    0종목(호출자가 scope_universe_empty warning 으로 조건 미충족과 구분)."""
    if not scopes:
        return None
    from hoga.api import heatmap, watchlist  # noqa: PLC0415 — import cycle 회피
    codes: set[str] = set()
    if "heatmap" in scopes:
        try:
            codes.update(e.code for e in heatmap.load_heatmap(data_dir))
        except Exception:  # noqa: BLE001 — 히트맵 부재/손상이 스캔을 죽이면 안 됨
            log.exception("scope_codes: heatmap load failed")
    if "watchlist" in scopes:
        try:
            codes.update(e.code for e in watchlist.load_watchlist(data_dir))
        except Exception:  # noqa: BLE001
            log.exception("scope_codes: watchlist load failed")
    return codes


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


def filter_stocks_df(
    df: pl.DataFrame,
    universe: ScreenerUniverse,
    *,
    scope: set[str] | None = None,
) -> pl.DataFrame:
    if universe.markets:
        df = df.filter(pl.col("market").is_in(universe.markets))
    if universe.exclude_etf:
        df = df.filter(~pl.col("is_etf"))
    if universe.exclude_halted:
        df = df.filter(~pl.col("is_halted"))
    if scope is not None:
        df = df.filter(pl.col("code").is_in(list(scope)))
    return df.filter(
        pl.col("code").is_not_null()
        & pl.col("name").is_not_null()
        & pl.col("market").is_in(["KOSPI", "KOSDAQ"])
    )


def codes_for_universe(
    stocks_path: Path,
    universe: ScreenerUniverse,
    *,
    scope: set[str] | None = None,
) -> list[str]:
    return (
        filter_stocks_df(pl.read_parquet(stocks_path), universe, scope=scope)
        .select("code")
        .to_series()
        .cast(pl.Utf8)
        .to_list()
    )

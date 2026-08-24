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
        except Exception:  # 히트맵 부재/손상이 스캔을 죽이면 안 됨
            log.exception("scope_codes: heatmap load failed")
    if "watchlist" in scopes:
        try:
            codes.update(e.code for e in watchlist.load_watchlist(data_dir))
        except Exception:
            log.exception("scope_codes: watchlist load failed")
    return codes


def duckdb_wheres(universe: ScreenerUniverse) -> tuple[list[str], list]:
    """유니버스 → (WHERE 조각, 파라미터). ``stk`` 뷰가 이미 서 있다고 가정한다.

    ``exclude_etf`` 는 ``stk.is_etf`` 를 그대로 읽는다 — 그 컬럼을 심볼 마스터로
    덮어쓰는 일은 뷰를 세우는 쪽(screener_scan.run_scan)이 한다. 판정 소스를
    바꾸면서도 이 함수가 그대로인 이유다(is_etf 는 "ETF 인가"라는 질문이지,
    "어느 파일이 그렇게 말했나"가 아니다)."""
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


def apply_etf_master(df: pl.DataFrame, etf_codes: frozenset[str] | None) -> pl.DataFrame:
    """``is_etf`` 를 심볼 마스터(키움 ``ka10099`` 의 증권그룹구분코드) 기준으로 덮어쓴다.

    stocks.parquet 의 ``is_etf`` 는 외부 DB 에서 **수동 1회 시드**된 정적 스냅샷이라
    시간이 지나면 낡는다(실측 2026-08-01: 시드 후 2개월간 갱신 경로 없음 → 마스터가
    ETF 로 아는 127 종목이 ``is_etf=false`` 로 남아 "ETF 제외"를 통과했다). 마스터는
    부팅마다 재다운로드되므로 신규 상장 ETF 도 따라간다.

    합집합(OR)인 이유: 마스터에 없는 코드는 판정 불가일 뿐 "ETF 아님"이 아니다
    (symbols.all_etf_etn_codes 참조). 시드가 ETF 라고 표시한 종목을 마스터 부재만
    믿고 되살리면 이미 맞던 판정을 깨뜨린다. 실측상 시드의 오탐은 0 건이었다.

    ``etf_codes`` 가 None(마스터 미로드)이면 df 를 그대로 — 낡았을지언정 시드 판정이
    아무 필터도 없는 것보다 낫다. 호출처가 warning 으로 이 강등을 알린다."""
    if etf_codes is None:
        return df
    return df.with_columns(
        (pl.col("is_etf") | pl.col("code").is_in(list(etf_codes))).alias("is_etf")
    )


def filter_stocks_df(
    df: pl.DataFrame,
    universe: ScreenerUniverse,
    *,
    scope: set[str] | None = None,
    etf_codes: frozenset[str] | None = None,
) -> pl.DataFrame:
    if universe.exclude_etf:
        df = apply_etf_master(df, etf_codes)
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
    etf_codes: frozenset[str] | None = None,
) -> list[str]:
    return (
        filter_stocks_df(
            pl.read_parquet(stocks_path), universe, scope=scope, etf_codes=etf_codes
        )
        .select("code")
        .to_series()
        .cast(pl.Utf8)
        .to_list()
    )

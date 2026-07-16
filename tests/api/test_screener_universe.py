import polars as pl

from hoga.api.models import ScreenerUniverse
from hoga.api import screener_universe


def test_codes_for_universe_filters_stock_table(tmp_path):
    stocks = tmp_path / "stocks.parquet"
    pl.DataFrame({
        "code": ["000111", "000222", "000333", "000444"],
        "name": ["a", "b", "c", None],
        "market": ["KOSPI", "KOSDAQ", "KOSPI", "KOSPI"],
        "is_etf": [False, False, True, False],
        "is_halted": [False, True, False, False],
    }).write_parquet(stocks)

    codes = screener_universe.codes_for_universe(
        stocks,
        ScreenerUniverse(markets=["KOSPI"], exclude_etf=True, exclude_halted=True),
    )

    assert codes == ["000111"]


def test_duckdb_wheres_mirror_universe_flags():
    wheres, params = screener_universe.duckdb_wheres(
        ScreenerUniverse(markets=["KOSPI"], exclude_etf=True, exclude_halted=True),
    )

    assert wheres == ["stk.market IN (?)", "NOT stk.is_etf", "NOT stk.is_halted"]
    assert params == ["KOSPI"]


def test_scope_codes_none_when_no_scopes(tmp_path):
    assert screener_universe.scope_codes(tmp_path, []) is None


def test_scope_codes_union_of_watchlist_and_heatmap(tmp_path):
    from hoga.api.heatmap import save_document as save_heatmap
    from hoga.api.watchlist import save_document as save_watchlist
    from hoga.api.models import (
        HeatmapDocument, HeatmapEntry, WatchlistDocument, WatchlistEntry,
        WatchlistFolder,
    )
    save_heatmap(tmp_path, HeatmapDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=0)],
        entries=[HeatmapEntry(code="000111", name="a", folder_id="f_0000000a")]))
    save_watchlist(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000b", name="B", order=0,
                                 member_codes=["000222"])],
        entries=[WatchlistEntry(code="000222", name="b",
                                registered_at_kst_date="20260716")]))

    assert screener_universe.scope_codes(tmp_path, ["heatmap"]) == {"000111"}
    assert screener_universe.scope_codes(tmp_path, ["watchlist"]) == {"000222"}
    assert screener_universe.scope_codes(
        tmp_path, ["watchlist", "heatmap"]) == {"000111", "000222"}


def test_scope_codes_missing_sources_yield_empty_set(tmp_path):
    # 파일 부재는 로더 내부에서 흡수 — 크래시 없이 빈 집합(스코프는 켜짐 → None 아님).
    result = screener_universe.scope_codes(tmp_path, ["watchlist", "heatmap"])
    assert result == set()


def test_codes_for_universe_intersects_scope(tmp_path):
    stocks = tmp_path / "stocks.parquet"
    pl.DataFrame({
        "code": ["000111", "000222", "000333"],
        "name": ["a", "b", "c"],
        "market": ["KOSPI", "KOSPI", "KOSPI"],
        "is_etf": [False, False, False],
        "is_halted": [False, False, False],
    }).write_parquet(stocks)

    codes = screener_universe.codes_for_universe(
        stocks, ScreenerUniverse(), scope={"000111", "000333"})

    assert sorted(codes) == ["000111", "000333"]

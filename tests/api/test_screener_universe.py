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

import polars as pl

from hoga.api import screener_universe
from hoga.api.models import ScreenerUniverse


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


def test_exclude_etf_uses_symbol_master_over_stale_seed(tmp_path):
    """stocks.parquet 의 is_etf 가 낡아도 마스터가 아는 ETF 는 제외된다.

    회귀 대상(2026-08-01 실측): stocks.parquet 은 외부 DB 에서 수동 1회 시드된 뒤
    갱신 경로가 없어 2개월간 고정돼 있었고, 마스터가 ETF 로 아는 127 종목이
    is_etf=false 로 남아 "ETF 제외"를 그대로 통과했다."""
    stocks = tmp_path / "stocks.parquet"
    pl.DataFrame({
        "code": ["000111", "069660", "000333"],
        "name": ["보통주", "KIWOOM 200(시드가 놓친 ETF)", "시드가 아는 ETF"],
        "market": ["KOSPI", "KOSPI", "KOSPI"],
        "is_etf": [False, False, True],
        "is_halted": [False, False, False],
    }).write_parquet(stocks)
    universe = ScreenerUniverse(exclude_etf=True)

    codes = screener_universe.codes_for_universe(
        stocks, universe, etf_codes=frozenset({"069660"}))
    assert codes == ["000111"]

    # 마스터가 모르는 코드는 시드 판정을 유지한다 — OR 이지 덮어쓰기가 아니다.
    # (마스터 부재 = "판정 불가"이지 "ETF 아님"이 아니므로 000333 을 되살리면 안 된다.)
    assert screener_universe.codes_for_universe(
        stocks, universe, etf_codes=frozenset()) == ["000111", "069660"]


def test_exclude_etf_falls_back_to_seed_when_master_unavailable(tmp_path):
    """etf_codes=None(마스터 미로드) → 낡은 is_etf 로 강등. 필터가 통째로 죽지는 않는다."""
    stocks = tmp_path / "stocks.parquet"
    pl.DataFrame({
        "code": ["000111", "069660", "000333"],
        "name": ["보통주", "시드가 놓친 ETF", "시드가 아는 ETF"],
        "market": ["KOSPI", "KOSPI", "KOSPI"],
        "is_etf": [False, False, True],
        "is_halted": [False, False, False],
    }).write_parquet(stocks)

    codes = screener_universe.codes_for_universe(
        stocks, ScreenerUniverse(exclude_etf=True), etf_codes=None)

    assert codes == ["000111", "069660"]


def test_etf_master_not_applied_when_exclude_etf_off(tmp_path):
    """토글이 꺼져 있으면 마스터 코드셋이 있어도 ETF 를 거르지 않는다."""
    stocks = tmp_path / "stocks.parquet"
    pl.DataFrame({
        "code": ["000111", "069660"],
        "name": ["보통주", "ETF"],
        "market": ["KOSPI", "KOSPI"],
        "is_etf": [False, False],
        "is_halted": [False, False],
    }).write_parquet(stocks)

    codes = screener_universe.codes_for_universe(
        stocks, ScreenerUniverse(), etf_codes=frozenset({"069660"}))

    assert sorted(codes) == ["000111", "069660"]


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
    from hoga.api.models import (
        HeatmapDocument,
        HeatmapEntry,
        WatchlistDocument,
        WatchlistEntry,
        WatchlistFolder,
    )
    from hoga.api.watchlist import save_document as save_watchlist
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

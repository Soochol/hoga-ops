

"""screener_store — 스크리너 코퍼스 저장 계층의 계약.

현재는 로스터(stocks.parquet) 갱신만 다룬다.
"""
from __future__ import annotations

# ── 로스터가 신규 상장을 따라간다 (2026-08-03) ──────────────────────────────
#
# stocks.parquet 은 외부 DB 에서 수동 1회 시드된 스냅샷이고 갱신 경로가 없었다.
# 일봉 갱신 대상 목록이 이 파일에서 나오므로(screener._build_plan), 여기 없는
# 종목은 봉을 받지도 못하고 스크리너에 나타날 수도 없다 — 실측 79 종목.


def _seed_roster(path, rows):
    import polars as pl
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(
        {
            "code": [r[0] for r in rows], "name": [r[1] for r in rows],
            "market": [r[2] for r in rows], "is_etf": [r[3] for r in rows],
            "is_halted": [r[4] for r in rows],
        },
        schema={"code": pl.Utf8, "name": pl.Utf8, "market": pl.Utf8,
                "is_etf": pl.Boolean, "is_halted": pl.Boolean},
    ).write_parquet(path)


def test_roster_merge_adds_only_newly_listed(tmp_path) -> None:
    import polars as pl

    from hoga.api.screener_store import merge_roster_from_master

    p = tmp_path / "screener" / "stocks.parquet"
    _seed_roster(p, [("005930", "삼성전자", "KOSPI", False, False)])

    added = merge_roster_from_master(p, [
        ("005930", "삼성전자", "KOSPI", False),      # 이미 있음
        ("0001A0", "덕양에너젠", "KOSDAQ", False),   # 신규
        ("069500", "KODEX 200", "KOSPI", True),      # 신규(ETF)
    ])

    assert added == 2
    df = pl.read_parquet(p).sort("code")
    assert df["code"].to_list() == ["0001A0", "005930", "069500"]
    assert df.filter(pl.col("code") == "069500")["is_etf"].item() is True
    # 마스터가 답을 못 주는 축은 False — 근거는 함수 docstring.
    assert df.filter(pl.col("code") == "0001A0")["is_halted"].item() is False
    assert df.columns == ["code", "name", "market", "is_etf", "is_halted"]


def test_roster_merge_never_removes_existing_rows(tmp_path) -> None:
    """마스터에 없다고 지우면 안 된다 — 실측상 그런 기존 코드가 916 개였고
    대부분 ETF/ETN 과 구 종목이라, 지우는 구현이었다면 대량으로 날렸다.
    상장폐지 처리는 과거 일봉·캡처 이력과 얽힌 별개 결정이다."""
    import polars as pl

    from hoga.api.screener_store import merge_roster_from_master

    p = tmp_path / "screener" / "stocks.parquet"
    _seed_roster(p, [
        ("005930", "삼성전자", "KOSPI", False, False),
        ("099999", "상장폐지된것", "KOSDAQ", False, True),
    ])

    merge_roster_from_master(p, [("005930", "삼성전자", "KOSPI", False)])

    assert set(pl.read_parquet(p)["code"]) == {"005930", "099999"}


def test_roster_merge_is_a_no_op_when_master_is_unavailable(tmp_path) -> None:
    """마스터 미로드(None)를 '상장 종목 0개' 로 읽으면 안 된다."""
    import polars as pl

    from hoga.api.screener_store import merge_roster_from_master

    p = tmp_path / "screener" / "stocks.parquet"
    _seed_roster(p, [("005930", "삼성전자", "KOSPI", False, False)])

    assert merge_roster_from_master(p, None) == 0
    assert pl.read_parquet(p).height == 1


def test_daily_run_refreshes_the_roster_before_updating_bars() -> None:
    """순서가 계약이다 — 로스터를 먼저 넣어야 같은 런에서 그 종목 봉을 받는다."""
    import inspect

    from hoga.api import scheduler

    # 거래일 게이트 뒤 단계에 있다 — 휴장일에는 로스터도 건드리지 않는다.
    src = inspect.getsource(scheduler.run_trading_stage)
    assert "merge_roster_from_master" in src
    assert src.index("merge_roster_from_master") < src.index("screener.trigger_update")

import pytest, polars as pl, datetime as dt
from hoga.api import screener_store
from hoga.api.screener_store import DailyBar


@pytest.mark.asyncio
async def test_run_update_appends_and_derives(tmp_path):
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")
    async def fake_fetch(code, frm, to) -> list[DailyBar]:   # async — matches real adapter
        return [DailyBar(code=code, date=dt.date(2026, 5, 14),
                         open=2.0, high=2.0, low=2.0, close=2.0, volume=2)]
    n = await screener_store.run_update(sd, codes=["000001"], fetch_one=fake_fetch,
                                        trading_days=["20260514"], now_ms=100)
    assert n == 1
    assert (sd / "daily_adjusted.parquet").exists()
    assert screener_store.read_status(sd / "status.json").last_raw_date == "20260514"


@pytest.mark.asyncio
async def test_run_update_counts_distinct_appended_dates_not_requested(tmp_path):
    # #9: gap=2 거래일이지만 상류가 1일치만 반환 → 반환값은 실제 추가된 distinct date
    # 수(1), 요청 거래일 수(len(trading_days)=2)로 과대보고하지 않는다.
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")
    async def fake_fetch(code, frm, to) -> list[DailyBar]:
        return [DailyBar(code=code, date=dt.date(2026, 5, 14),
                         open=2.0, high=2.0, low=2.0, close=2.0, volume=2)]  # 2일 요청, 1일만 반환
    n = await screener_store.run_update(sd, codes=["000001"], fetch_one=fake_fetch,
                                        trading_days=["20260514", "20260515"], now_ms=100)
    assert n == 1


def test_fetch_concurrency_defaults_to_three(monkeypatch):
    from hoga.api import screener_store

    monkeypatch.delenv("HOGA_SCREENER_FETCH_CONCURRENCY", raising=False)

    assert screener_store.fetch_concurrency_from_env() == 3


def test_fetch_concurrency_accepts_valid_range(monkeypatch):
    from hoga.api import screener_store

    monkeypatch.setenv("HOGA_SCREENER_FETCH_CONCURRENCY", "1")
    assert screener_store.fetch_concurrency_from_env() == 1

    monkeypatch.setenv("HOGA_SCREENER_FETCH_CONCURRENCY", "8")
    assert screener_store.fetch_concurrency_from_env() == 8


def test_fetch_concurrency_falls_back_for_invalid_values(monkeypatch):
    from hoga.api import screener_store

    for value in ["0", "9", "-1", "abc", ""]:
        monkeypatch.setenv("HOGA_SCREENER_FETCH_CONCURRENCY", value)
        assert screener_store.fetch_concurrency_from_env() == 3

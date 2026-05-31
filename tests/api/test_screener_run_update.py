import pytest, polars as pl, datetime as dt
from hoga.api import screener_store


@pytest.mark.asyncio
async def test_run_update_appends_and_derives(tmp_path):
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
        "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_unadjusted.parquet")
    async def fake_fetch(code, frm, to):   # async — matches real adapter
        return [{"code": code, "date": dt.date(2026, 5, 14), "open": 2.0,
                 "high": 2.0, "low": 2.0, "close": 2.0, "volume": 2}]
    n = await screener_store.run_update(sd, codes=["000001"], fetch_one=fake_fetch,
                                        trading_days=["20260514"], now_ms=100)
    assert n == 1
    assert (sd / "daily_adjusted.parquet").exists()
    assert screener_store.read_status(sd / "status.json").last_raw_date == "20260514"

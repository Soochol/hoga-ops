"""Partially known calendars still permit matches in fully observed later windows."""
import datetime as dt

import polars as pl
import pytest

from hoga.api import screener_history_coverage as coverage
from hoga.api.models import HistoryVolumeParams, NewHighVolLeaf
from hoga.api.screener_store import _DAILY_PL_SCHEMA


@pytest.mark.parametrize(
    ("unit", "value", "start", "end", "days", "expected"),
    [
        ("years", 2, "2008-01-01", "2010-01-04",
         ["2007-01-02", "2008-01-02", "2009-01-05", "2010-01-04"], "2010-01-04"),
        # A present candle is insufficient when its two-year window starts
        # before calendar coverage, even if the requested lower bound is older.
        ("years", 2, "2008-01-01", "2008-01-02",
         ["2007-01-02", "2008-01-02"], None),
        ("trading_days", 3, "2019-01-02", "2019-01-04",
         ["2019-01-02", "2019-01-03", "2019-01-04"], "2019-01-04"),
        ("trading_days", 3, "2019-01-02", "2019-01-03",
         ["2019-01-02", "2019-01-03"], None),
        # An unknown suffix does not invalidate an already confirmed event.
        ("trading_days", 2, "2019-01-03", "2019-01-07",
         ["2019-01-02", "2019-01-03", "2019-01-04"], "2019-01-04"),
        ("trading_days", 1, "2019-01-07", "2019-01-07",
         ["2019-01-02", "2019-01-03", "2019-01-04"], None),
    ],
)
def test_partial_calendar_preserves_only_complete_window_matches(
    tmp_path, monkeypatch, unit, value, start, end, days, expected,
):
    monkeypatch.setattr(coverage.trading_days, "trading_days", lambda _: [d.replace("-", "") for d in days])
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame([
        dict(code="005930", date=dt.date.fromisoformat(day), open=100., high=100.,
             low=100., close=100., volume=100)
        for day in days
    ], schema=_DAILY_PL_SCHEMA).write_parquet(sdir / "daily_adjusted.parquet")
    pl.DataFrame(dict(code=["005930"], seg_start=[dt.date.fromisoformat(days[0])],
                      factor=[1.])).write_parquet(sdir / "factors.parquet")
    leaf = NewHighVolLeaf(id="volume", params=HistoryVolumeParams(
        mode="date_range", start_date=start, end_date=end,
        record_period={"unit": unit, "value": value}))

    result = coverage.evaluate(tmp_path, [leaf], ["005930"])

    assert result.coverage.complete == 0
    assert result.coverage.incomplete[0].reason == "calendar_unavailable"
    if expected:
        assert result.passing[leaf.id] == ["005930"]
        assert result.matches["005930"][0].date == expected
    else:
        assert result.passing[leaf.id] == []
        assert result.matches == {}


def test_authoritative_factors_required_and_factor_changes_invalidate_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(coverage.trading_days, "trading_days", lambda _: ["20190102"])
    sdir = tmp_path / "screener"
    sdir.mkdir()
    day = dt.date(2019, 1, 2)
    pl.DataFrame([dict(code="005930", date=day, open=100., high=100., low=100.,
                       close=100., volume=100)], schema=_DAILY_PL_SCHEMA).write_parquet(
        sdir / "daily_adjusted.parquet")
    leaf = NewHighVolLeaf(id="v", params=HistoryVolumeParams(
        mode="date_range", start_date=day.isoformat(), end_date=day.isoformat(),
        record_period={"unit": "trading_days", "value": 1}))

    def evaluate():
        return coverage.evaluate(tmp_path, [leaf], ["005930"])

    missing = evaluate()
    assert missing.passing["v"] == []
    assert missing.coverage.complete == 0
    assert missing.coverage.incomplete[0].reason == "factor_unavailable"
    assert missing.coverage.incomplete[0].missing_days == 0
    factors = pl.DataFrame(dict(code=["005930"], seg_start=[day], factor=[1.]))
    factors.write_parquet(sdir / "factors.parquet")
    supported = evaluate()
    assert supported.passing["v"] == ["005930"]
    assert supported.coverage.complete == 1
    # Keep the adjusted file unchanged; replacing factor coverage alone must
    # invalidate the cached successful result, including when other codes exist.
    factors.with_columns(pl.lit("000660").alias("code")).write_parquet(sdir / "factors.parquet")
    unsupported = evaluate()
    assert unsupported.passing["v"] == []
    assert unsupported.coverage.incomplete[0].reason == "factor_unavailable"
    (sdir / "factors.parquet").unlink()
    assert evaluate().passing["v"] == []
    (sdir / "factors.parquet").write_bytes(b"damaged parquet")
    assert evaluate().coverage.incomplete[0].reason == "factor_unavailable"
    assert (sdir / "factors.parquet").read_bytes() == b"damaged parquet"
    assert not list(sdir.glob("*.corrupt-*"))

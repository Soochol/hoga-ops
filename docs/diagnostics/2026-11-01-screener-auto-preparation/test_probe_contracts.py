"""Behavior checks for the offline proposal, using production scans and stores."""

import datetime as dt
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest

from hoga.api import (
    screener_history_jobs,
    screener_series_jobs as jobs,
    screener_series_store as store,
    symbols,
    trading_days,
)
from hoga.api.models import ScanRequest
from hoga.api.screener_history_state import create_job
from hoga.api.screener_series_runner import run_scan
from hoga.api.screener_store import _DAILY_PL_SCHEMA

SPEC = importlib.util.spec_from_file_location("auto_preparation_probe", Path(__file__).with_name("probe.py"))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
DAYS = [dt.date(2026, 10, day) for day in (28, 29, 30)]
CODES = ["000020", "005930"]


class FrozenDateTime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return probe.NOW.astimezone(tz) if tz is not None else probe.NOW.replace(tzinfo=None)


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "dt", SimpleNamespace(datetime=FrozenDateTime))
    monkeypatch.setattr(trading_days, "trading_days", lambda _: [day.strftime("%Y%m%d") for day in DAYS])
    monkeypatch.setattr(symbols, "all_etf_etn_codes", lambda: None)
    root = tmp_path / "input"
    sd = root / "screener"
    sd.mkdir(parents=True)
    rows = [dict(code=code, date=day, open=100., high=110., low=90., close=105., volume=100)
            for code in CODES for day in DAYS]
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet"):
        pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA).write_parquet(sd / name)
    pl.DataFrame(dict(code=CODES, name=CODES, market=["KOSPI"] * len(CODES),
                      is_etf=[False] * len(CODES), is_halted=[False] * len(CODES))).write_parquet(sd / "stocks.parquet")
    return root


def request(kind):
    return ScanRequest.model_validate(dict(calculation_policy="separate_bases_v2", basis="eod",
                                          conditions=[dict(id="test", type=kind, params=dict(period=3))]))


@pytest.mark.asyncio
async def test_batch_and_serial_produce_identical_real_scan_results(corpus):
    incoming = probe.observations(corpus, CODES, DAYS)
    for code, value in incoming:
        store._publish(corpus, "observations", code, value, anchor=probe.ANCHOR)
    serial = await run_scan(data_dir=corpus, req=request("new_high_today"), now=probe.NOW)
    assert {row.code for row in serial.rows} == set(CODES)
    (store.root(corpus) / "current.json").unlink()
    probe.publish_batch(corpus, incoming)
    batch = await run_scan(data_dir=corpus, req=request("new_high_today"), now=probe.NOW)
    assert [row.model_dump() for row in batch.rows] == [row.model_dump() for row in serial.rows]
    assert batch.bar_coverage.model_dump() == serial.bar_coverage.model_dump()


@pytest.mark.asyncio
async def test_price_prepared_does_not_mean_quantity_evidence_is_ready(corpus):
    probe.publish_batch(corpus, probe.observations(corpus, CODES, DAYS))
    pinned = store.load_snapshot(corpus)
    for code in CODES:
        assert jobs._prepared(corpus, pinned, code, {day.isoformat() for day in DAYS})
    result = await run_scan(data_dir=corpus, req=request("new_high_vol_today"), now=probe.NOW)
    assert result.rows == []
    assert result.bar_coverage.complete == 0
    assert {item.reason for item in result.bar_coverage.incomplete} == {"share_evidence_unavailable"}


@pytest.mark.asyncio
async def test_warm_production_preparation_does_not_call_provider(corpus, monkeypatch):
    probe.publish_batch(corpus, probe.observations(corpus, CODES, DAYS))
    calls = []

    async def forbidden(*args, **kwargs):
        calls.append(args)
        raise AssertionError("warm observations must be reused")

    monkeypatch.setattr(screener_history_jobs, "fetch_pair", forbidden)
    job = create_job(request("new_high_today"), CODES)
    await jobs.run_job(corpus, job)
    assert calls == []
    assert job.status == "complete"
    assert job.done == len(CODES)
    assert job.coverage.complete == len(CODES)


def test_warm_price_coverage_requires_same_adjustment_basis(corpus):
    incoming = probe.observations(corpus, CODES, DAYS)
    probe.publish_batch(corpus, incoming)
    required = {day.isoformat() for day in DAYS}
    assert jobs._prepared(corpus, store.load_snapshot(corpus), CODES[0], required)
    older = {**incoming[0][1], "adjusted_as_of": "2026-10-31"}
    # Use a fresh current pointer so the intentionally older basis is a valid first observation.
    (store.root(corpus) / "current.json").unlink()
    store._publish(corpus, "observations", CODES[0], older, anchor="2026-10-31")
    assert not jobs._prepared(corpus, store.load_snapshot(corpus), CODES[0], required)

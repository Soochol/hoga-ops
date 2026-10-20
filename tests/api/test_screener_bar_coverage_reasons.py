"""Coverage explains known facts without guessing listing or suspension dates."""
import datetime as dt

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from hoga.api import screener_bar_volume as bars, screener_history_evidence as evidence
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.api.screener_runner import run_screener_scan
from hoga.api.screener_store import _DAILY_PL_SCHEMA
from hoga.util.timeenc import KST


def write_evidence(root, records):
    payload = evidence.EvidenceFile(records={
        code: evidence.HistoryEvidence(
            name=code, checked_at=dt.datetime(2026, 9, 22, 18, tzinfo=KST),
            sources=["https://kind.krx.co.kr/"], **facts)
        for code, facts in records.items()
    })
    (root / "screener" / "history_evidence.json").write_text(payload.model_dump_json())


@pytest.fixture
def setup(tmp_path, monkeypatch):
    days = [dt.date(2026, 9, d) for d in (14, 15, 16, 17, 18, 21, 22)]
    monkeypatch.setattr(bars.trading_days, "trading_days", lambda _: {d.strftime("%Y%m%d") for d in days})
    by_code = {
        "000001": [17, 18, 21, 22], "000002": [21, 22],
        "000003": [18, 21, 22], "000004": [17, 18],
        "000005": [17, 18], "000006": [18, 21, 22],
    }
    sdir = tmp_path / "screener"
    sdir.mkdir()
    (sdir / "status.json").write_text('{}')
    pl.DataFrame([
        dict(code=code, date=dt.date(2026, 9, day), open=100., high=101., low=99., close=100., volume=10)
        for code, dates in by_code.items() for day in dates
    ], schema=_DAILY_PL_SCHEMA).write_parquet(sdir / "daily_adjusted.parquet")
    pl.DataFrame([
        dict(code=code, name=code, market="KOSPI", is_etf=False, is_halted=False)
        for code in by_code
    ]).write_parquet(sdir / "stocks.parquet")
    write_evidence(tmp_path, {
        "000002": {"listing_date": "2026-09-21"},
        "000003": {"vendor_dates": ["2026-09-17"]},
        "000004": {"delisting_date": "2026-09-21"},
        "000005": {"suspended_from": "2026-09-21", "suspended_to": "2026-09-22"},
    })
    req = ScanRequest.model_validate({"basis": "eod", "conditions": [
        {"id": "b", "type": "bollinger_position", "params": {"period": 3, "lookback": 2}},
    ]})
    return tmp_path, req, dt.datetime(2026, 9, 22, 18, tzinfo=KST)


async def test_http_separates_listing_delisting_collection_suspension_and_unknown(setup):
    root, req, now = setup
    app = FastAPI()

    @app.get("/scan")
    async def scan() -> ScreenerResponse:
        return await run_screener_scan(data_dir=root, req=req, now=now)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/scan")
    assert response.status_code == 200
    coverage = response.json()["bar_coverage"]
    assert (coverage["complete"], coverage["total"]) == (1, 6)
    items = {item["code"]: item for item in coverage["incomplete"]}
    assert {code: item["reason"] for code, item in items.items()} == {
        "000002": "pre_listing_history", "000003": "collection_missing",
        "000004": "delisted", "000005": "trading_suspended", "000006": "missing_daily_history",
    }
    assert items["000002"]["missing_days"] == 2
    assert items["000002"]["required_from"] == "2026-09-17"
    assert items["000003"]["required_to"] == "2026-09-17"
    assert items["000003"]["name"] == "000003"


async def test_calendar_shortage_is_not_misreported_as_stock_history(setup, monkeypatch):
    root, req, now = setup
    monkeypatch.setattr(bars.trading_days, "trading_days", lambda _: {"20260921", "20260922"})
    result = await run_screener_scan(data_dir=root, req=req, now=now)
    assert {item.reason for item in result.bar_coverage.incomplete if item.code == "000001"} == {
        "calendar_unavailable"}
    assert all(item.reason != "missing_daily_history" for item in result.bar_coverage.incomplete)


def test_mixed_missing_days_and_first_observation_are_not_listing_proof():
    days = [dt.date(2026, 9, d) for d in (17, 18, 21)]
    facts = evidence.HistoryEvidence(
        checked_at=dt.datetime(2026, 9, 22, tzinfo=KST), sources=["https://kind.krx.co.kr/"],
        listing_date=dt.date(2026, 9, 18), vendor_dates={dt.date(2026, 9, 21)})
    assert evidence.missing_reasons(days, facts) == {
        "pre_listing_history": days[:1], "missing_daily_history": days[1:2], "collection_missing": days[2:],
    }
    assert evidence.missing_reasons(days, None) == {"missing_daily_history": days}


def test_corrupt_or_absent_investigation_falls_back_to_unknown(tmp_path):
    assert evidence.load(tmp_path) == {}
    sdir = tmp_path / "screener"
    sdir.mkdir()
    path = sdir / "history_evidence.json"
    path.write_text('{"schema_version":99,"records":{}}')
    assert evidence.load(tmp_path) == {}
    assert path.exists()


@pytest.mark.parametrize("clock, expected", [("2026-09-26T18:00", True), ("2026-09-28T18:00", False)])
def test_known_friday_covers_weekend_but_not_unknown_monday(clock, expected):
    req = ScanRequest.model_validate({"conditions": [{"id": "b", "type": "bollinger_position",
        "params": {"period": 2, "lookback": 1}}]})
    days = [dt.date(2026, 9, 24), dt.date(2026, 9, 25)]
    now = dt.datetime.fromisoformat(clock).replace(tzinfo=KST)
    condition = req.conditions[0]
    windows = bars._required_windows(condition, days, now)
    assert bars._calendar_complete(condition, windows, days, now) is expected

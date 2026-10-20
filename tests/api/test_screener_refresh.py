import asyncio
import datetime as dt
import json

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import screener, screener_history_evidence as evidence, screener_refresh as refresh
from hoga.api.models import ScreenerRefreshSummary, SymbolHit, SymbolsAllResponse
from hoga.api.screener_history_storage import commit_verified
from hoga.api.screener_store import _DAILY_PL_SCHEMA, write_status

DAYS = [dt.date(2026, 9, day) for day in (14, 15, 16, 17)]


def frame(code, days, volume=100):
    return pl.DataFrame([dict(code=code, date=day, open=100., high=100., low=100.,
                              close=100., volume=volume) for day in days], schema=_DAILY_PL_SCHEMA)


def hit(code, listing="2026-09-14"):
    return SymbolHit(code=code, name=code, market="KOSPI", listing_date=listing,
                     captured_count=0, captured_breakdown={})


def seed(data_dir, rows):
    commit_verified(data_dir, [(row, row) for row in rows])
    pl.DataFrame({"code": [row["code"][0] for row in rows],
                  "name": [row["code"][0] for row in rows],
                  "market": ["KOSPI"] * len(rows), "is_etf": [False] * len(rows),
                  "is_halted": [False] * len(rows)}).write_parquet(data_dir / "screener" / "stocks.parquet")
    write_status(data_dir / "screener" / "status.json", last_raw_date="20260917",
                 universe_size=len(rows), derive_ms=0, now_ms=0)


def env(monkeypatch, master):
    monkeypatch.setattr(refresh.trading_days, "trading_days", lambda _dir: {d.strftime("%Y%m%d") for d in DAYS})
    monkeypatch.setattr(refresh, "completed_day", lambda: DAYS[-1])

    async def get_master(**_kw):
        return SymbolsAllResponse(symbols=master, status="fresh", fetched_at_ms=1)

    monkeypatch.setattr(refresh.symbols, "refresh", get_master)


async def test_current_global_date_still_repairs_internal_gaps_and_new_symbol_history(tmp_path, monkeypatch):
    stored = frame("000001", [DAYS[0], *DAYS[2:]])
    retired = frame("000099", DAYS)
    seed(tmp_path, [stored, retired])
    env(monkeypatch, [hit("000001"), hit("000002", "2026-09-15"), hit("000003", "2026-09-18")])
    calls = []

    async def fetch(_dir, code, start, end):
        calls.append((code, start, end))
        days = DAYS if code == "000001" else DAYS[1:]
        # Vendor corrections to old observations are deliberately ignored.
        vendor = frame(code, days, volume=101)
        return vendor, vendor

    result = await refresh.run_refresh(tmp_path, progress=lambda *_: None, fetch=fetch)
    assert result.master_refreshed and result.symbols_added == 2 and result.written_rows == 4
    assert result.failed == result.unavailable == 0 and result.total == 2
    assert {c[0] for c in calls} == {"000001", "000002"}
    raw = pl.read_parquet(tmp_path / "screener" / "daily_unadjusted.parquet")
    assert raw.filter(pl.col("code") == "000001").sort("date")["volume"].to_list() == [100, 101, 100, 100]
    assert raw.filter(pl.col("code") == "000099").equals(retired)
    assert set(pl.read_parquet(tmp_path / "screener" / "stocks.parquet")["code"]) == {
        "000001", "000002", "000003", "000099"}
    facts = evidence.load(tmp_path)
    assert facts["000002"].listing_date == DAYS[1]
    assert facts["000002"].vendor_dates == facts["000002"].vendor_absent_dates == set()
    calls.clear()
    again = await refresh.run_refresh(tmp_path, progress=lambda *_: None, fetch=fetch)
    assert again.written_rows == 0 and calls == []
    assert refresh.last_summary(tmp_path) == again


async def test_provider_absence_and_one_failure_are_reported_without_discarding_success(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", [DAYS[-1]])])
    env(monkeypatch, [hit("000001"), hit("000002"), hit("000003")])

    async def fetch(_dir, code, _start, _end):
        if code == "000002":
            raise ValueError("vendor_timeout")
        vendor = frame(code, DAYS if code == "000001" else [])
        return vendor, vendor

    result = await refresh.run_refresh(tmp_path, progress=lambda *_: None, fetch=fetch)
    assert result.written_rows == 3 and result.failed == 1 and result.unavailable == 1
    assert result.reason == "partial"
    report = json.loads(refresh.report_path(tmp_path).read_text())
    assert report["errors"] == {"000002": "vendor_timeout"}
    assert report["unresolved"] == {"000003": 4}
    facts = evidence.load(tmp_path)
    assert evidence.missing_reasons(DAYS, facts["000003"]) == {"vendor_history_unavailable": DAYS}
    assert "trading_suspended" not in evidence.missing_reasons(DAYS, facts["000003"])
    # Negative provider observations do not disable an explicit retry.
    assert {t.code for t in refresh.plan_repairs(tmp_path, [hit("000003")], DAYS[-1])} == {"000003"}


async def test_existing_adjustment_change_is_rejected_and_reported(tmp_path, monkeypatch):
    stored = frame("000001", [DAYS[-1]])
    seed(tmp_path, [stored])
    before = {p.name: p.read_bytes() for p in (tmp_path / "screener").glob("*.parquet")}
    env(monkeypatch, [hit("000001")])

    async def fetch(*_):
        raw = frame("000001", DAYS)
        adjusted = raw.with_columns([pl.col(c) * .5 for c in ("open", "high", "low", "close")]
                                   + [(pl.col("volume") * 2).alias("volume")])
        return raw, adjusted

    result = await refresh.run_refresh(tmp_path, progress=lambda *_: None, fetch=fetch)
    assert result.failed == 1 and result.written_rows == 0
    assert {p.name: p.read_bytes() for p in (tmp_path / "screener").glob("*.parquet")} == before
    assert evidence.missing_reasons(DAYS[:1], evidence.load(tmp_path)["000001"]) == {
        "collection_missing": DAYS[:1]}


async def test_master_failure_never_claims_latest_or_deletes_retained_symbols(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", DAYS)])
    env(monkeypatch, [])

    async def stale(**_):
        return SymbolsAllResponse(symbols=[hit("000002")], status="stale", fetched_at_ms=1)

    monkeypatch.setattr(refresh.symbols, "refresh", stale)
    with pytest.raises(RuntimeError, match="symbol master refresh failed"):
        await refresh.run_refresh(tmp_path, progress=lambda *_: None)
    assert not refresh.last_summary(tmp_path).master_refreshed
    assert set(pl.read_parquet(tmp_path / "screener" / "stocks.parquet")["code"]) == {"000001"}


def test_new_listing_excludes_pre_listing_days_and_calendar_does_not_guess_weekdays(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", DAYS)])
    env(monkeypatch, [hit("000001")])
    assert refresh.plan_repairs(tmp_path, [hit("000002", "2026-09-17")], DAYS[-1])[0].missing == {DAYS[-1]}
    # A stale calendar cannot silently claim a complete corpus.
    with pytest.raises(refresh.TradingDayUnavailableError):
        refresh.plan_repairs(tmp_path, [hit("000001")], dt.date(2026, 9, 18))


async def test_manual_click_upgrades_existing_eod_job_and_shares_one_job(tmp_path, monkeypatch):
    screener.reset_update_job_for_tests()
    gate, started = asyncio.Event(), asyncio.Event()
    calls = []

    async def eod(*_, **__):
        started.set()
        await gate.wait()
        return 1

    async def manual(*_, progress, report):
        calls.append("manual")
        progress(0, 2, "과거 일봉 보충 중")
        return ScreenerRefreshSummary(master_refreshed=True, total=2, checked=2, written_rows=4)

    monkeypatch.setattr(screener, "_run_eod_update", eod)
    monkeypatch.setattr(refresh, "run_refresh", manual)
    task = screener._ensure_job(tmp_path, screener._UpdatePlan(tmp_path, ["000001"], ["20260917"]), bus=None)
    await started.wait()
    res = await screener.start_update(tmp_path, repair_history=True)
    assert res["running"] and screener._job_task is task
    gate.set()
    assert await task == 1 and calls == ["manual"]
    assert screener._progress is None
    screener.reset_update_job_for_tests()


async def test_manual_start_bypasses_global_no_gap_and_deduplicates_clicks(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", DAYS)])
    env(monkeypatch, [hit("000001")])
    gate = asyncio.Event()
    calls = []
    screener.reset_update_job_for_tests()
    monkeypatch.setattr(screener.kiwoom_rest_runtime, "ensure_rest_client", lambda _: object())

    async def manual(*_, progress, report):
        calls.append(1)
        await gate.wait()
        return ScreenerRefreshSummary(master_refreshed=True)

    monkeypatch.setattr(refresh, "run_refresh", manual)
    try:
        results = await asyncio.gather(*(screener.start_update(tmp_path, repair_history=True) for _ in range(3)))
        task = screener._job_task
        assert all(r["running"] for r in results)
        await asyncio.sleep(0)
        assert calls == [1]
        gate.set()
        await task
    finally:
        await screener.shutdown_update_job()
        screener.reset_update_job_for_tests()


def test_status_serializes_saved_manual_summary_and_phase(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", DAYS)])
    summary = ScreenerRefreshSummary(master_refreshed=True, written_rows=17, completed_ms=10)
    refresh._save(tmp_path, refresh.RefreshReport(summary=summary))
    monkeypatch.setattr(screener, "_progress", screener._UpdateProgress(3, 10, 1, "과거 일봉 보충 중"))
    app = FastAPI()
    app.include_router(screener.build_router(data_dir=tmp_path, bus=None))
    with TestClient(app) as client:
        response = client.get("/api/screener/status")
    assert response.status_code == 200
    assert response.json()["last_refresh"] == summary.model_dump()
    assert response.json()["updating"]["phase"] == "과거 일봉 보충 중"


async def test_listing_prefix_before_calendar_is_fetched_once_without_guessing_sessions(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", DAYS)])
    env(monkeypatch, [hit("000001", "2026-09-10")])
    calls = []

    async def fetch(_dir, code, start, end):
        calls.append((start, end))
        # Provider retains only the dates already held; absence is not proof of IPO.
        vendor = frame(code, DAYS)
        return vendor, vendor

    result = await refresh.run_refresh(tmp_path, progress=lambda *_: None, fetch=fetch)
    assert result.checked == 1 and result.written_rows == 0
    assert calls == [(dt.date(2026, 9, 10), DAYS[-1])]
    assert refresh.plan_repairs(tmp_path, [hit("000001", "2026-09-10")], DAYS[-1]) == []


async def test_cancelled_collection_keeps_committed_batch_and_records_interruption(tmp_path, monkeypatch):
    seed(tmp_path, [frame("000001", [DAYS[-1]])])
    env(monkeypatch, [hit("000001"), hit("000002")])
    monkeypatch.setattr(refresh, "_BATCH_SIZE", 1)
    entered = asyncio.Event()
    never = asyncio.Event()

    async def fetch(_dir, code, _start, _end):
        if code == "000001":
            entered.set()
            await never.wait()
        vendor = frame(code, DAYS)
        return vendor, vendor

    task = asyncio.create_task(refresh.run_refresh(tmp_path, progress=lambda *_: None, fetch=fetch))
    await entered.wait()  # reverse lexical order means 000002 is committed first
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    summary = refresh.last_summary(tmp_path)
    assert summary.reason == "cancelled" and summary.written_rows == 4
    assert pl.read_parquet(tmp_path / "screener" / "daily_unadjusted.parquet").height == 5


async def test_http_refresh_publishes_history_only_results_and_restores_summary(tmp_path, monkeypatch):
    from httpx import ASGITransport, AsyncClient

    seed(tmp_path, [frame("000001", [DAYS[-1]])])
    env(monkeypatch, [hit("000001"), hit("000002", "2026-09-16")])
    screener.reset_update_job_for_tests()
    monkeypatch.setattr(screener.kiwoom_rest_runtime, "ensure_rest_client", lambda _: object())

    async def fetch(_dir, code, _start, _end, *, allow_empty=False):
        vendor = frame(code, DAYS if code == "000001" else DAYS[2:])
        return vendor, vendor

    class Bus:
        events = []

        def publish(self, event):
            self.events.append(event)

    bus = Bus()
    monkeypatch.setattr(refresh, "fetch_pair", fetch)
    app = FastAPI()
    app.include_router(screener.build_router(data_dir=tmp_path, bus=bus))
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/screener/update")
            assert response.status_code == 200 and response.json()["running"]
            await screener._job_task
            status = (await client.get("/api/screener/status")).json()
        assert status["updating"] is None
        assert status["last_refresh"]["written_rows"] == 5
        assert status["last_refresh"]["symbols_added"] == 1
        assert status["universe_size"] == 2
        event = bus.events[-1]
        assert event["type"] == "screener_update_finished" and event["updated"] == 0
        assert event["refresh"] == status["last_refresh"]
    finally:
        await screener.shutdown_update_job()
        screener.reset_update_job_for_tests()

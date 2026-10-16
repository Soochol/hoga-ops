from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import httpx
import pytest

from hoga.api import app as app_mod, symbols
from hoga.api.models import SymbolHit


def catalog(tmp_path: Path) -> Path:
    path = tmp_path / "symbols.json"
    path.write_text(json.dumps({
        "schema_version": 3, "fetched_at_ms": 123,
        "entries": [{"code": "005930", "name": "삼성전자", "market": "KOSPI"}],
    }))
    symbols.load_disk_state(path=path, data_dir=tmp_path, defer_counts=True)
    return path


@pytest.fixture(autouse=True)
async def counts_lifecycle():
    symbols.reset_state_for_tests()
    yield
    await symbols.aclose_refresh()
    await symbols.aclose_capture_counts()
    symbols.reset_state_for_tests()


@pytest.mark.asyncio
async def test_boot_serves_search_and_health_before_scan_finishes(tmp_path, monkeypatch):
    path = catalog(tmp_path)
    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def scan(_data_dir, *, cancelled):
        started.set()
        try:
            while not release.wait(.01):
                if cancelled():
                    raise symbols._CountsStopped
            return {"005930": dict(complete=7, source_partial=2, client_incomplete=1, invalid=0)}
        finally:
            finished.set()

    monkeypatch.setattr(symbols, "_build_all_captured_breakdowns", scan)
    monkeypatch.setattr(app_mod, "resolve_symbol_master_path", lambda: path)
    monkeypatch.setattr(symbols, "needs_boot_refresh", lambda: False)
    monkeypatch.setattr(app_mod, "start_scheduler", lambda _: [])
    monkeypatch.delenv("HOGA_LIVE_STARTUP_ENABLED", raising=False)
    app = app_mod.create_app(tmp_path)
    try:
        async with app.router.lifespan_context(app):
            await asyncio.wait_for(asyncio.to_thread(started.wait), 2)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
                assert (await client.get("/health?deep=true")).status_code == 200
                body = (await client.get("/api/symbols/all")).json()
                assert body["capture_counts_status"] == "pending"
                hit = (await client.get("/api/symbols?q=삼성")).json()[0]
                assert hit["name"] == "삼성전자"
                assert hit["capture_counts_status"] == "pending"
                assert not finished.is_set()
                release.set()
                await symbols._capture_counts.task
                ready = (await client.get("/api/symbols/all")).json()
                assert ready["capture_counts_status"] == "ready"
                assert ready["symbols"][0]["captured_count"] == 7
                assert ready["symbols"][0]["captured_breakdown"]["source_partial"] == 2
    finally:
        release.set()
    assert finished.is_set()


@pytest.mark.asyncio
async def test_failure_preserves_catalog_and_count_only_retry_is_single_flight(tmp_path, monkeypatch):
    path = catalog(tmp_path)
    calls = 0

    def scan(_data_dir, *, cancelled):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise PermissionError("denied")
        return {"005930": dict(complete=3, source_partial=0, client_incomplete=0, invalid=0)}

    async def no_vendor():
        raise AssertionError("count retry must not fetch the master")

    monkeypatch.setattr(symbols, "_build_all_captured_breakdowns", scan)
    monkeypatch.setattr(symbols, "_fetch_symbol_master", no_vendor)
    await symbols.start_capture_counts(tmp_path)
    assert symbols.current_status() == "fresh"
    assert symbols.search("삼성")[0].capture_counts_status == "failed"
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(symbols.build_router(path=path, data_dir=tmp_path))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        assert (await client.get("/api/symbols/capture-counts")).json() == {"status": "failed"}
        # Neither POST yields to the worker. They must share a single scan task.
        first = symbols.start_capture_counts(tmp_path)
        assert (await client.post("/api/symbols/capture-counts/refresh")).json() == {"status": "pending"}
        assert symbols._capture_counts.task is first
        await first
        assert (await client.get("/api/symbols/capture-counts")).json() == {"status": "ready"}
        assert (await client.get("/api/symbols?q=삼성")).json()[0]["captured_count"] == 3
    assert calls == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_task", [False, True])
async def test_shutdown_joins_cooperatively_stopped_thread(tmp_path, monkeypatch, cancel_task):
    catalog(tmp_path)
    started, finished = threading.Event(), threading.Event()

    def scan(_data_dir, *, cancelled):
        started.set()
        try:
            while not cancelled():
                finished.wait(.001)
            raise symbols._CountsStopped
        finally:
            finished.set()

    monkeypatch.setattr(symbols, "_build_all_captured_breakdowns", scan)
    task = symbols.start_capture_counts(tmp_path)
    await asyncio.wait_for(asyncio.to_thread(started.wait), 2)
    if cancel_task:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        await asyncio.wait_for(symbols.aclose_capture_counts(), 2)
    assert finished.is_set(), "shutdown returned while the reader thread was alive"
    assert task.done()
    assert symbols.search("삼성")[0].capture_counts_status == "pending", "cancelled partial data published"


@pytest.mark.asyncio
async def test_refresh_during_boot_scan_keeps_new_catalog_and_consistent_counts(tmp_path, monkeypatch):
    path = catalog(tmp_path)
    started, release = threading.Event(), threading.Event()
    calls = 0

    def scan(_data_dir, *, cancelled):
        nonlocal calls
        calls += 1
        started.set()
        while not release.wait(.001):
            if cancelled():
                raise symbols._CountsStopped
        return {"005930": dict(complete=4, source_partial=0, client_incomplete=0, invalid=0)}

    async def fetch():
        return [SymbolHit(code="005930", name="새 이름", market="KOSPI", captured_count=0,
                          captured_breakdown={}),
                SymbolHit(code="000660", name="신규 종목", market="KOSPI", captured_count=0,
                          captured_breakdown={})]

    monkeypatch.setattr(symbols, "_build_all_captured_breakdowns", scan)
    monkeypatch.setattr(symbols, "_fetch_symbol_master", fetch)
    symbols.start_capture_counts(tmp_path)
    await asyncio.wait_for(asyncio.to_thread(started.wait), 2)
    refresh = asyncio.create_task(symbols.refresh(path=path, data_dir=tmp_path))
    try:
        while symbols.search("새 이름") == []:
            await asyncio.sleep(0)
        assert symbols.search("새 이름")[0].capture_counts_status == "pending"
        release.set()
        response = await refresh
        assert {hit.code for hit in response.symbols} == {"005930", "000660"}
        assert response.symbols[0].name == "새 이름"
        assert response.symbols[0].captured_count == 4
        assert response.symbols[1].captured_count == 0
        assert all(hit.capture_counts_status == "ready" for hit in response.symbols)
        assert calls == 1
    finally:
        release.set()
        await refresh


def test_real_scan_checks_stop_between_stock_dates(tmp_path, monkeypatch):
    for code in ("000001", "000002"):
        (tmp_path / "parquet" / "20260101" / code).mkdir(parents=True)
    calls = []
    stop = threading.Event()
    original = symbols.check_disk_state

    def check(*args, **kwargs):
        calls.append(args[1])
        stop.set()
        return original(*args, **kwargs)

    monkeypatch.setattr(symbols, "check_disk_state", check)
    with pytest.raises(symbols._CountsStopped):
        symbols._build_all_captured_breakdowns(tmp_path, cancelled=stop.is_set)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_app_teardown_stops_active_reader_before_closing_services(tmp_path, monkeypatch):
    path = catalog(tmp_path)
    started, finished = threading.Event(), threading.Event()

    def scan(_data_dir, *, cancelled):
        started.set()
        try:
            while not cancelled():
                finished.wait(.001)
            raise symbols._CountsStopped
        finally:
            finished.set()

    monkeypatch.setattr(symbols, "_build_all_captured_breakdowns", scan)
    monkeypatch.setattr(app_mod, "resolve_symbol_master_path", lambda: path)
    monkeypatch.setattr(symbols, "needs_boot_refresh", lambda: False)
    monkeypatch.setattr(app_mod, "start_scheduler", lambda _: [])
    monkeypatch.delenv("HOGA_LIVE_STARTUP_ENABLED", raising=False)
    app = app_mod.create_app(tmp_path)

    async def close_service():
        assert finished.is_set(), "service teardown ran while history IO was still active"

    monkeypatch.setattr(app.state.trading_service, "close", close_service)
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(asyncio.to_thread(started.wait), 2)
        assert not finished.is_set()
    assert finished.is_set()
    assert symbols._capture_counts.task.done()

import asyncio

import polars as pl
import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI
from hoga.api.screener import build_router, _ScanCoalescer
from hoga.api.models import ScreenerResponse


def _app(tmp_path):
    sd = tmp_path / "screener"; sd.mkdir()
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-14"], "open": [100.0], "high": [100.0],
        "low": [100.0], "close": [100.0], "volume": [10]}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sd / "daily_adjusted.parquet")
    pl.DataFrame({"code": ["000001"], "name": ["에이"], "market": ["KOSPI"],
        "is_etf": [False], "is_halted": [False]}).write_parquet(sd / "stocks.parquet")
    (sd / "status.json").write_text('{"schema_version":1,"last_raw_date":"20260514",'
        '"last_built_ms":1,"universe_size":1,"derive_ms":1}')
    app = FastAPI(); app.include_router(build_router(data_dir=tmp_path)); return app


def test_scan_post_not_seeded(tmp_path):
    # bare data_dir: no screener/status.json → not_seeded
    app = FastAPI(); app.include_router(build_router(data_dir=tmp_path))
    resp = TestClient(app).post("/api/screener/scan", json={"conditions": [], "universe": {}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "not_seeded" and body["rows"] == []


def test_scan_post_ok_shape(tmp_path):
    c = TestClient(_app(tmp_path))
    resp = c.post("/api/screener/scan", json={
        "conditions": [{"id": "a", "type": "trade_value", "params": {"min_eok": 0}}],
        "universe": {"markets": ["KOSPI"]}, "limit": 10})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok" and "warnings" in body
    assert body["rows"][0]["code"] == "000001"
    assert all(set(r) >= {"code", "name", "market", "price", "trade_value_won", "change_pct"} for r in body["rows"])
    assert all("matches" not in r and "new_high" not in r for r in body["rows"])


def test_scan_post_invalid_market_422(tmp_path):
    # invalid market literal in the universe body → Pydantic 422
    c = TestClient(_app(tmp_path))
    resp = c.post("/api/screener/scan", json={"conditions": [], "universe": {"markets": ["FOO"]}})
    assert resp.status_code == 422


def test_scan_post_lookback_zero_422(tmp_path):
    # lookback below ge=1 in a new_high leaf → Pydantic 422
    c = TestClient(_app(tmp_path))
    resp = c.post("/api/screener/scan", json={
        "conditions": [{"id": "a", "type": "new_high", "params": {"lookback": 0, "period": 5}}],
        "universe": {}})
    assert resp.status_code == 422


def test_status_days_behind_present(tmp_path):
    # StalenessChip needs a TRADING-day freshness signal. days_behind is
    # present and int|None (None when KRX is unavailable in the test env).
    r = TestClient(_app(tmp_path)).get("/api/screener/status")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "days_behind" in body
    assert body["days_behind"] is None or isinstance(body["days_behind"], int)


def test_status_days_behind_deterministic(tmp_path, monkeypatch):
    # Monkeypatch the calendar helper (bound in the screener module namespace)
    # to a deterministic 3-trading-day gap.
    import hoga.api.screener as screener_mod
    monkeypatch.setattr(screener_mod, "trading_days_in_range",
                        lambda start, end: ["20260515", "20260518", "20260519"])
    r = TestClient(_app(tmp_path)).get("/api/screener/status")
    assert r.status_code == 200
    assert r.json()["days_behind"] == 3


@pytest.mark.asyncio
async def test_scan_coalescer_shares_one_run_for_concurrent_same_key():
    coalescer = _ScanCoalescer()
    calls = 0
    gate = asyncio.Event()

    async def factory():
        nonlocal calls
        calls += 1
        await gate.wait()          # 두 caller 가 확실히 겹치도록 게이트로 붙잡는다
        return "result"

    a = asyncio.create_task(coalescer.run("k", factory))
    b = asyncio.create_task(coalescer.run("k", factory))
    await asyncio.sleep(0)         # 두 태스크가 run 에 진입하도록 양보
    gate.set()
    results = await asyncio.gather(a, b)

    assert results == ["result", "result"]
    assert calls == 1              # 겹친 동일 키 → factory 1회


@pytest.mark.asyncio
async def test_scan_coalescer_distinct_keys_run_separately():
    coalescer = _ScanCoalescer()
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return calls

    r1 = await coalescer.run("a", factory)
    r2 = await coalescer.run("b", factory)      # 다른 키
    r3 = await coalescer.run("a", factory)      # 이전 flight 완료 후 → 새 실행(캐시 아님)

    assert (r1, r2, r3) == (1, 2, 3)
    assert calls == 3


@pytest.mark.asyncio
async def test_scan_coalescer_caller_cancel_does_not_kill_shared_flight():
    coalescer = _ScanCoalescer()
    gate = asyncio.Event()
    ran = False

    async def factory():
        nonlocal ran
        await gate.wait()
        ran = True
        return "ok"

    a = asyncio.create_task(coalescer.run("k", factory))
    b = asyncio.create_task(coalescer.run("k", factory))
    await asyncio.sleep(0)
    a.cancel()                      # 한 caller 취소(클라이언트 disconnect 모사)
    with pytest.raises(asyncio.CancelledError):
        await a
    gate.set()
    assert await b == "ok"          # 공유 flight 는 살아남아 나머지 caller 에 결과 전달
    assert ran is True


def test_scan_post_delegates_to_runner(tmp_path, monkeypatch):
    import hoga.api.screener as screener_mod

    calls = []

    async def fake_runner(**kwargs):
        calls.append(kwargs)
        return ScreenerResponse(status="ok", rows=[], warnings=["from_runner"])

    monkeypatch.setattr(screener_mod.screener_runner, "run_screener_scan", fake_runner)

    resp = TestClient(_app(tmp_path)).post("/api/screener/scan", json={
        "basis": "intraday",
        "conditions": [],
        "universe": {"markets": ["KOSPI"]},
    })

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["warnings"] == ["from_runner"]
    assert calls[0]["data_dir"] == tmp_path
    assert calls[0]["req"].basis == "intraday"
    assert calls[0]["req"].universe.markets == ["KOSPI"]

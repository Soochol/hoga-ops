import polars as pl
from fastapi.testclient import TestClient
from fastapi import FastAPI
from hoga.api.screener import build_router


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


def test_screener_status_includes_daily_queue(monkeypatch, tmp_path):
    import hoga.api.screener as screener_mod

    class FakeQueue:
        def snapshot(self):
            return {
                "queued_foreground": 0,
                "queued_background": 2,
                "active_foreground": 0,
                "active_background": 1,
                "cooldown_remaining_ms": 500,
                "daily_rate_limit_count": 3,
            }

    monkeypatch.setattr(screener_mod, "get_daily_fetch_queue", lambda: FakeQueue())

    r = TestClient(_app(tmp_path)).get("/api/screener/status")

    assert r.status_code == 200
    body = r.json()
    assert body["daily_queue"]["queued_background"] == 2
    assert body["daily_queue"]["cooldown_remaining_ms"] == 500

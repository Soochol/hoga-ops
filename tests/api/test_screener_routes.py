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


def test_scan_ok(tmp_path):
    c = TestClient(_app(tmp_path))
    r = c.get("/api/screener", params={"min_trade_value_eok": 0})
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert r.json()["rows"][0]["code"] == "000001"


def test_not_seeded(tmp_path):
    app = FastAPI(); app.include_router(build_router(data_dir=tmp_path))
    r = TestClient(app).get("/api/screener")
    assert r.json()["status"] == "not_seeded" and r.json()["rows"] == []


def test_filter_pair_required(tmp_path):
    r = TestClient(_app(tmp_path)).get("/api/screener", params={"nh_lookback": 200})
    assert r.status_code == 422


def test_invalid_market_422(tmp_path):
    r = TestClient(_app(tmp_path)).get("/api/screener", params={"markets": "FOO"})
    assert r.status_code == 422


def test_lookback_zero_422(tmp_path):
    r = TestClient(_app(tmp_path)).get("/api/screener",
                                       params={"nh_lookback": 0, "nh_period": 5})
    assert r.status_code == 422

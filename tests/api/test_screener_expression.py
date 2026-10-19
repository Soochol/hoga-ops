import itertools
import json
from pathlib import Path

import polars as pl
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from hoga.api.models import ScanRequest, ScreenerSaveWriteRequest, ScreenerUniverse
from hoga.api.screener import build_router
from hoga.api.screener_expression import condition_label, parse_expression
from hoga.api.screener_scan import run_scan

CASES = json.loads((Path(__file__).parents[2] / "frontend/tests/fixtures/screener-expression-cases.json").read_text())


@pytest.mark.parametrize("case", CASES)
def test_expression_contract(case):
    if "postfix" in case:
        assert parse_expression(case["expression"], case["count"]) == case["postfix"]
    else:
        with pytest.raises(ValueError):
            parse_expression(case["expression"], case["count"])


def test_deep_parentheses_and_label_sequence():
    assert parse_expression("(" * 2000 + "A" + ")" * 2000, 1) == [0]
    assert [condition_label(i) for i in [0, 25, 26, 701, 702]] == ["A", "Z", "AA", "ZZ", "AAA"]
    with pytest.raises(ValueError, match="10,000"):
        parse_expression(" " * 10_001, 1)


def leaves():
    return [{"id": str(i), "type": "ask_depth_new_high", "params": {"lookback": 20}}
            for i in range(3)]


@pytest.mark.parametrize("model", [ScanRequest, ScreenerSaveWriteRequest])
def test_model_validates_before_scan_or_save(model):
    with pytest.raises(ValidationError, match="조건"):
        model.model_validate({"name": "검색", "conditions": leaves(), "expression": "A OR M"})


@pytest.mark.parametrize("expression", [None, "A AND (B OR C)", "A OR B AND C", "(A OR B) AND C", "A OR B OR C", "B"])
def test_scan_expression_truth_table_and_occurrences(tmp_path, expression):
    codes = [f"{i:06d}" for i in range(8)]
    bits = list(itertools.product([False, True], repeat=3))
    adj, stocks = tmp_path / "adj.parquet", tmp_path / "stocks.parquet"
    pl.DataFrame({"code": codes, "date": ["2026-10-19"] * 8,
                  "open": [100.] * 8, "high": [100.] * 8, "low": [100.] * 8,
                  "close": [100.] * 8, "volume": [100] * 8}).with_columns(
        pl.col("date").str.to_date()).write_parquet(adj)
    pl.DataFrame({"code": codes, "name": codes, "market": ["KOSPI"] * 8,
                  "is_etf": [False] * 8, "is_halted": [False] * 8}).write_parquet(stocks)
    req = ScanRequest.model_validate({"conditions": leaves(), "expression": expression})
    passing = {str(i): [code for code, values in zip(codes, bits, strict=True) if values[i]] for i in range(3)}
    dates = {key: {code: ["2026-10-19"] for code in value} for key, value in passing.items()}
    rows = run_scan(adj, stocks, conditions=req.conditions, universe=ScreenerUniverse(),
                    expression=expression, depth_pass=passing, occurrence_dates=dates)
    def expected(values):
        a, b, c = values
        return {None: a and b and c, "A AND (B OR C)": a and (b or c), "A OR B AND C": a or b and c,
                "(A OR B) AND C": (a or b) and c, "A OR B OR C": a or b or c, "B": b}[expression]
    assert {r.code for r in rows} == {code for code, values in zip(codes, bits, strict=True) if expected(values)}
    for row in rows:
        assert len({(o.condition_id, o.date) for o in row.occurrences}) == len(row.occurrences)
        if expression == "B":
            assert {o.condition_id for o in row.occurrences} == {"1"}


def test_http_save_roundtrip_and_invalid_expression_422(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    payload = {"name": "OR 검색", "conditions": leaves(), "expression": "A AND (B OR C)"}
    response = client.post("/api/screener/saves", json=payload)
    assert response.status_code == 201
    saved = response.json()
    assert saved["expression"] == payload["expression"]
    assert client.get("/api/screener/saves").json()["saves"][0]["expression"] == payload["expression"]
    payload["expression"] = "A OR B"
    assert client.put(f"/api/screener/saves/{saved['id']}", json=payload).json()["expression"] == "A OR B"
    for endpoint in ["/api/screener/saves", "/api/screener/scan", "/api/screener/history/preview"]:
        assert client.post(endpoint, json={**payload, "expression": "A OR Z"}).status_code == 422
    legacy = client.post("/api/screener/saves", json={"name": "기존 AND", "conditions": leaves()})
    assert legacy.status_code == 201
    assert legacy.json()["expression"] is None


def test_http_scan_or_and_exclusions_use_the_expression(tmp_path):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    codes = ["000001", "000002", "000003"]
    prices = [10., 100., 500.]
    pl.DataFrame({"code": codes, "date": ["2026-10-19"] * 3, "open": prices, "high": prices,
                  "low": prices, "close": prices, "volume": [100] * 3}).with_columns(
        pl.col("date").str.to_date()).write_parquet(sdir / "daily_adjusted.parquet")
    pl.DataFrame({"code": codes, "name": codes, "market": ["KOSPI"] * 3,
                  "is_etf": [False] * 3, "is_halted": [False] * 3}).write_parquet(sdir / "stocks.parquet")
    (sdir / "status.json").write_text(json.dumps({"schema_version": 1, "last_raw_date": "20261019",
        "last_built_ms": 1, "universe_size": 3, "derive_ms": 1}))
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    conditions = [{"id": "a", "type": "price_range", "params": {"min": 300}},
                  {"id": "b", "type": "price_range", "params": {"max": 50}},
                  {"id": "unused", "type": "price_range", "params": {"min": 9999}}]
    body = {"conditions": conditions, "universe": {}, "expression": "A OR B"}
    response = client.post("/api/screener/scan", json=body)
    assert response.status_code == 200
    assert {row["code"] for row in response.json()["rows"]} == {"000001", "000003"}
    assert client.post("/api/screener/scan", json={**body, "expression": "A AND B"}).json()["rows"] == []
    exclusion = client.put("/api/screener/exclusions", json={"condition": conditions[1], "code": "000001",
                          "date": "2026-10-19", "stock_name": "테스트"})
    assert exclusion.status_code == 200
    response = client.post("/api/screener/scan", json=body)
    assert {row["code"] for row in response.json()["rows"]} == {"000003"}
    repeated = client.post("/api/screener/scan", json={**body, "expression": "A OR A"})
    assert repeated.json()["rows"][0]["code"] == "000003"

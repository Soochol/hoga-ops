from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.parser import parse_stock_date

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "tiny_tsv"


@pytest.fixture
def app_client(tmp_path: Path) -> TestClient:
    """Set up data/parquet/20260519/003490 from the tiny_tsv fixture and return a TestClient."""
    raw = tmp_path / "data" / "raw" / "20260519" / "003490"
    raw.mkdir(parents=True)
    for name in ("info.tsv", "first_001.tsv", "chart.tsv"):
        shutil.copy(FIXTURE_DIR / name, raw / name)
    parse_stock_date(code="003490", date="20260519", data_dir=tmp_path / "data")
    app = create_app(data_dir=tmp_path / "data")
    return TestClient(app)


def test_stock_dates(app_client: TestClient) -> None:
    r = app_client.get("/api/stock-dates")
    assert r.status_code == 200
    entries = r.json()
    assert isinstance(entries, list)
    assert len(entries) == 1
    s = entries[0]
    assert s["code"] == "003490"
    assert s["date"] == "20260519"
    assert s["name"] == "대한항공"


def test_meta(app_client: TestClient) -> None:
    r = app_client.get("/api/meta", params={"code": "003490", "date": "20260519"})
    assert r.status_code == 200
    m = r.json()
    assert m["code"] == "003490"
    assert m["regular_session_open_ms"] == 90000000


def test_meta_unknown_returns_404(app_client: TestClient) -> None:
    r = app_client.get("/api/meta", params={"code": "999999", "date": "20260519"})
    assert r.status_code == 404


def test_orderbook_at_returns_latest(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/orderbook",
        params={
            "code": "003490",
            "date": "20260519",
            "t": hhmmssms_to_unix_ms("20260519", 90020000),
        },
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["snapshot"] is not None
    assert payload["snapshot"]["ts_ms"] == hhmmssms_to_unix_ms("20260519", 90010435)
    assert payload["snapshot"]["ask_p"][:3] == [25700, 25750, 25800]


def test_orderbook_before_any_data(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/orderbook",
        params={
            "code": "003490",
            "date": "20260519",
            "t": hhmmssms_to_unix_ms("20260519", 80000000),
        },
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["snapshot"] is None
    assert payload["available_from"] == hhmmssms_to_unix_ms("20260519", 85959530)


def test_trades_up_to(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/trades",
        params={
            "code": "003490",
            "date": "20260519",
            "t": hhmmssms_to_unix_ms("20260519", 90010500),
            "limit": 10,
        },
    )
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert len(trades) == 6
    ts = [t["ts_ms"] for t in trades]
    assert ts == sorted(ts, reverse=True)


def test_trades_limit(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/trades",
        params={
            "code": "003490",
            "date": "20260519",
            "t": hhmmssms_to_unix_ms("20260519", 90010500),
            "limit": 3,
        },
    )
    assert r.status_code == 200
    assert len(r.json()["trades"]) == 3


def test_candles(app_client: TestClient) -> None:
    r = app_client.get("/api/candles", params={"code": "003490", "date": "20260519"})
    assert r.status_code == 200
    candles = r.json()["candles"]
    assert len(candles) == 2
    ts = [c["ts_ms"] for c in candles]
    assert ts == sorted(ts), "candles ascending"


def test_brokers_at(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/brokers",
        params={"code": "003490", "date": "20260519", "t": 90020000},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["ts_ms"] == 90019919
    entries = payload["entries"]
    assert len(entries) == 10
    sides = {e["side"] for e in entries}
    assert sides == {"buy", "sell"}


def test_brokers_before_any_data(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/brokers",
        params={"code": "003490", "date": "20260519", "t": 80000000},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["ts_ms"] is None
    assert payload["entries"] == []


def test_orderbook_returns_delta_arrays(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/orderbook",
        params={
            "code": "003490",
            "date": "20260519",
            "t": hhmmssms_to_unix_ms("20260519", 90020000),
        },
    )
    assert r.status_code == 200
    snap = r.json()["snapshot"]
    assert "ask_d" in snap
    assert "bid_d" in snap
    assert len(snap["ask_d"]) == 10
    assert len(snap["bid_d"]) == 10


def test_trades_returns_extended_fields(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/trades",
        params={
            "code": "003490",
            "date": "20260519",
            "t": hhmmssms_to_unix_ms("20260519", 90010500),
            "limit": 1,
        },
    )
    assert r.status_code == 200
    trade = r.json()["trades"][0]
    for field in ("change_pct", "cum_trades", "low_so_far", "high_so_far", "net_pressure"):
        assert field in trade, f"missing {field}"


def test_trades_range_query(app_client: TestClient) -> None:
    # Fixture has trades at: 84000352 (premarket), 90010023, 90010160, 90010173, 90010335, 90010351
    r = app_client.get(
        "/api/trades",
        params={
            "code": "003490",
            "date": "20260519",
            "from": hhmmssms_to_unix_ms("20260519", 90010100),
            "to": hhmmssms_to_unix_ms("20260519", 90010300),
            "limit": 100,
        },  # noqa: E501
    )
    assert r.status_code == 200
    trades = r.json()["trades"]
    # Two trades in [90010100, 90010300]: 90010160 and 90010173
    assert len(trades) == 2
    ts = [t["ts_ms"] for t in trades]
    assert ts == [
        hhmmssms_to_unix_ms("20260519", 90010173),
        hhmmssms_to_unix_ms("20260519", 90010160),
    ]  # descending


def test_trades_neither_t_nor_range_returns_400(app_client: TestClient) -> None:
    r = app_client.get(
        "/api/trades",
        params={"code": "003490", "date": "20260519"},
    )
    assert r.status_code == 400


def test_trades_out_of_day_cursor_returns_400(app_client: TestClient) -> None:
    # Cursor on 2026-05-20 but date=20260519 → cross-day → 400
    bad_t = hhmmssms_to_unix_ms("20260520", 120000000)
    r = app_client.get(
        "/api/trades",
        params={"code": "003490", "date": "20260519", "t": bad_t, "limit": 5},
    )
    assert r.status_code == 400


def test_trades_ts_ms_is_unix(app_client: TestClient) -> None:
    t_noon = hhmmssms_to_unix_ms("20260519", 120000000)  # 12:00 KST on 2026-05-19
    r = app_client.get(
        "/api/trades",
        params={"code": "003490", "date": "20260519", "t": t_noon, "limit": 5},
    )
    assert r.status_code == 200
    trades = r.json()["trades"]
    assert len(trades) > 0
    for t in trades:
        assert t["ts_ms"] > 1_700_000_000_000


def test_orderbook_ts_ms_is_unix(app_client: TestClient) -> None:
    t_noon = hhmmssms_to_unix_ms("20260519", 120000000)  # 12:00 KST on 2026-05-19
    r = app_client.get(
        "/api/orderbook",
        params={"code": "003490", "date": "20260519", "t": t_noon},
    )
    assert r.status_code == 200
    payload = r.json()
    snap = payload["snapshot"]
    if snap is not None:
        assert snap["ts_ms"] > 1_700_000_000_000
    if payload["available_from"] is not None:
        assert payload["available_from"] > 1_700_000_000_000


def test_orderbook_out_of_day_cursor_returns_400(app_client: TestClient) -> None:
    # Cursor on 2026-05-20 but date=20260519 → cross-day → 400
    bad_t = hhmmssms_to_unix_ms("20260520", 120000000)
    r = app_client.get(
        "/api/orderbook",
        params={"code": "003490", "date": "20260519", "t": bad_t},
    )
    assert r.status_code == 400

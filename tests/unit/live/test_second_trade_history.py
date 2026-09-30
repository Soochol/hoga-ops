from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live.second_trade_api import build_router
from hoga.live.second_trade_history import historical_second_rows
from hoga.live.second_trade_store import second_trade_store
from hoga.util.timeenc import hhmmssms_to_unix_ms

DATE = "20260929"
CODE = "042700"


def save(root: Path, rows: list[dict], source: str = "hogaplay") -> Path:
    path = root / "parquet" / DATE / CODE / source / "trades.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows), path)
    return path


def trade(native: int, seq: int, price: int, qty: int = 1, side: int = 1) -> dict:
    return {"ts_ms": native, "seq": seq, "price": price, "qty": qty, "side": side}


def client(root: Path) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(data_dir=root))
    return TestClient(app)


def test_original_ticks_preserve_order_duplicates_volume_and_shared_prices(tmp_path):
    save(tmp_path, [trade(90000100, 3, 110, 2), trade(90000100, 1, 100, 3),
                    trade(90000100, 2, 105, 4, -1), trade(90000100, 4, 110, 2),
                    trade(90001500, 5, 90, 5, 0), trade(90002000, 6, 0, 500),
                    trade(90002000, 7, 120, 0)])
    api = client(tmp_path)
    url = f"/api/live/second-aggregates?code={CODE}&date={DATE}&include_prices=true"
    result = api.get(url + "&seconds=1").json()
    assert result["source"] == "hogaplay"
    assert result["coverage"] == "unverified"
    first, second = result["bars"]
    assert (first["open"], first["close"], first["high"], first["low"]) == (100, 110, 110, 100)
    assert (first["volume"], first["count"]) == (11, 4)
    assert second["close"] == 90
    assert sum(p["qty"] for p in result["prices"]) == sum(b["volume"] for b in result["bars"]) == 16
    assert result["first_observed_ms"] == hhmmssms_to_unix_ms(DATE, 90000100)
    for seconds in (5, 10, 30):
        bucket = api.get(url + f"&seconds={seconds}").json()["bars"][0]
        assert (bucket["open"], bucket["close"], bucket["volume"]) == (100, 90, 16)
    t = hhmmssms_to_unix_ms(DATE, 90001000)
    ranged = api.get(url + f"&seconds=1&from_ms={t}").json()
    assert len(ranged["bars"]) == 1
    assert ranged["last_observed_ms"] == result["last_observed_ms"]


def test_no_live_10s_or_cross_venue_fallback(tmp_path):
    save(tmp_path, [trade(90000000, 1, 100)], "kiwoom_live/KRX")
    api = client(tmp_path)
    url = f"/api/live/second-aggregates?code={CODE}&date={DATE}"
    assert api.get(url).json()["status"] == "unavailable"
    save(tmp_path, [trade(90000000, 1, 100)])
    for venue in ("NXT", "UN"):
        assert api.get(url + f"&venue={venue}").json()["status"] == "unavailable"


def test_live_seconds_win_without_adding_historical_volume(tmp_path):
    from hoga.live.second_trade_agg import SecondTradeBar

    save(tmp_path, [trade(90000000, 1, 100, 99)])
    t = hhmmssms_to_unix_ms(DATE, 90000000)
    bar = SecondTradeBar(t)
    bar.ingest(t_ms=t, seq=1, price=200, qty=2, side=1)
    second_trade_store(tmp_path)._bars[(CODE, "KRX", t)] = bar
    result = client(tmp_path).get(f"/api/live/second-aggregates?code={CODE}&date={DATE}").json()
    assert result["source"] == "second_trades"
    assert result["bars"][0]["volume"] == 2
    assert result["bars"][0]["close"] == 200


def test_history_cache_invalidates_after_capture_replacement(tmp_path):
    save(tmp_path, [trade(90000000, 1, 100)])
    assert historical_second_rows(tmp_path, CODE, "KRX", DATE)[0]["close"] == 100
    save(tmp_path, [trade(90000000, 1, 200), trade(90000500, 2, 210)])
    assert historical_second_rows(tmp_path, CODE, "KRX", DATE)[0]["close"] == 210

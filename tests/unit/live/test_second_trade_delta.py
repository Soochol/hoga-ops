from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.models import SecondAggregatesResponse, SecondBarModel
from hoga.live.second_trade_api import build_router
from hoga.live.second_trade_delta import SecondResponseRevisions
from hoga.live.second_trade_store import second_trade_store
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick
from hoga.util.timeenc import KST

T = int(datetime(2026, 9, 30, 9, tzinfo=KST).timestamp() * 1000)


def _tick(t, price=100, qty=2):
    return WsTick("005930", t, SnapshotKind.TRADE,
                  {"trades": [{"t_ms": t, "price": price, "qty": qty, "side": 1}]}, "KRX")


def test_http_delta_empty_append_late_correction_and_reset(tmp_path):
    store = second_trade_store(tmp_path)
    store._sealed_before = T - 1000
    for i in range(1000):
        store.ingest(_tick(T + i * 1000))
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    url = "/api/live/second-aggregates?code=005930&date=20260930&seconds=1&include_prices=true&incremental=true"
    full = client.get(url).json()
    assert full["reset"] is True
    assert len(full["bars"]) == 1000
    unchanged_response = client.get(url + "&since_revision=" + full["revision"])
    unchanged = unchanged_response.json()
    assert unchanged["reset"] is False
    assert unchanged["revision"] == full["revision"]
    assert unchanged["bars"] == unchanged["prices"] == unchanged["changed_ms"] == []
    assert len(unchanged_response.content) < 1000
    # Correction predates the latest candle, so a forward-only timestamp cursor
    # would miss it. Quantities replace the bucket rather than being added again.
    store.ingest(_tick(T + 500, price=95, qty=3))
    store.ingest(_tick(T + 1000000, price=110))
    delta_response = client.get(url + "&since_revision=" + full["revision"])
    delta = delta_response.json()
    assert delta["changed_ms"] == [T, T + 1000000]
    assert [bar["volume"] for bar in delta["bars"]] == [5, 2]
    assert len(delta["prices"]) == 3
    assert len(delta_response.content) < len(client.get(url).content) / 50
    assert client.get(url + "&since_revision=unknown").json()["reset"] is True
    other_venue = client.get(url + "&venue=NXT&since_revision=" + delta["revision"]).json()
    assert other_venue["reset"] is True
    # Restart/eviction must fall back to a complete source.
    app2 = FastAPI()
    app2.include_router(build_router(data_dir=tmp_path))
    assert TestClient(app2).get(url + "&since_revision=" + delta["revision"]).json()["reset"] is True


def _response(times, source="second_trades"):
    return SecondAggregatesResponse(code="005930", date="20260930", venue="KRX", seconds=1,
                                    source=source, status="observed", coverage="unverified", storage_error=None,
                                    first_observed_ms=T, last_observed_ms=T,
                                    bars=[SecondBarModel(t_ms=t, open=100, high=100, low=100, close=100,
                                                         volume=2, count=1, trade_value=200) for t in times], prices=[])


def test_deleted_buckets_source_switch_scope_and_bounded_eviction():
    revisions = SecondResponseRevisions(limit=2)
    first = revisions.project(("KRX",), _response([T, T + 1000]), None)
    second = revisions.project(("KRX",), _response([T]), first.revision)
    assert second.reset is False and second.changed_ms == [T + 1000] and second.bars == []
    assert revisions.project(("KRX",), _response([T], "hogaplay"), second.revision).reset is True
    assert len(revisions._snapshots) <= 2
    assert revisions.project(("KRX",), _response([T]), first.revision).reset is True
    assert revisions.project(("NXT",), _response([T]), second.revision).reset is True

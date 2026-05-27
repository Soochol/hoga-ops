"""Stage 7-α / 7-β — /api/live router."""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_test_app(get_status_fn=None, control_fn=None):
    """Mount the live router on a bare FastAPI for isolated testing."""
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    app = FastAPI()
    app.include_router(
        build_router(
            get_status=get_status_fn or lifecycle.get_status,
            on_control=control_fn,
        )
    )
    return app


def test_get_live_status_returns_running_false_initially() -> None:
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()

    app = _make_test_app()
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        body = r.json()
        assert body["running"] is False
        assert body["watchlist_count"] == 0
        assert body["kis_calls_today"] == 0


def test_post_live_control_dispatches_action() -> None:
    recorded: list[str] = []

    def fake_control(action: str) -> None:
        recorded.append(action)

    app = _make_test_app(control_fn=fake_control)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "stop"})
        assert r.status_code == 200
        assert recorded == ["stop"]


def test_post_live_control_rejects_unknown_action() -> None:
    app = _make_test_app(control_fn=lambda action: None)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "nuke"})
        assert r.status_code == 422  # pydantic validation error


def test_live_router_registered_on_full_app(tmp_path) -> None:
    """create_app should mount /api/live/status."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        assert r.json()["running"] is False


def test_get_live_snapshot_returns_404_when_no_data(tmp_path) -> None:
    """No publish yet → 404."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/snapshot?code=005930")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_live_snapshot_returns_buffered_latest(tmp_path) -> None:
    """After publish, GET /snapshot returns the latest entry."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    await buf.publish("005930", [
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.OB, payload={"total_bid_qty": 1000}),
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.TRADE, payload={"trades": [{"price": 100}]}),
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
    ])

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/snapshot?code=005930")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert body["t_ms"] == 12345
        assert body["orderbook"]["total_bid_qty"] == 1000
        assert body["recent_trades"] == [{"price": 100}]


@pytest.mark.asyncio
async def test_get_live_series_returns_buffered_arrays(tmp_path) -> None:
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    for tick in range(3):
        t = (tick + 1) * 10_000
        await buf.publish("005930", [
            LiveSnapshot(t_ms=t, kind=SnapshotKind.OB, payload={"total_bid_qty": 100 + tick}),
            LiveSnapshot(t_ms=t, kind=SnapshotKind.TRADE, payload={"trades": []}),
            LiveSnapshot(t_ms=t, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
        ])

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/series?code=005930&date=20260527")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert body["date"] == "20260527"
        assert body["is_open"] is True  # session_close_ms None while live
        assert body["session_close_ms"] is None
        assert len(body["snapshots"]) == 3
        assert body["snapshots"][0]["total_bid_qty"] == 100


@pytest.mark.asyncio
async def test_get_live_stream_emits_published_snapshots() -> None:
    """The SSE stream inner generator yields live_snapshot events for published data."""
    import json as _json

    from hoga.live.buffer import LiveBuffer
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    buf = LiveBuffer()
    q = buf.subscribe("005930")

    # Publish a snapshot BEFORE starting the generator so the queue is pre-loaded
    await buf.publish("005930", [
        LiveSnapshot(t_ms=42, kind=SnapshotKind.OB, payload={"total_bid_qty": 999}),
    ])

    # Replicate the inner stream() generator logic from the endpoint
    async def _stream_one():
        """Read one entry from the queue and return the SSE event dict."""
        entry = await asyncio.wait_for(q.get(), timeout=1.0)
        return {"event": "live_snapshot", "data": _json.dumps(entry)}

    sse_event = await _stream_one()
    buf.unsubscribe("005930", q)

    assert sse_event["event"] == "live_snapshot"
    payload = _json.loads(sse_event["data"])
    assert payload["t_ms"] == 42
    assert payload["total_bid_qty"] == 999


def test_get_live_candles_503_when_kis_not_set(tmp_path) -> None:
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/candles?code=005930&timeframe=1m")
        assert r.status_code == 503


@pytest.mark.asyncio
async def test_get_live_candles_returns_kis_response(tmp_path) -> None:
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.kis_models import KisCandle

    lifecycle.reset_for_tests()

    class _FakeKis:
        async def fetch_candles(self, code: str, *, timeframe: str) -> list[KisCandle]:
            return [
                KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=1000),
            ]

    lifecycle.set_kis_client(_FakeKis())  # type: ignore[arg-type]

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/candles?code=005930&timeframe=1m")
        assert r.status_code == 200
        body = r.json()
        assert body["candles"][0]["open"] == 100
        assert body["cached"] is False

        # Second call should hit cache
        r2 = c.get("/api/live/candles?code=005930&timeframe=1m")
        assert r2.json()["cached"] is True


def test_get_live_candles_invalid_timeframe(tmp_path) -> None:
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()

    class _FakeKis:
        async def fetch_candles(self, code, *, timeframe):
            return []

    lifecycle.set_kis_client(_FakeKis())  # type: ignore[arg-type]
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/candles?code=005930&timeframe=bad")
        assert r.status_code == 422

"""Behavioral tests for the single WebSocket transport (ADR-0053).

Exercise the /api/ws endpoint end-to-end through Starlette's TestClient:
global _Bus events are auto-delivered, per-code subscribe acks then streams
code-tagged live frames, and explicit unsubscribe tears the subscription down.
"""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.sse import _Bus
from hoga.api.ws import build_ws_router
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def _make_app() -> tuple[FastAPI, _Bus, LiveBuffer]:
    bus = _Bus()
    buf = LiveBuffer()
    app = FastAPI()
    app.include_router(build_ws_router(bus, lambda: buf))
    return app, bus, buf


def test_global_events_auto_delivered():
    app, bus, _ = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        bus.publish({"type": "inventory_added", "code": "005930", "date": "20260530"})
        frame = ws.receive_json()
        assert frame["ch"] == "event"
        assert frame["data"]["type"] == "inventory_added"


def test_subscribe_acks_then_delivers_code_tagged_live():
    app, _, buf = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930"})
        ack = ws.receive_json()
        assert ack == {"ch": "subscribed", "code": "005930"}
        assert client.portal is not None  # set by TestClient.__enter__
        client.portal.call(
            buf.publish,
            "005930",
            [LiveSnapshot(t_ms=100, kind=SnapshotKind.OB, payload={"total_bid_qty": 5})],
        )
        frame = ws.receive_json()
        assert frame["ch"] == "live"
        assert frame["code"] == "005930"
        assert frame["data"]["kind"] == "ob"
        assert frame["data"]["t_ms"] == 100


def test_unsubscribe_tears_down_code_subscription():
    # "No frame arrives" is non-deterministic with TestClient's blocking
    # receive (no timeout), so we assert teardown directly: after unsubscribe
    # the buffer drops the code from its subscriber registry, and a re-subscribe
    # produces a fresh ack (proving the prior subscription was gone).
    app, _, buf = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        assert client.portal is not None  # set by TestClient.__enter__

        ws.send_json({"action": "subscribe", "code": "005930"})
        assert ws.receive_json() == {"ch": "subscribed", "code": "005930"}
        # subscribe registered exactly one queue for the code.
        assert client.portal.call(lambda: "005930" in buf._subscribers)

        client.portal.call(
            buf.publish,
            "005930",
            [LiveSnapshot(t_ms=100, kind=SnapshotKind.OB, payload={"total_bid_qty": 5})],
        )
        frame = ws.receive_json()
        assert frame["ch"] == "live"
        assert frame["code"] == "005930"

        ws.send_json({"action": "unsubscribe", "code": "005930"})
        # Re-subscribe: a fresh ack proves the prior subscription was torn down
        # (the receiver re-entered the buffer.subscribe() branch).
        ws.send_json({"action": "subscribe", "code": "005930"})
        assert ws.receive_json() == {"ch": "subscribed", "code": "005930"}
        # Exactly one live queue remains for the code — the unsubscribe removed
        # the old one before the re-subscribe added a new one.
        assert client.portal.call(lambda: len(buf._subscribers["005930"]) == 1)

"""Behavioral tests for the single WebSocket transport (ADR-0053).

Exercise the /api/ws endpoint end-to-end through Starlette's TestClient:
global EventBus events are auto-delivered, per-code subscribe acks then streams
code-tagged live frames, and explicit unsubscribe tears the subscription down.
"""
import threading
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.events import EventBus, build_event_bus
from hoga.api.ws import build_ws_router
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def test_build_event_bus_exposes_unbound_handler(tmp_path):
    bus, observer, handler = build_event_bus(tmp_path / "parquet")
    assert handler.loop is None  # lifespan binds it; the removed route used to
    # observer is scheduled but NOT started — do not start/join it here.


def _make_app() -> tuple[FastAPI, EventBus, LiveBuffer]:
    bus = EventBus()
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


def test_heartbeat_on_idle():
    bus = EventBus()
    buf = LiveBuffer()
    app = FastAPI()
    app.include_router(build_ws_router(bus, lambda: buf, ping_timeout_s=0.05))
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        frame = ws.receive_json()
        assert frame == {"ch": "heartbeat"}
        # Close from the client side before leaving the context so the server's
        # rapid (50ms) heartbeat sender is torn down deterministically — avoids a
        # CancelledError racing out of the portal on context exit (test-only flake).
        ws.close()


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


def test_frame_envelope_shapes():
    """Pin the complete server→client frame contract in one place.

    Server emits exactly four ``ch`` discriminants.  If a future dev adds a
    fifth ch, this test is where they document it.  ws.ts's ``Frame`` union
    must mirror these exactly (no codegen — ADR-0004).

    Expected shapes per ch:
      - "event"      → {"ch": "event",      "data": {...}}
      - "subscribed" → {"ch": "subscribed", "code": <str>}
      - "live"       → {"ch": "live",       "code": <str>, "data": {...}}
      - "heartbeat"  → {"ch": "heartbeat"}
    """
    collected: list[dict] = []

    # -- "event" frame: publish a bus event before connecting so it queues immediately.
    bus = EventBus()
    buf = LiveBuffer()
    app = FastAPI()
    # Use a very short ping_timeout so the heartbeat frame arrives quickly in CI.
    app.include_router(build_ws_router(bus, lambda: buf, ping_timeout_s=0.05))

    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        assert client.portal is not None

        # Drive "event" frame.
        bus.publish({"type": "inventory_added", "code": "000660", "date": "20260530"})
        event_frame = ws.receive_json()
        assert event_frame["ch"] == "event"
        assert "data" in event_frame
        collected.append(event_frame)

        # Drive "subscribed" ack frame.
        ws.send_json({"action": "subscribe", "code": "000660"})
        sub_frame = ws.receive_json()
        assert sub_frame["ch"] == "subscribed"
        assert "code" in sub_frame
        collected.append(sub_frame)

        # Drive "live" frame.
        client.portal.call(
            buf.publish,
            "000660",
            [LiveSnapshot(t_ms=200, kind=SnapshotKind.OB, payload={"total_bid_qty": 9})],
        )
        live_frame = ws.receive_json()
        assert live_frame["ch"] == "live"
        assert "code" in live_frame
        assert "data" in live_frame
        collected.append(live_frame)

        # Drive "heartbeat" frame: wait for the 50 ms idle timeout.
        hb_frame = ws.receive_json()
        assert hb_frame == {"ch": "heartbeat"}
        collected.append(hb_frame)

        ws.close()  # deterministic teardown before context exit

    # Assert the complete set of ch discriminants is exactly the documented contract.
    observed_chs = {f["ch"] for f in collected}
    assert observed_chs == {"event", "subscribed", "live", "heartbeat"}, (
        "Server emitted an undocumented ch discriminant or a documented one is missing. "
        "Update ws.ts's Frame union and this set to match."
    )


# ── ADR-0067: lifecycle forward tests ─────────────────────────────────────────


def test_subscribe_forwards_to_lifecycle_on_view_subscribe(monkeypatch):
    """action:subscribe → lifecycle.on_view_subscribe(code) called once.

    ADR-0067: /api/ws must forward view-subscribe signals to the REST poller
    lifecycle so it can activate per-code polling.  Existing buf.subscribe
    behaviour (subscribe ack frame) must be preserved.
    """
    from hoga.live import lifecycle as lc

    spy_subscribe = MagicMock()
    monkeypatch.setattr(lc, "on_view_subscribe", spy_subscribe)

    app, _, _ = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930"})
        ack = ws.receive_json()

    # Existing behaviour preserved — ack frame still arrives.
    assert ack == {"ch": "subscribed", "code": "005930"}
    # ADR-0067 forward: called exactly once with the code.
    spy_subscribe.assert_called_once_with("005930")


def test_unsubscribe_forwards_to_lifecycle_on_view_unsubscribe(monkeypatch):
    """action:unsubscribe → lifecycle.on_view_unsubscribe(code) called exactly once.

    ADR-0067: explicit unsubscribe must forward to the lifecycle so the REST
    poller can deactivate polling for that code.

    After the explicit unsubscribe the code is removed from code_subs, so the
    disconnect finally-block does NOT call on_view_unsubscribe again — exactly
    one call is expected.
    """
    from hoga.live import lifecycle as lc

    calls: list[str] = []
    done = threading.Event()

    def spy(code: str) -> None:
        calls.append(code)
        done.set()

    monkeypatch.setattr(lc, "on_view_unsubscribe", spy)

    app, _, buf = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930"})
        ws.receive_json()  # ack

        # Explicit unsubscribe — removes "005930" from code_subs.
        ws.send_json({"action": "unsubscribe", "code": "005930"})

        # Synchronise: wait for the spy to fire before exiting the WS context.
        # We use a send+receive round-trip as a server-queue flush fence.
        ws.send_json({"action": "subscribe", "code": "000660"})
        ws.receive_json()  # ack 000660 — confirms the unsubscribe was processed first

        # At this point "005930" is gone from code_subs; "000660" is there.
        # On exit: finally captures subs=[("000660", ...)], calls spy("000660").

    # Spy must have been called for 005930 (explicit) and possibly 000660 (disconnect).
    assert "005930" in calls, f"Expected on_view_unsubscribe('005930'); calls={calls!r}"
    assert calls.count("005930") == 1, f"Expected exactly one call for 005930; calls={calls!r}"


def test_disconnect_calls_on_view_unsubscribe_for_all_subscribed_codes(monkeypatch):
    """Disconnect must call on_view_unsubscribe for every subscribed code.

    ADR-0067: if a client subscribes to multiple codes and then disconnects
    (without explicit unsubscribe), on_view_unsubscribe must be called for
    each subscribed code in the finally cleanup so no ghost polling is left.
    """
    from hoga.live import lifecycle as lc

    unsubscribed_codes: list[str] = []
    done = threading.Event()

    def spy(code: str) -> None:
        unsubscribed_codes.append(code)
        if len(unsubscribed_codes) >= 2:  # noqa: PLR2004
            done.set()

    monkeypatch.setattr(lc, "on_view_unsubscribe", spy)

    app, _, _ = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930"})
        ws.receive_json()  # ack 005930
        ws.send_json({"action": "subscribe", "code": "000660"})
        ws.receive_json()  # ack 000660
        ws.close()  # client-side close triggers server finally

    # Wait for the server-side finally to run (cross-thread).
    assert done.wait(timeout=2.0), (
        f"on_view_unsubscribe not called for both codes within 2 s; got {unsubscribed_codes!r}"
    )
    assert set(unsubscribed_codes) == {"005930", "000660"}

"""Behavioral tests for the single WebSocket transport (ADR-0053).

Exercise the /api/ws endpoint end-to-end through Starlette's TestClient:
global EventBus events are auto-delivered, per-code subscribe acks then streams
code-tagged live frames, and explicit unsubscribe tears the subscription down.
"""
import asyncio
import threading
from collections.abc import MutableMapping
from typing import Any
from unittest.mock import AsyncMock

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
        ws.close()


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
        ws.close()


def test_heartbeat_on_idle():
    bus = EventBus()
    buf = LiveBuffer()
    app = FastAPI()
    app.include_router(build_ws_router(bus, lambda: buf, ping_timeout_s=0.05))
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        frame = ws.receive_json()
        assert frame == {"ch": "heartbeat"}
        # Close from the client side before leaving the context so the server's
        # rapid (50ms) heartbeat sender is torn down deterministically.
        # (이건 원래 "포털 밖으로 CancelledError 가 새는" flake 회피용이기도 했다.
        # 그 원인은 엔드포인트 finally 쪽에서 고쳤으니 — 아래
        # test_cancelled_teardown_releases_bus_subscription 참조 — 이제는 그냥
        # 명시적 종료다.)
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
        ws.close()


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

    spy_subscribe = AsyncMock(return_value=True)
    monkeypatch.setattr(lc, "on_view_subscribe", spy_subscribe)

    app, _, _ = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930"})
        ack = ws.receive_json()
        ws.close()

    # Existing behaviour preserved — ack frame still arrives.
    assert ack == {"ch": "subscribed", "code": "005930"}
    # ADR-0067/PR-C forward: awaited once, first positional arg = the code.
    spy_subscribe.assert_awaited_once()
    assert spy_subscribe.await_args.args[0] == "005930"


def test_subscribe_forwards_venues_and_ref(monkeypatch):
    """PR-C: subscribe 액션의 venues 옵션과 연결별 ref가 lifecycle로 전달된다."""
    from hoga.live import lifecycle as lc

    spy = AsyncMock(return_value=True)
    monkeypatch.setattr(lc, "on_view_subscribe", spy)

    app, _, _ = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930", "venues": ["KRX", "NXT"]})
        ws.receive_json()  # ack
        ws.close()

    spy.assert_awaited_once()
    args = spy.await_args
    assert args.args[0] == "005930"
    assert args.args[1] == {"KRX", "NXT"}          # venues 파싱 전달(UN 옵션)
    assert args.kwargs["ref"].startswith("ws-")     # 연결(탭)별 참조 토큰


def test_subscribe_full_house_emits_event(monkeypatch):
    """PR-C: 키움 만석(on_view_subscribe False)이면 요청 탭에 만석 이벤트(토스트)."""
    from hoga.live import lifecycle as lc

    monkeypatch.setattr(lc, "on_view_subscribe", AsyncMock(return_value=False))

    app, _, _ = _make_app()
    with TestClient(app) as client, client.websocket_connect("/api/ws") as ws:
        ws.send_json({"action": "subscribe", "code": "005930"})
        frames = [ws.receive_json(), ws.receive_json()]
        ws.close()

    events = [f for f in frames if f.get("ch") == "event"]
    assert any(e["data"].get("type") == "kiwoom_full_house"
               and e["data"].get("code") == "005930" for e in events)
    # 만석이어도 구독 ack은 도착(탭은 버퍼 구독 유지).
    assert any(f == {"ch": "subscribed", "code": "005930"} for f in frames)


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

    async def spy(code, venues=None, *, ref=None):
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
        ws.close()

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

    async def spy(code, venues=None, *, ref=None):
        unsubscribed_codes.append(code)
        if len(unsubscribed_codes) >= 2:
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


# ── teardown 계약: 취소된 상태로 finally 에 들어와도 정리가 끝나야 한다 ────────


async def _drive_raw_ws(app: FastAPI) -> asyncio.Task[None]:
    """미들웨어 없이 /api/ws 엔드포인트를 생 ASGI 로 띄운 태스크를 돌려준다.

    TestClient 로는 "취소가 finally 도중에 도착" 을 재현할 수 없다 — 항상
    close 를 먼저 보내 정상 경로로 빠진다. 여기서는 클라이언트가 아무것도
    보내지 않는 채로 태스크를 직접 cancel 해서 그 경로를 만든다.
    """
    inbox: asyncio.Queue[dict] = asyncio.Queue()
    inbox.put_nowait({"type": "websocket.connect"})

    async def receive() -> dict:
        return await inbox.get()

    async def send(_message: MutableMapping[str, Any]) -> None:
        return None

    scope = {
        "type": "websocket", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "scheme": "ws", "path": "/api/ws", "raw_path": b"/api/ws", "query_string": b"",
        "root_path": "", "headers": [], "client": ("testclient", 50000),
        "server": ("testserver", 80), "subprotocols": [], "state": {},
    }
    return asyncio.create_task(app(scope, receive, send))


async def _settle(predicate, *, limit: int = 200) -> bool:
    """벽시계 없이 루프를 돌려 조건이 설 때까지 기다린다(횟수 상한만 둔다)."""
    for _ in range(limit):
        if predicate():
            return True
        await asyncio.sleep(0)
    return predicate()


async def test_cancelled_teardown_releases_bus_subscription():
    """엔드포인트 태스크가 취소돼도 EventBus 구독이 반드시 해제된다.

    이전 판은 finally 에서 `await asyncio.gather(...)` 를 **먼저** 했다.
    `return_exceptions=True` 는 자식의 예외만 담는다 — await 하는 태스크 자신이
    취소된 상태면 그 await 가 그대로 CancelledError 를 던지고, 뒤따르던
    `bus.unsubscribe(bus_q)` 는 영영 실행되지 않았다(연결마다 큐가 샌다).
    그래서 동기 정리를 전부 await 앞으로 옮겼다.
    """
    app, bus, _ = _make_app()
    task = await _drive_raw_ws(app)

    assert await _settle(lambda: len(bus.queues) == 1), (
        f"엔드포인트가 버스를 구독하지 못했다: {bus.queues!r}"
    )

    # 취소를 **반복** 전달한다. 이게 실제 조건이다 — 이 엔드포인트를 취소하는
    # 주체(Starlette TestClient / anyio 취소 스코프)는 `_deliver_cancellation`
    # 으로 스코프가 끝날 때까지 매 루프 반복마다 다시 cancel 한다. 한 번만
    # cancel 하면 finally 안의 두 번째 await 가 멀쩡히 완료돼 버그가 숨는다.
    for _ in range(200):
        if task.done():
            break
        task.cancel()
        await asyncio.sleep(0)

    with pytest.raises(asyncio.CancelledError):
        # 취소는 전파돼야 한다. 삼키면 anyio 취소 스코프의 uncancel 회계가
        # 어긋나 CancelledError 가 ASGI 호출자 밖으로 새어 나간다 — 차단 게이트
        # 위 test_api_ws_inventory flake 의 원인이었다.
        await task

    assert bus.queues == set(), (
        f"취소 경로에서 버스 구독이 샜다: {bus.queues!r}"
    )

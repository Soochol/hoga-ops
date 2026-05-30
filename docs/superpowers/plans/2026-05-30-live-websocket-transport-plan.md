# Live WebSocket Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: both
```

**Goal:** Replace the two long-lived SSE streams (`/api/events`, `/api/live/stream`) with a single per-tab WebSocket (`/api/ws`) so the HTTP/1.1 6-connection-per-origin pool is never exhausted by multiple `/live` tabs.

**Architecture:** One Starlette WebSocket endpoint multiplexes global app events (from `_Bus`) and per-code live snapshots (from `LiveBuffer`) into `{ch, data}` frames (`live` frames are `code`-tagged); the client demuxes by `ch`/`code` and sends `{action, code}` to (un)subscribe codes. A frontend `ws.ts` singleton owns the socket with backoff reconnect, stamps liveness on every frame, and emits one-shot `connected`/`disconnected` events. Data sources (`_Bus`, watchdog, `LiveBuffer`, KIS poller) are unchanged — only the wire transport changes (ADR-0053). The ADR-0044 hover-spot parquet REST path is untouched.

**Tech Stack:** FastAPI/Starlette 1.0 native WebSocket (`@router.websocket`), React + Vite 8, Vitest/jsdom, `@tanstack/react-query`.

**Reference:** spec `docs/superpowers/specs/2026-05-30-live-websocket-transport-design.md`; ADR-0053. Plan-review fixes (eng + design, 2026-05-30) folded in — see header notes and the Deferred section.

**Deferred-memo decisions (from grill):**
1. **Rename `sse.ts` → `eventStream.ts`** (and its test). The `SSEEvent` *type* keeps its name (cosmetic; deferred).
2. **No automatic live-buffer re-hydrate on reconnect** in v1. Reconnect re-subscribes the active code and fires the existing disconnect-recovery query invalidation **once per disconnect** (not per retry); gaps self-heal as ticks resume.
3. **Remove `sse-starlette` dependency** as a late task, gated on confirming no other `EventSourceResponse` users.

**Plan-review fixes folded in (blockers/criticals):**
- Import blast radius is **11 sites**, not 3: prod `App.tsx`, `capture/useCaptureQueue.ts`, `inventory/useInventoryRecaptureOrigins.ts`, **`nav/StatusDot.tsx`** (imports `lastHeartbeat`), plus **7 test files** doing `vi.mock('../api/sse', …)`: `nav/CaptureStatusPill.test.tsx`, `capture/CaptureForm.test.tsx`, `capture/CaptureQueue.test.tsx`, `capture/useCaptureQueue.test.tsx`, `pages/Capture.test.tsx`, `inventory/useInventoryRecapture.test.tsx`, `inventory/StockDateGroupDetail.test.tsx`. ALL re-pointed in the rename commit (Task 5).
- `eventStream.ts` **must re-export `lastHeartbeat`** (StatusDot depends on it) — backed by a `ws.ts` liveness timestamp stamped on **every** frame.
- Backend teardown awaits cancelled tasks (`gather(..., return_exceptions=True)`) — no "Task exception never retrieved"; no dead `except WebSocketDisconnect`.
- `live` frames are **`code`-tagged**; client filters by code (multi-code-safe).
- Server sends a **`subscribed` ack**; the backend test waits for it before publishing (no race).
- `out` queue **drops on overflow** (`put_nowait`) to match `_Bus`/`LiveBuffer`.
- `inv_handler.loop` bound **before** `observer.start()`.
- `ws.ts` reconnect timer stored + cleared in `__resetForTests`.
- New **connection-state UI surface** (Task 7): StatusDot uses status tokens (`--success`/`--warn`/`--error`); `/live` `LIVE●` reflects live / 재연결 중 / stale.
- `capture_dismissed` was dropped at **two** levels in the old code (no `addEventListener` AND not in the filter) — fixed + tested.

---

## File Structure

**Backend**
- Create `hoga/api/ws.py` — `build_ws_router(bus, get_buffer)` → `@router.websocket("/api/ws")`. Connection lifecycle, dynamic per-code subscription, queue fan-in (drop on overflow), `subscribed` ack, 30s ping, gathered teardown.
- Modify `hoga/api/sse.py` — `build_sse` → `build_event_bus(parquet_root) -> tuple[_Bus, Observer, _InventoryHandler]`; drop the `/api/events` route + now-unused imports (`APIRouter`, `EventSourceResponse`, `json`).
- Modify `hoga/live/api.py` — delete the `/stream` route (`_get_stream`) + now-unused imports (`EventSourceResponse`, `asyncio`, `json as _json`).
- Modify `hoga/api/app.py` — consume `build_event_bus` (3-tuple); bind `inv_handler.loop` before `observer.start()`; include `build_ws_router`; drop the SSE router include.
- Modify `pyproject.toml` — remove `sse-starlette` (Task 9).
- Create `tests/api/test_ws.py`.

**Frontend**
- Modify `frontend/src/api/client.ts` — add `wsUrl(path)`.
- Modify `frontend/src/api/types.ts` — add `| { type: 'connected' }` to the `SSEEvent` union.
- Create `frontend/src/api/ws.ts` — singleton WS client (DI ctor via `globalThis.WebSocket`, backoff reconnect w/ stored timer, `subscribeEvents`/`subscribeLive`, `lastHeartbeat`, one-shot `connected`/`disconnected`, code-filtered live fan-out, `__resetForTests`).
- Create `frontend/src/test/fakeWebSocket.ts` + `frontend/src/api/ws.test.ts`.
- Rename `frontend/src/api/sse.ts` → `eventStream.ts` (reimplement on `ws.ts`; re-export `lastHeartbeat`; `capture_dismissed` in filter).
- Rename `frontend/src/api/sse.test.ts` → `eventStream.test.ts`.
- Modify `frontend/src/api/liveSeries.ts` + `liveSeries.test.tsx`.
- Re-point ALL 11 `../api/sse` import sites → `../api/eventStream` (Task 5).
- Modify `frontend/src/nav/StatusDot.tsx` + `frontend/src/live/LiveStatusBar.tsx` (Task 7).

---

## Task 1: Backend WebSocket endpoint (`build_ws_router`)

**Files:** Create `hoga/api/ws.py`; Test `tests/api/test_ws.py`

- [ ] **Step 1: Write the failing test** (waits for the `subscribed` ack before publishing — no race):

```python
# tests/api/test_ws.py
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
        # Buffer subscription is now registered; publish on the server loop.
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
```

> `client.portal.call(coro_fn, *args)` runs the async `buf.publish` on the same anyio portal/event loop the WS endpoint uses (verified against Starlette 1.0.0 — `WebSocketTestSession` shares the `TestClient` portal). The `subscribed` ack guarantees `buf.subscribe("005930")` ran before we publish.

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/api/test_ws.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.api.ws'`.

- [ ] **Step 3: Write `hoga/api/ws.py`**

```python
"""Single WebSocket transport for live push (ADR-0053).

Multiplexes global app events (_Bus) and per-code live snapshots (LiveBuffer)
into {ch, data} frames over one connection per tab, replacing the two SSE
endpoints. live frames are code-tagged so one socket can carry 0..N codes.
Data sources are unchanged — this is a wire-transport layer only.
"""
from __future__ import annotations

import asyncio
from typing import Callable

from fastapi import APIRouter, WebSocket

from hoga.api.sse import _Bus
from hoga.live.buffer import LiveBuffer

_PING_TIMEOUT_S = 30.0


def build_ws_router(
    bus: _Bus,
    get_buffer: Callable[[], LiveBuffer | None],
) -> APIRouter:
    router = APIRouter()

    @router.websocket("/api/ws")
    async def _ws(websocket: WebSocket) -> None:
        await websocket.accept()
        out: asyncio.Queue[dict] = asyncio.Queue(maxsize=2048)
        bus_q = bus.subscribe()
        code_subs: dict[str, tuple[asyncio.Queue, asyncio.Task]] = {}

        def emit(frame: dict) -> None:
            try:
                out.put_nowait(frame)
            except asyncio.QueueFull:
                pass  # slow client: drop (matches _Bus / LiveBuffer semantics)

        async def pump_event() -> None:
            while True:
                emit({"ch": "event", "data": await bus_q.get()})

        async def pump_live(code: str, q: asyncio.Queue) -> None:
            while True:
                emit({"ch": "live", "code": code, "data": await q.get()})

        bus_task = asyncio.create_task(pump_event())

        async def sender() -> None:
            while True:
                try:
                    frame = await asyncio.wait_for(out.get(), timeout=_PING_TIMEOUT_S)
                except asyncio.TimeoutError:
                    frame = {"ch": "heartbeat"}
                await websocket.send_json(frame)

        async def receiver() -> None:
            while True:
                msg = await websocket.receive_json()
                action = msg.get("action")
                code = msg.get("code")
                if action == "subscribe" and isinstance(code, str):
                    if code not in code_subs:
                        buf = get_buffer()
                        if buf is None:
                            continue
                        q = buf.subscribe(code)
                        code_subs[code] = (q, asyncio.create_task(pump_live(code, q)))
                    emit({"ch": "subscribed", "code": code})
                elif action == "unsubscribe" and isinstance(code, str) and code in code_subs:
                    q, task = code_subs.pop(code)
                    task.cancel()
                    buf = get_buffer()
                    if buf is not None:
                        buf.unsubscribe(code, q)

        send_task = asyncio.create_task(sender())
        recv_task = asyncio.create_task(receiver())
        try:
            await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in (send_task, recv_task, bus_task):
                t.cancel()
            subs = list(code_subs.items())
            for _code, (_q, task) in subs:
                task.cancel()
            # Await all cancellations so exceptions are retrieved (no
            # "Task exception was never retrieved" warnings on disconnect).
            await asyncio.gather(
                send_task, recv_task, bus_task,
                *(task for _code, (_q, task) in subs),
                return_exceptions=True,
            )
            buf = get_buffer()
            if buf is not None:
                for code, (q, _task) in subs:
                    buf.unsubscribe(code, q)
            bus.unsubscribe(bus_q)

    return router
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/api/test_ws.py -v`
Expected: PASS (2 tests), no asyncio "Task exception" warnings in output.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/ws.py tests/api/test_ws.py
git commit -m "feat(ws): single WebSocket endpoint (code-tagged live, ack, drop-on-overflow) (ADR-0053)"
```

---

## Task 2: Drop `/api/events`, wire WS, preserve watchdog loop binding

**Files:** `hoga/api/sse.py`, `hoga/api/app.py` (`:49`, lifespan `~79-83`, `:171`), `tests/api/test_ws.py`

- [ ] **Step 1: Write the failing regression test** (handler exposed for loop binding; do NOT join an unstarted observer):

```python
# add to tests/api/test_ws.py
from hoga.api.sse import build_event_bus


def test_build_event_bus_exposes_unbound_handler(tmp_path):
    bus, observer, handler = build_event_bus(tmp_path / "parquet")
    assert handler.loop is None  # lifespan binds it; the removed route used to
    # observer is scheduled but NOT started — do not start/join it here.
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/api/test_ws.py::test_build_event_bus_exposes_unbound_handler -v`
Expected: FAIL — `ImportError: cannot import name 'build_event_bus' from 'hoga.api.sse'`.

- [ ] **Step 3: Replace `build_sse` (sse.py lines 134-163) with `build_event_bus`:**

```python
def build_event_bus(parquet_root: Path) -> tuple[_Bus, Observer, _InventoryHandler]:
    """Create the inventory event bus + watchdog observer (no HTTP route).

    The push channel moved to the WebSocket transport (ADR-0053); this builder
    only wires the data source. ``handler.loop`` is bound by the FastAPI
    lifespan once a running loop exists (the removed ``/api/events`` route used
    to bind it lazily).
    """
    bus = _Bus()
    handler = _InventoryHandler(bus, parquet_root, loop=None)
    observer = Observer()
    parquet_root.mkdir(parents=True, exist_ok=True)
    observer.schedule(handler, str(parquet_root), recursive=True)
    return bus, observer, handler
```

Then remove the now-unused imports at the top of `sse.py`: `from fastapi import APIRouter`, `from sse_starlette.sse import EventSourceResponse`, and `import json`. Keep `import asyncio` (used by `_Bus`).

- [ ] **Step 4: Edit `hoga/api/app.py`:**

Imports (line 24 area):
```python
from hoga.api.sse import build_event_bus
from hoga.api.ws import build_ws_router
```
Line 49:
```python
    bus, observer, inv_handler = build_event_bus(data_dir / "parquet")
```
Lifespan startup — bind the loop **before** starting the observer (so startup-window filesystem events aren't dropped by the `loop is None` guard), replacing lines 81-83:
```python
        loop = asyncio.get_running_loop()
        inv_handler.loop = loop  # ADR-0053: route no longer binds this
        observer.start()
        set_captures_bus(bus, loop)
```
Replace the SSE include (line 171 `app.include_router(sse_router)`):
```python
    app.include_router(build_ws_router(bus, live_get_buffer))
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/api -v`
Expected: PASS. Update any test importing `build_sse` (rename → `build_event_bus`, 3-tuple unpack).

- [ ] **Step 6: Commit**

```bash
git add hoga/api/sse.py hoga/api/app.py tests/api/test_ws.py
git commit -m "refactor(ws): drop /api/events SSE; bind watchdog loop pre-start; wire WS router"
```

---

## Task 3: Remove the `/api/live/stream` SSE route

**Files:** `hoga/live/api.py:226-244`

- [ ] **Step 1: Confirm nothing else hits it**

Run: `grep -rn "live/stream\|_get_stream" hoga tests`
Expected: only `hoga/live/api.py`. If a test hits it, port it to `tests/api/test_ws.py`.

- [ ] **Step 2: Delete the route** — remove `hoga/live/api.py` lines 226-244 (`@router.get("/stream")` … `return EventSourceResponse(stream())`). Then remove the now-unused imports: `from sse_starlette.sse import EventSourceResponse` (line 14), `import asyncio` (line 4), `import json as _json` (line 5) — all three are used **only** inside the deleted handler (verified). Run `grep -n "asyncio\|_json\|EventSourceResponse" hoga/live/api.py` after deletion to confirm zero matches before removing the imports.

- [ ] **Step 3: Run the live tests**

Run: `uv run pytest tests/live -v`
Expected: PASS (buffer `subscribe`/`unsubscribe` still covered via `tests/api/test_ws.py`).

- [ ] **Step 4: Commit**

```bash
git add hoga/live/api.py
git commit -m "refactor(ws): remove /api/live/stream SSE route (superseded by /api/ws)"
```

---

## Task 4: Frontend `ws.ts` client + `wsUrl` + `connected` type

**Files:** `frontend/src/api/client.ts`, `frontend/src/api/types.ts`, Create `frontend/src/api/ws.ts`, `frontend/src/test/fakeWebSocket.ts`, `frontend/src/api/ws.test.ts`

- [ ] **Step 1: Add `wsUrl` to `client.ts`** (after `apiUrl`):

```typescript
/** Build a ws(s):// URL by swapping the configured http(s) api_url scheme. */
export async function wsUrl(path: string): Promise<string> {
  return (await apiUrl(path)).replace(/^http/, 'ws');
}
```

- [ ] **Step 2: Add `connected` to the `SSEEvent` union** in `types.ts` (next to `| { type: 'disconnected' }`):

```typescript
  | { type: 'connected' }
  | { type: 'disconnected' };
```

- [ ] **Step 3: Write `frontend/src/test/fakeWebSocket.ts`:**

```typescript
export const fakeSockets: FakeWebSocket[] = [];

export class FakeWebSocket {
  url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; fakeSockets.push(this); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  serverClose() { this.readyState = 3; this.onclose?.(); }
  // WS API
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  parsedSent() { return this.sent.map((s) => JSON.parse(s)); }
}

export function installFakeWebSocket(): void {
  fakeSockets.length = 0;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
}
```

- [ ] **Step 4: Write the failing `ws.test.ts`:**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeWebSocket, fakeSockets, installFakeWebSocket } from '../test/fakeWebSocket';
import { __resetForTests, lastHeartbeat, subscribeEvents, subscribeLive } from './ws';
import * as client from './client';

beforeEach(() => {
  installFakeWebSocket();
  __resetForTests();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8000/api/ws');
});

async function connect(): Promise<FakeWebSocket> {
  await new Promise((r) => setTimeout(r, 0));
  const s = fakeSockets[0];
  s.open();
  return s;
}

describe('ws.ts', () => {
  it('delivers ch:event frames and emits connected on open', async () => {
    const got: any[] = [];
    subscribeEvents((e) => got.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'inventory_added', code: '005930', date: '20260530' } });
    expect(got).toContainEqual({ type: 'connected' });
    expect(got).toContainEqual({ type: 'inventory_added', code: '005930', date: '20260530' });
  });

  it('delivers ch:live frames only to the matching code', async () => {
    const a: any[] = []; const b: any[] = [];
    subscribeLive('005930', (d) => a.push(d));
    subscribeLive('000660', (d) => b.push(d));
    const sock = await connect();
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '005930' });
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '000660' });
    sock.message({ ch: 'live', code: '005930', data: { t_ms: 1, kind: 'ob' } });
    expect(a).toEqual([{ t_ms: 1, kind: 'ob' }]);
    expect(b).toEqual([]);
  });

  it('stamps lastHeartbeat on any frame', async () => {
    subscribeEvents(() => {});
    const sock = await connect();
    expect(lastHeartbeat()).toBe(0);
    sock.message({ ch: 'heartbeat' });
    expect(lastHeartbeat()).toBeGreaterThan(0);
  });

  it('emits disconnected once on close', async () => {
    const got: any[] = [];
    subscribeEvents((e) => got.push(e));
    const sock = await connect();
    sock.serverClose();
    expect(got.filter((e) => e.type === 'disconnected')).toHaveLength(1);
  });

  it('no-ops when WebSocket is undefined (jsdom default)', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    __resetForTests();
    expect(() => subscribeEvents(() => {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(fakeSockets.length).toBe(0);
  });
});
```

> `lastHeartbeat()` uses `Date.now()`. If the test runner forbids real time, inject a clock; here `Date.now()` is fine (assertion is `> 0`).

- [ ] **Step 5: Run to verify it fails**

Run: `cd frontend && npx vitest run src/api/ws.test.ts`
Expected: FAIL — `./ws` missing exports.

- [ ] **Step 6: Implement `frontend/src/api/ws.ts`:**

```typescript
/**
 * Single WebSocket transport (ADR-0053). Replaces the two SSE EventSources.
 * Multiplexes global app events (ch:'event') and code-tagged per-code live
 * snapshots (ch:'live') over one connection per tab; demuxes by ch/code and
 * (un)subscribes codes via {action, code}. Backoff reconnect; liveness stamped
 * on every frame; one-shot connected/disconnected on state transitions.
 */
import { wsUrl } from './client';
import type { SSEEvent } from './types';

type Frame =
  | { ch: 'event'; data: SSEEvent }
  | { ch: 'live'; code: string; data: Record<string, unknown> }
  | { ch: 'subscribed'; code: string }
  | { ch: 'heartbeat' };

let _ws: WebSocket | null = null;
let _opening = false;
let _connected = false;
let _lastHeartbeatMs = 0;
let _reconnectMs = 500;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_MAX_MS = 10_000;

const _eventSubs = new Set<(e: SSEEvent) => void>();
const _liveSubs = new Map<string, Set<(d: Record<string, unknown>) => void>>();

function emitEvent(e: SSEEvent): void { _eventSubs.forEach((fn) => fn(e)); }
export function lastHeartbeat(): number { return _lastHeartbeatMs; }

function wsCtor(): typeof WebSocket | null {
  const W = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  return typeof W === 'function' ? W : null;
}

function send(obj: unknown): void {
  if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify(obj));
}

async function open(): Promise<void> {
  if (_ws || _opening) return;
  const W = wsCtor();
  if (!W) return; // jsdom / unsupported — silent no-op
  _opening = true;
  try {
    const url = await wsUrl('/api/ws');
    if (_ws) return; // raced
    const sock = new W(url);
    sock.onopen = () => {
      _reconnectMs = 500;
      if (!_connected) { _connected = true; emitEvent({ type: 'connected' }); }
      for (const code of _liveSubs.keys()) send({ action: 'subscribe', code });
    };
    sock.onmessage = (e: MessageEvent) => {
      _lastHeartbeatMs = Date.now(); // ANY frame proves liveness
      let frame: Frame;
      try { frame = JSON.parse(e.data) as Frame; } catch { return; }
      if (frame.ch === 'event') {
        emitEvent(frame.data);
      } else if (frame.ch === 'live') {
        _liveSubs.get(frame.code)?.forEach((fn) => fn(frame.data));
      }
      // ch:'subscribed' / 'heartbeat' → liveness only
    };
    sock.onclose = () => {
      _ws = null;
      if (_connected) { _connected = false; emitEvent({ type: 'disconnected' }); }
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
    _ws = sock;
  } finally {
    _opening = false;
  }
}

function scheduleReconnect(): void {
  if (!_eventSubs.size && !_liveSubs.size) return; // nobody listening
  if (_reconnectTimer !== null) return; // already scheduled
  const delay = _reconnectMs;
  _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  _reconnectTimer = setTimeout(() => { _reconnectTimer = null; void open(); }, delay);
}

export function subscribeEvents(handler: (e: SSEEvent) => void): () => void {
  _eventSubs.add(handler);
  void open();
  return () => { _eventSubs.delete(handler); };
}

export function subscribeLive(
  code: string,
  handler: (d: Record<string, unknown>) => void,
): () => void {
  let set = _liveSubs.get(code);
  const first = !set;
  if (!set) { set = new Set(); _liveSubs.set(code, set); }
  set.add(handler);
  void open();
  if (first) send({ action: 'subscribe', code }); // flushed by onopen if not yet open
  return () => {
    const s = _liveSubs.get(code);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) {
      _liveSubs.delete(code);
      send({ action: 'unsubscribe', code });
    }
  };
}

export function __resetForTests(): void {
  if (_reconnectTimer !== null) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  _ws?.close();
  _ws = null;
  _opening = false;
  _connected = false;
  _lastHeartbeatMs = 0;
  _reconnectMs = 500;
  _eventSubs.clear();
  _liveSubs.clear();
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `cd frontend && npx vitest run src/api/ws.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/types.ts frontend/src/api/ws.ts frontend/src/test/fakeWebSocket.ts frontend/src/api/ws.test.ts
git commit -m "feat(ws): frontend WebSocket client (reconnect, liveness, code-filtered fan-out)"
```

---

## Task 5: Rename `sse.ts`→`eventStream.ts`, reimplement on `ws.ts`, re-point ALL imports

**Files:** rename `sse.ts`/`sse.test.ts`; reimplement; re-point 11 sites. (Single commit — no intermediate broken state.)

- [ ] **Step 1: Rename**

```bash
git mv frontend/src/api/sse.ts frontend/src/api/eventStream.ts
git mv frontend/src/api/sse.test.ts frontend/src/api/eventStream.test.ts
```

- [ ] **Step 2: Rewrite `eventStream.ts`** (delegates to `ws.ts`; re-exports `lastHeartbeat`; `capture_dismissed` in filter; recovery only on `disconnected`):

```typescript
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { subscribeEvents, lastHeartbeat } from './ws';
import type { SSEEvent } from './types';

export { lastHeartbeat };

export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return subscribeEvents((e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery (once per disconnect transition; ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'calendar',
        });
      }
      // 'connected' → no query work; UI surfaces (StatusDot/LiveStatusBar) use it.
    });
  }, [qc]);
}

export function subscribeToCaptureEvents(handler: (e: SSEEvent) => void): () => void {
  return subscribeEvents((e: SSEEvent) => {
    if (
      e.type === 'capture_progress' ||
      e.type === 'capture_phase' ||
      e.type === 'capture_finished' ||
      e.type === 'capture_queued' ||
      e.type === 'capture_dismissed' ||
      e.type === 'capture_queue_paused' ||
      e.type === 'capture_queue_resumed' ||
      e.type === 'capture_queue_drained' ||
      e.type === 'capture_timing'
    ) {
      handler(e);
    }
  });
}
```

> `capture_dismissed` was dropped at TWO levels in the old code (no `addEventListener('capture_dismissed')` in `sse.ts` AND absent from the `subscribeToCaptureEvents` filter), so `useCaptureQueue`/`useInventoryRecaptureOriginsCleanup` never saw it in production. Adding it here fixes that latent bug.

- [ ] **Step 3: Re-point ALL 11 import sites** from `'../api/sse'`/`'./api/sse'` → `'../api/eventStream'`/`'./api/eventStream'`:

Prod (4): `App.tsx:6`, `capture/useCaptureQueue.ts:6`, `inventory/useInventoryRecaptureOrigins.ts:3`, `nav/StatusDot.tsx:2`.

Test `vi.mock` paths (7): `nav/CaptureStatusPill.test.tsx:9`, `capture/CaptureForm.test.tsx:9`, `capture/CaptureQueue.test.tsx:8`, `capture/useCaptureQueue.test.tsx:15`, `pages/Capture.test.tsx:8`, `inventory/useInventoryRecapture.test.tsx:9`, `inventory/StockDateGroupDetail.test.tsx:10` — change `vi.mock('../api/sse', …)` → `vi.mock('../api/eventStream', …)` (mock factory body unchanged; if a factory mocks `lastHeartbeat`, it still exists on the new module).

Sweep to confirm none missed:
```bash
grep -rn "api/sse'" frontend/src   # expect: no matches after this step
```

- [ ] **Step 4: Rewrite `eventStream.test.ts`** (fake WS + `ch:'event'` frames; add a `capture_dismissed` regression test):

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';
import * as client from './client';
import { subscribeToCaptureEvents, useEventStream } from './eventStream';
import type { SSEEvent } from './types';

beforeEach(() => {
  installFakeWebSocket();
  resetWs();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8000/api/ws');
});

async function connect() {
  await new Promise((r) => setTimeout(r, 0));
  const sock = fakeSockets[0];
  sock.open();
  return sock;
}

describe('subscribeToCaptureEvents', () => {
  it('delivers capture_queued events', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_queued', items: [] } });
    expect(events.map((e) => e.type)).toEqual(['capture_queued']);
  });

  it('delivers capture_dismissed (regression: dropped at two levels before)', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_dismissed', item_ids: ['x'] } });
    expect(events.map((e) => e.type)).toEqual(['capture_dismissed']);
  });

  it('drops non-capture events (inventory_added)', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'inventory_added', code: '005930', date: '20260520' } });
    expect(events).toHaveLength(0);
  });
});

describe('useEventStream disconnect handler', () => {
  it('invalidates queue + calendar + stock dates on disconnect', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useEventStream(), { wrapper });
    const sock = await connect();
    sock.serverClose();
    await new Promise((r) => setTimeout(r, 0));
    const calls = spy.mock.calls.map((c) => c[0]);
    expect(calls.some((c: any) => Array.isArray(c?.queryKey) && c.queryKey[0] === 'stock-dates')).toBe(true);
    expect(calls.some((c: any) => Array.isArray(c?.queryKey) && c.queryKey.join(',') === 'capture,queue')).toBe(true);
    expect(calls.some((c: any) => typeof c?.predicate === 'function')).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/api/eventStream.test.ts && npx tsc --noEmit`
Expected: PASS; zero TS errors (StatusDot's `lastHeartbeat` import resolves via the re-export).

- [ ] **Step 6: Commit** (explicit adds only — a concurrent diagnose session holds an unrelated `[DEBUG-x7k]` change in `LiveChartRoot.tsx`; never `git add -A`, never stage that file)

```bash
# the two renames are already staged by `git mv`; add the edits explicitly
git add frontend/src/api/eventStream.ts frontend/src/api/eventStream.test.ts \
  frontend/src/App.tsx frontend/src/capture/useCaptureQueue.ts \
  frontend/src/inventory/useInventoryRecaptureOrigins.ts frontend/src/nav/StatusDot.tsx \
  frontend/src/nav/CaptureStatusPill.test.tsx frontend/src/capture/CaptureForm.test.tsx \
  frontend/src/capture/CaptureQueue.test.tsx frontend/src/capture/useCaptureQueue.test.tsx \
  frontend/src/pages/Capture.test.tsx frontend/src/inventory/useInventoryRecapture.test.tsx \
  frontend/src/inventory/StockDateGroupDetail.test.tsx
git commit -m "refactor(ws): rename sse.ts→eventStream.ts on ws.ts; re-point 11 imports; fix capture_dismissed"
```

---

## Task 6: Migrate `liveSeries.ts` to `ws.subscribeLive`

**Files:** `frontend/src/api/liveSeries.ts:81-117`, `frontend/src/api/liveSeries.test.tsx`

- [ ] **Step 1: Rewrite the SSE effect (lines 81-117) in `liveSeries.ts`:**

```typescript
  // Subscribe to live snapshots over the shared WebSocket (ADR-0053). Buffer +
  // rAF coalescing stay tab-side; only the transport changed.
  useEffect(() => {
    if (!code) return;
    let rafId: number | null = null;
    const flush = () => { rafId = null; setTick((t) => t + 1); };
    const unsub = subscribeLive(code, (entry: Record<string, unknown>) => {
      bufferRef.current.push(entry as { t_ms: number; kind: string });
      if (rafId === null) rafId = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      bufferRef.current.clear();
      setTick(0);
    };
  }, [code]);
```

Imports at top of `liveSeries.ts`: remove `apiUrl` from the `./client` import (now only `apiCall` is used); add `import { subscribeLive } from './ws';`.

- [ ] **Step 2: Rewrite the stream parts of `liveSeries.test.tsx`** — replace the `StubEventSource` class + `beforeEach`/`afterEach` (lines 7-43) with:

```typescript
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';

beforeEach(() => {
  vi.restoreAllMocks();
  installFakeWebSocket();
  resetWs();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8000/api/ws');
});
afterEach(() => { resetWs(); });
```

Replace the "subscribes to SSE" test (lines 64-91) with a code-tagged WS test:

```typescript
  it('subscribes over WebSocket and appends code-tagged snapshots by kind', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '005930' });
    act(() => {
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'ob', total_bid_qty: 999 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'trade', trades: [] } });
    });
    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.trade).toHaveLength(1);
    expect(result.current.broker).toHaveLength(0);
  });
```

Replace the "closes the EventSource on unmount" test (lines 110-123) with an unsubscribe assertion:

```typescript
  it('unsubscribes the code on unmount', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useLiveSeries('005930'), { wrapper: wrap(qc) });
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    unmount();
    expect(sock.parsedSent()).toContainEqual({ action: 'unsubscribe', code: '005930' });
  });
```

The "fetches initial series" and "hydrates from initial series" tests are unchanged.

- [ ] **Step 3: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/api/liveSeries.test.tsx && npx tsc --noEmit`
Expected: PASS. The `ch:'live'` frame exercises the path the old `es.onmessage` silently dropped — the named-event-bug regression guard.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/liveSeries.ts frontend/src/api/liveSeries.test.tsx
git commit -m "refactor(ws): liveSeries subscribes via ws.ts; fixes dropped live ticks"
```

---

## Task 7: Connection-state UI surface (StatusDot + LiveStatusBar)

**Files:** `frontend/src/nav/StatusDot.tsx`, `frontend/src/live/LiveStatusBar.tsx`

Rationale (design-review CRITICAL): WebSocket has no auto-reconnect visibility; without this, a frozen chart looks live. StatusDot's import path was changed in Task 5; here we fix its status tokens/wording and add an honest `/live` liveness chip. Both read `lastHeartbeat()` freshness (fed by every frame + the 30s ping).

- [ ] **Step 1: Update `StatusDot.tsx`** — keep the `lastHeartbeat` freshness logic; fix the DESIGN token (yellow must not be teal `--accent`) and WS wording:

```typescript
  const color =
    status === 'green' ? 'var(--success)' : status === 'yellow' ? 'var(--warn)' : 'var(--error)';
  const text =
    status === 'green'
      ? '실시간 연결 활성'
      : status === 'yellow'
        ? '재연결 중...'
        : '백엔드 응답 없음';
  return (
    <span title={text}>
      <span
        className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
        style={{ background: color, boxShadow: status === 'green' ? `0 0 4px ${color}` : undefined }}
      />
      WS · :8000
    </span>
  );
```

(The `import { lastHeartbeat } from '../api/eventStream';` path was already set in Task 5. The 60s threshold stays — comfortably above the 30s server ping.)

- [ ] **Step 2: Add a heartbeat-driven `/live` liveness chip** — replace the hardcoded placeholder at `LiveStatusBar.tsx:69` (`<span style={{ color: 'var(--fg-dimmer)' }}>LIVE● (대기 중)</span>`) with a live/stale indicator. Add at the top of `LiveStatusBar.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { lastHeartbeat } from '../api/eventStream';
```

Inside the component, before `return`:

```typescript
  const [live, setLive] = useState(false);
  useEffect(() => {
    const tick = () => {
      const last = lastHeartbeat();
      setLive(last !== 0 && Date.now() - last < 25_000); // ~2 poll cycles
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);
```

Replace line 69 with:

```typescript
      <span style={{ color: live ? 'var(--success)' : 'var(--warn)' }}>
        {live ? 'LIVE●' : '재연결 중…'}
      </span>
```

- [ ] **Step 3: Run the related suites + typecheck**

Run: `cd frontend && npx vitest run src/nav src/live/LiveStatusBar* && npx tsc --noEmit`
Expected: PASS. If `LiveStatusBar` lacked a test, no new test is required here (covered by render in `LivePage.test.tsx`); the change is presentational.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/nav/StatusDot.tsx frontend/src/live/LiveStatusBar.tsx
git commit -m "feat(ws): honest connection-state surface (StatusDot tokens + /live LIVE/stale chip)"
```

---

## Task 8: Full frontend suite green

**Files:** none (verification; edits only if a suite breaks)

- [ ] **Step 1: Run the entire frontend test suite + typecheck**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS. The 7 `vi.mock('../api/eventStream')` suites resolve (re-pointed in Task 5). The non-mocking suites (`LivePage.test.tsx` etc.) rely on `ws.ts` no-op'ing when `globalThis.WebSocket` is undefined (jsdom) — no unhandled rejection.

- [ ] **Step 2: If any suite fails** because a component now needs a socket present, add `installFakeWebSocket()` (from `../test/fakeWebSocket`) in that file's `beforeEach`. Show the diff. Otherwise no change.

- [ ] **Step 3: Commit (only if a file changed — add ONLY the changed file(s) by explicit path; never `git add -A`, never stage `LiveChartRoot.tsx`)**

```bash
git add <explicit/path/to/changed.test.tsx> && git commit -m "test(ws): keep full suite green under WebSocket transport"
```

---

## Task 9: Remove the `sse-starlette` dependency

**Files:** `pyproject.toml`, lockfile

- [ ] **Step 1: Confirm no remaining users**

Run: `grep -rn "sse_starlette\|EventSourceResponse" hoga tests`
Expected: no matches (Tasks 2-3 removed the imports). If any remain, stop and report.

- [ ] **Step 2: Remove** the `"sse-starlette>=3.4.4",` line from `pyproject.toml`.

- [ ] **Step 3: Sync + test**

Run: `uv sync && uv run pytest -q`
Expected: install succeeds without sse-starlette; tests pass.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "chore(ws): drop sse-starlette dependency (no SSE endpoints remain)"
```

---

## Task 10: End-to-end verification

**Files:** none (manual; running dev servers)

- [ ] **Step 1: Start dev servers** per CLAUDE.md (uvicorn `--reload --reload-dir hoga`; `cd frontend && npm run dev`).

- [ ] **Step 2: Cross-origin WS handshake** (`:5173` → `:8000`):

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B js "await (async()=>{const ws=new WebSocket('ws://localhost:8000/api/ws');return await new Promise(r=>{ws.onopen=()=>r('open');ws.onerror=()=>r('error');setTimeout(()=>r('timeout'),3000)})})()"
```
Expected: `open`. If `error`, add an explicit Origin allowlist to the WS endpoint and re-run (commit separately).

- [ ] **Step 3: The original failure is GONE** — open 4 `/live` tabs, then time a real orderbook fetch while all are live:

```bash
$B newtab http://localhost:5173/live   # ×4
$B js "await (t0=>fetch('http://localhost:8000/api/orderbook?code=005930&date=20260530&t=0&bucket_ms=60000&source_pref=auto',{cache:'no-store',signal:AbortSignal.timeout(3000)}).then(r=>Math.round(performance.now()-t0)+'ms HTTP'+r.status,e=>Math.round(performance.now()-t0)+'ms '+(e.name||e)))(performance.now())"
```
Expected: fast `…ms HTTP<status>` (NOT `3000ms TimeoutError`) with 4+ tabs — the HTTP pool is no longer held by SSE.

- [ ] **Step 4: Liveness + chart under real ticks** — confirm StatusDot is green and `/live` shows `LIVE●`. During market hours, confirm the chart updates without reload AND that incoming ticks do not jump/rescale the chart or interrupt the hover-to-read-10호가 workflow (rAF coalescing preserved). If market is closed, rely on the Task 6 `ch:'live'` test for the streaming-path guard.

- [ ] **Step 5: Final full verification**

Run: `uv run pytest -q && cd frontend && npm run build`
Expected: all pass; production build succeeds.

---

## Self-Review

**Spec coverage:** §3 decision→T1-3; §4.1 protocol (code-tagged live, ack, connected/disconnected, liveness)→T1+T4; §4.2 backend→T1-3; §4.3 ws.ts/eventStream/liveSeries→T4-6; §5 reconnect→T4; §6 errors (drop-on-overflow, ping, gathered teardown, disconnect recovery)→T1+T5; §7 testing→T4-8; §8 scope→File Structure; §9 hard-cut→T2,3,9; §10 cross-origin→T10; §11 ADR-0044 invariant (hover-spot untouched)→no task touches `useLive*AtCursor`; §12 memos→header. ✓

**Placeholder scan:** every code step shows full code; no TBD/TODO. ✓

**Type consistency:** `Frame{ch,(code),data}`, `subscribeEvents(SSEEvent)`, `subscribeLive(code, Record<string,unknown>)`, `lastHeartbeat()`, `wsUrl`, `__resetForTests`, `build_event_bus`→3-tuple, `build_ws_router(bus,get_buffer)`, `{ch:'subscribed',code}` ack — identical across backend (T1-3), client (T4), consumers (T5-6), UI (T7), tests. `SSEEvent` gains `connected` (T4 types.ts). ✓

**Sequencing:** T5 re-points all 11 imports + rename in one commit (no broken intermediate); T6 imports `./ws` (created T4); T7's StatusDot path set in T5. ✓

## Deferred review notes (suggestions/nits — not blocking)

- **[SUGGESTION]** `SSEEvent` type name retained despite SSE removal — rename to `AppEvent`/`PushEvent` is wider churn (captures.ts, many sites); cosmetic, deferred.
- **[NIT, resolved in-plan]** `hoga/live/api.py` `asyncio`/`json as _json` confirmed used only in the deleted handler — Task 3 removes them definitively (grep gate).
- **[NIT]** Task 9 grep gate won't false-match import lines (removed in T2-3 first) — sequencing confirmed.
- **[NOTE, no action]** Hidden background tabs batch their rAF flush on refocus (buffer is capped per kind) — pre-existing, bounded, not a regression.
- **[SUGGESTION, folded]** DESIGN.md status-color discipline applied in T7 (`--warn` amber for reconnecting, not teal `--accent`).

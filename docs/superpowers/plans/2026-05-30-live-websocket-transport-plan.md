# Live WebSocket Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

```yaml
scope: both
```

**Goal:** Replace the two long-lived SSE streams (`/api/events`, `/api/live/stream`) with a single per-tab WebSocket (`/api/ws`) so the HTTP/1.1 6-connection-per-origin pool is never exhausted by multiple `/live` tabs.

**Architecture:** One Starlette WebSocket endpoint multiplexes global app events (from `_Bus`) and per-code live snapshots (from `LiveBuffer`) into `{ch, data}` frames; the client demuxes by `ch` and sends `{action, code}` to (un)subscribe codes. A frontend `ws.ts` singleton owns the socket with backoff reconnect; `eventStream.ts` (renamed from `sse.ts`) and `liveSeries.ts` consume it. Data sources (`_Bus`, watchdog, `LiveBuffer`, KIS poller) are unchanged — only the wire transport changes (ADR-0053). The ADR-0044 hover-spot parquet REST path is untouched.

**Tech Stack:** FastAPI/Starlette 1.0 native WebSocket (`@router.websocket`), React + Vite 8, Vitest/jsdom, `@tanstack/react-query`.

**Reference:** spec `docs/superpowers/specs/2026-05-30-live-websocket-transport-design.md`; ADR-0053.

**Deferred-memo decisions (from grill):**
1. **Rename `sse.ts` → `eventStream.ts`** (and its test). Leaving a file named `sse.ts` with zero SSE is rot; churn is 3 import sites + 1 test. The `SSEEvent` *type* keeps its name (wider churn; cosmetic) — noted as future cleanup.
2. **No automatic live-buffer re-hydrate on reconnect** in v1. Reconnect re-subscribes the active code and fires the existing disconnect-recovery query invalidation; gaps self-heal as ticks resume (spec §10/§12).
3. **Remove `sse-starlette` dependency** as the final task, gated on confirming no other `EventSourceResponse` users.

---

## File Structure

**Backend**
- Create `hoga/api/ws.py` — `build_ws_router(bus, get_buffer)` → `@router.websocket("/api/ws")`. Owns connection lifecycle, dynamic per-code subscription, queue fan-in, 30s ping, teardown.
- Modify `hoga/api/sse.py` — `build_sse` → `build_event_bus(parquet_root) -> tuple[_Bus, Observer, _InventoryHandler]`; drop the `/api/events` route. `_Bus`, `classify_inventory_event`, `_InventoryHandler` unchanged.
- Modify `hoga/live/api.py` — delete the `/stream` route (`_get_stream`); everything else unchanged.
- Modify `hoga/api/app.py` — consume `build_event_bus`, bind `handler.loop` in lifespan, include `build_ws_router`, drop the SSE router include.
- Modify `pyproject.toml` — remove `sse-starlette` (final task).
- Create `tests/api/test_ws.py` — WebSocket endpoint tests via `TestClient.websocket_connect`.

**Frontend**
- Modify `frontend/src/api/client.ts` — add `wsUrl(path)`.
- Create `frontend/src/api/ws.ts` — singleton WebSocket client (DI factory, backoff reconnect, `subscribeEvents` / `subscribeLive`, `__resetForTests`).
- Create `frontend/src/test/fakeWebSocket.ts` — shared test double.
- Create `frontend/src/api/ws.test.ts` — unit tests for `ws.ts`.
- Rename `frontend/src/api/sse.ts` → `frontend/src/api/eventStream.ts` — reimplement `useEventStream` / `subscribeToCaptureEvents` on `ws.ts`; identical public signatures.
- Rename `frontend/src/api/sse.test.ts` → `frontend/src/api/eventStream.test.ts` — stub WebSocket, fire `{ch:'event'}` frames.
- Modify `frontend/src/api/liveSeries.ts` — replace `new EventSource('/api/live/stream')` with `ws.subscribeLive(code, …)`; buffer/rAF/clear stay.
- Modify `frontend/src/api/liveSeries.test.tsx` — swap the `StubEventSource` for the fake WebSocket; fire `{ch:'live'}` frames.
- Modify import sites: `frontend/src/App.tsx`, `frontend/src/capture/useCaptureQueue.ts`, `frontend/src/inventory/useInventoryRecaptureOrigins.ts` — change `'../api/sse'` → `'../api/eventStream'`.
- **Unchanged (verify only):** `LivePage.test.tsx`, `inventory/useInventoryRecapture.test.tsx`, `capture/CaptureForm.test.tsx`, `inventory/StockDateGroupDetail.test.tsx` reference EventSource only in comments and rely on silent-fail; `ws.ts`'s `typeof WebSocket` guard preserves that.

---

## Task 1: Backend WebSocket endpoint (`build_ws_router`)

**Files:**
- Create: `hoga/api/ws.py`
- Test: `tests/api/test_ws.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/api/test_ws.py
import asyncio
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
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws") as ws:
            bus.publish({"type": "inventory_added", "code": "005930", "date": "20260530"})
            frame = ws.receive_json()
            assert frame["ch"] == "event"
            assert frame["data"]["type"] == "inventory_added"


def test_subscribe_then_live_snapshot_delivered():
    app, _, buf = _make_app()
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws") as ws:
            ws.send_json({"action": "subscribe", "code": "005930"})
            # Give the receiver task a turn to register the subscription.
            ws.send_json({"action": "subscribe", "code": "005930"})  # idempotent
            async def _pub():
                await buf.publish("005930", [LiveSnapshot(t_ms=100, kind=SnapshotKind.OB, payload={"total_bid_qty": 5})])
            client.portal.call(_pub)  # type: ignore[attr-defined]
            frame = ws.receive_json()
            assert frame["ch"] == "live"
            assert frame["data"]["kind"] == "ob"
            assert frame["data"]["t_ms"] == 100
```

> Note: `TestClient` runs the app on an anyio portal; `client.portal.call(coro_fn)` runs an async publish on the server loop. If the portal handle differs in this Starlette version, publish through a tiny test-only HTTP route instead — but try the portal first.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_ws.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.api.ws'`.

- [ ] **Step 3: Write the implementation**

```python
# hoga/api/ws.py
"""Single WebSocket transport for live push (ADR-0053).

Multiplexes global app events (_Bus) and per-code live snapshots (LiveBuffer)
into {ch, data} frames over one connection per tab, replacing the two SSE
endpoints (/api/events, /api/live/stream). Data sources are unchanged — this
is a wire-transport layer only.
"""
from __future__ import annotations

import asyncio
from typing import Callable

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

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
        # code -> (queue, pump task)
        code_subs: dict[str, tuple[asyncio.Queue, asyncio.Task]] = {}

        async def pump(channel: str, q: asyncio.Queue) -> None:
            while True:
                item = await q.get()
                await out.put({"ch": channel, "data": item})

        bus_task = asyncio.create_task(pump("event", bus_q))

        async def sender() -> None:
            while True:
                try:
                    frame = await asyncio.wait_for(out.get(), timeout=_PING_TIMEOUT_S)
                    await websocket.send_json(frame)
                except asyncio.TimeoutError:
                    await websocket.send_json({"ch": "heartbeat"})

        async def receiver() -> None:
            while True:
                msg = await websocket.receive_json()
                action = msg.get("action")
                code = msg.get("code")
                if action == "subscribe" and isinstance(code, str) and code not in code_subs:
                    buf = get_buffer()
                    if buf is None:
                        continue
                    q = buf.subscribe(code)
                    task = asyncio.create_task(pump("live", q))
                    code_subs[code] = (q, task)
                elif action == "unsubscribe" and isinstance(code, str) and code in code_subs:
                    q, task = code_subs.pop(code)
                    task.cancel()
                    buf = get_buffer()
                    if buf is not None:
                        buf.unsubscribe(code, q)

        send_task = asyncio.create_task(sender())
        recv_task = asyncio.create_task(receiver())
        try:
            await asyncio.wait(
                {send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED
            )
        except WebSocketDisconnect:
            pass
        finally:
            for task in (send_task, recv_task, bus_task):
                task.cancel()
            buf = get_buffer()
            for code, (q, task) in code_subs.items():
                task.cancel()
                if buf is not None:
                    buf.unsubscribe(code, q)
            bus.unsubscribe(bus_q)

    return router
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_ws.py -v`
Expected: PASS (both tests). If the `client.portal` handle is unavailable, switch the publish in the test to a `client.portal_factory`/anyio approach or a tiny test route, then re-run.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/ws.py tests/api/test_ws.py
git commit -m "feat(ws): single WebSocket endpoint multiplexing events + live (ADR-0053)"
```

---

## Task 2: Drop `/api/events` SSE, wire the WS router, preserve watchdog loop binding

**Files:**
- Modify: `hoga/api/sse.py` (rename `build_sse` → `build_event_bus`, drop route)
- Modify: `hoga/api/app.py:49`, `:81-83`, `:171`
- Test: `tests/api/test_ws.py` (add inventory-watchdog regression), existing SSE tests for `sse.py`

- [ ] **Step 1: Write the failing test (watchdog loop binding regression guard)**

Add to `tests/api/test_ws.py`:

```python
from hoga.api.sse import build_event_bus


def test_build_event_bus_returns_handler_for_loop_binding(tmp_path):
    # The /api/events route used to bind handler.loop lazily; with the route
    # gone, lifespan must bind it. build_event_bus must expose the handler.
    bus, observer, handler = build_event_bus(tmp_path / "parquet")
    assert handler.loop is None  # not bound until lifespan startup
    observer.stop(); observer.join()
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/api/test_ws.py::test_build_event_bus_returns_handler_for_loop_binding -v`
Expected: FAIL with `ImportError: cannot import name 'build_event_bus'`.

- [ ] **Step 3: Edit `hoga/api/sse.py`** — replace the `build_sse` function (lines 134-163) with:

```python
def build_event_bus(parquet_root: Path) -> tuple[_Bus, Observer, _InventoryHandler]:
    """Create the inventory event bus + watchdog observer (no HTTP route).

    The push channel moved to the WebSocket transport (ADR-0053); this builder
    now only wires the data source. ``handler.loop`` is bound by the FastAPI
    lifespan once a running loop exists (it used to be bound lazily by the
    removed ``/api/events`` route).
    """
    bus = _Bus()
    handler = _InventoryHandler(bus, parquet_root, loop=None)
    observer = Observer()
    parquet_root.mkdir(parents=True, exist_ok=True)
    observer.schedule(handler, str(parquet_root), recursive=True)
    return bus, observer, handler
```

Remove the now-unused `APIRouter`, `EventSourceResponse`, `asyncio`, `json` imports from `sse.py` **only if** no longer referenced (the `_Bus.publish`/handler keep `asyncio`? No — `_Bus` uses `asyncio.Queue`; keep `asyncio`. `json` and `EventSourceResponse` and `APIRouter` become unused — remove those three).

- [ ] **Step 4: Edit `hoga/api/app.py`** — three edits:

Line 24 import (unchanged module, changed symbol):
```python
from hoga.api.sse import build_event_bus
```
Add WS import near line 24:
```python
from hoga.api.ws import build_ws_router
```
Line 49:
```python
    bus, observer, inv_handler = build_event_bus(data_dir / "parquet")
```
Inside `lifespan` startup (after line 81 `observer.start()` / alongside line 83):
```python
        observer.start()
        # bus + loop for thread-safe publishes from the watchdog thread.
        loop = asyncio.get_running_loop()
        inv_handler.loop = loop  # ADR-0053: route no longer binds this
        set_captures_bus(bus, loop)
```
Replace the SSE include (line 171 `app.include_router(sse_router)`) with:
```python
    app.include_router(build_ws_router(bus, live_get_buffer))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/api/test_ws.py tests/api/ -v -k "ws or sse or event or inventory or app"`
Expected: PASS. Fix any `sse.py` test that referenced `build_sse` (rename to `build_event_bus`, adjust unpacking to 3-tuple).

- [ ] **Step 6: Commit**

```bash
git add hoga/api/sse.py hoga/api/app.py tests/api/test_ws.py
git commit -m "refactor(ws): drop /api/events SSE; bind watchdog loop in lifespan; wire WS router"
```

---

## Task 3: Remove the `/api/live/stream` SSE route

**Files:**
- Modify: `hoga/live/api.py:226-244` (delete `_get_stream`)
- Test: existing `hoga/live` tests

- [ ] **Step 1: Confirm no test depends on `/api/live/stream`**

Run: `grep -rn "live/stream\|_get_stream\|EventSourceResponse" hoga tests`
Expected: only `hoga/live/api.py`. If a test hits `/api/live/stream`, delete/port it to the WS test.

- [ ] **Step 2: Delete the route** — remove lines 226-244 (`@router.get("/stream")` … `return EventSourceResponse(stream())`) from `hoga/live/api.py`. Remove the now-unused `EventSourceResponse` import (line 14) and `asyncio`/`json as _json` **only if** unused elsewhere in the file (check: `asyncio` may be unused after; `_json` likely unused — remove if so).

- [ ] **Step 3: Run the live API tests**

Run: `uv run pytest tests/live -v`
Expected: PASS (the buffer's `subscribe`/`unsubscribe` are still exercised via the WS test).

- [ ] **Step 4: Commit**

```bash
git add hoga/live/api.py
git commit -m "refactor(ws): remove /api/live/stream SSE route (superseded by /api/ws)"
```

---

## Task 4: Frontend `ws.ts` client + `wsUrl` helper

**Files:**
- Modify: `frontend/src/api/client.ts` (add `wsUrl`)
- Create: `frontend/src/api/ws.ts`
- Create: `frontend/src/test/fakeWebSocket.ts`
- Create: `frontend/src/api/ws.test.ts`

- [ ] **Step 1: Add `wsUrl` to `client.ts`** (after `apiUrl`, line 9):

```typescript
/** Build a ws(s):// URL for the WebSocket transport by swapping the scheme
 *  of the configured http(s) api_url. */
export async function wsUrl(path: string): Promise<string> {
  const http = await apiUrl(path);
  return http.replace(/^http/, 'ws');
}
```

- [ ] **Step 2: Write the fake WebSocket test double**

```typescript
// frontend/src/test/fakeWebSocket.ts
export const fakeSockets: FakeWebSocket[] = [];

export class FakeWebSocket {
  static OPEN = 1;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    fakeSockets.push(this);
  }
  // Test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  message(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  serverClose() { this.readyState = 3; this.onclose?.(); }
  // WS API
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

export function installFakeWebSocket(): void {
  fakeSockets.length = 0;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
}
```

- [ ] **Step 3: Write the failing test for `ws.ts`**

```typescript
// frontend/src/api/ws.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeWebSocket, fakeSockets, installFakeWebSocket } from '../test/fakeWebSocket';
import { __resetForTests, subscribeEvents, subscribeLive } from './ws';
import * as client from './client';
import { vi } from 'vitest';

beforeEach(() => {
  installFakeWebSocket();
  __resetForTests();
  vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8000/api/ws');
});

describe('ws.ts', () => {
  it('delivers ch:event frames to event subscribers', async () => {
    const got: unknown[] = [];
    subscribeEvents((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 0)); // let wsUrl resolve + socket construct
    const sock = fakeSockets[0];
    sock.open();
    sock.message({ ch: 'event', data: { type: 'inventory_added', code: '005930', date: '20260530' } });
    expect(got).toEqual([{ type: 'inventory_added', code: '005930', date: '20260530' }]);
  });

  it('sends subscribe on first live subscriber and delivers ch:live frames', async () => {
    const got: unknown[] = [];
    subscribeLive('005930', (d) => got.push(d));
    await new Promise((r) => setTimeout(r, 0));
    const sock = fakeSockets[0];
    sock.open(); // onopen flushes pending subscribe
    expect(sock.sent.map((s) => JSON.parse(s))).toContainEqual({ action: 'subscribe', code: '005930' });
    sock.message({ ch: 'live', data: { t_ms: 100, kind: 'ob' } });
    expect(got).toEqual([{ t_ms: 100, kind: 'ob' }]);
  });

  it('emits a disconnected event to event subscribers on close', async () => {
    const got: any[] = [];
    subscribeEvents((e) => got.push(e));
    await new Promise((r) => setTimeout(r, 0));
    const sock = fakeSockets[0];
    sock.open();
    sock.serverClose();
    expect(got.some((e) => e.type === 'disconnected')).toBe(true);
  });

  it('no-ops when WebSocket is undefined (jsdom default)', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    __resetForTests();
    expect(() => subscribeEvents(() => {})).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd frontend && npx vitest run src/api/ws.test.ts`
Expected: FAIL — `./ws` has no exports / module missing.

- [ ] **Step 5: Implement `ws.ts`**

```typescript
// frontend/src/api/ws.ts
/**
 * Single WebSocket transport (ADR-0053). Replaces the two SSE EventSources.
 * Multiplexes global app events (ch:'event') and per-code live snapshots
 * (ch:'live') over one connection per tab; demuxes by `ch` and (un)subscribes
 * codes via {action, code} messages. Backoff reconnect + active-code resubscribe.
 */
import { wsUrl } from './client';
import type { SSEEvent } from './types';

type Frame = { ch: 'event' | 'live' | 'heartbeat'; data?: unknown };

let _ws: WebSocket | null = null;
let _opening = false;
let _reconnectMs = 500;
const RECONNECT_MAX_MS = 10_000;

const _eventSubs = new Set<(e: SSEEvent) => void>();
const _liveSubs = new Map<string, Set<(d: Record<string, unknown>) => void>>();

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
      // Resubscribe every active code after a (re)connect.
      for (const code of _liveSubs.keys()) send({ action: 'subscribe', code });
    };
    sock.onmessage = (e: MessageEvent) => {
      let frame: Frame;
      try { frame = JSON.parse(e.data) as Frame; } catch { return; }
      if (frame.ch === 'event') {
        _eventSubs.forEach((fn) => fn(frame.data as SSEEvent));
      } else if (frame.ch === 'live') {
        // ch:'live' frames are not code-tagged on the wire (one code per tab in
        // practice); fan out to all live subscribers, which key by buffer kind.
        _liveSubs.forEach((set) =>
          set.forEach((fn) => fn(frame.data as Record<string, unknown>)),
        );
      }
      // ch:'heartbeat' → ignore (liveness only).
    };
    sock.onclose = () => {
      _ws = null;
      _eventSubs.forEach((fn) => fn({ type: 'disconnected' }));
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
  const delay = _reconnectMs;
  _reconnectMs = Math.min(_reconnectMs * 2, RECONNECT_MAX_MS);
  setTimeout(() => { void open(); }, delay);
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
  if (first) send({ action: 'subscribe', code }); // flushed on open if not yet connected
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
  _ws?.close();
  _ws = null;
  _opening = false;
  _reconnectMs = 500;
  _eventSubs.clear();
  _liveSubs.clear();
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd frontend && npx vitest run src/api/ws.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/api/ws.ts frontend/src/test/fakeWebSocket.ts frontend/src/api/ws.test.ts
git commit -m "feat(ws): frontend WebSocket client with backoff reconnect + per-code subscribe"
```

---

## Task 5: Rename `sse.ts` → `eventStream.ts`, reimplement on `ws.ts`

**Files:**
- Rename: `frontend/src/api/sse.ts` → `frontend/src/api/eventStream.ts`
- Rename: `frontend/src/api/sse.test.ts` → `frontend/src/api/eventStream.test.ts`
- Modify: `frontend/src/App.tsx:6`, `frontend/src/capture/useCaptureQueue.ts:6`, `frontend/src/inventory/useInventoryRecaptureOrigins.ts:3`

- [ ] **Step 1: Rename the files (preserve history)**

```bash
git mv frontend/src/api/sse.ts frontend/src/api/eventStream.ts
git mv frontend/src/api/sse.test.ts frontend/src/api/eventStream.test.ts
```

- [ ] **Step 2: Rewrite `eventStream.ts`** to delegate to `ws.ts` (replace the EventSource internals; keep `useEventStream` + `subscribeToCaptureEvents` signatures):

```typescript
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STOCK_DATES_QUERY_KEY } from './stock-dates';
import { subscribeEvents } from './ws';
import type { SSEEvent } from './types';

export function useEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const unsub = subscribeEvents((e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      } else if (e.type === 'disconnected') {
        // Reconnect recovery: refetch queue + calendar + stock dates (ADR-0019).
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'calendar',
        });
      }
    });
    return unsub;
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

> Note: `capture_dismissed` is added to the filter — `useInventoryRecaptureOrigins` needs it and the old `subscribeToCaptureEvents` filter omitted it (latent gap; the old code registered the `capture_dismissed` listener on the EventSource directly). Verify against `SSEEvent` union in `types.ts`.

- [ ] **Step 3: Update the three import sites**

`App.tsx:6`, `capture/useCaptureQueue.ts:6`, `inventory/useInventoryRecaptureOrigins.ts:3`:
```typescript
// from:
import { useEventStream } from './api/sse';            // App.tsx
import { subscribeToCaptureEvents } from '../api/sse'; // the two hooks
// to:
import { useEventStream } from './api/eventStream';
import { subscribeToCaptureEvents } from '../api/eventStream';
```

- [ ] **Step 4: Rewrite `eventStream.test.ts`** to use the fake WebSocket + `ch:'event'` frames:

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
  it('delivers capture_queued events to subscribers', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    const sock = await connect();
    sock.message({ ch: 'event', data: { type: 'capture_queued', items: [{ item_id: 'x', code: '005930', date: '20260520' }] } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('capture_queued');
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
  it('invalidates capture queue + calendar + stock dates on disconnect', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    renderHook(() => useEventStream(), { wrapper });
    const sock = await connect();
    sock.serverClose(); // ws.ts emits {type:'disconnected'} to event subs
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
Expected: PASS; no TS errors about `./api/sse`.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/api/eventStream.ts frontend/src/api/eventStream.test.ts frontend/src/App.tsx frontend/src/capture/useCaptureQueue.ts frontend/src/inventory/useInventoryRecaptureOrigins.ts
git commit -m "refactor(ws): rename sse.ts→eventStream.ts, reimplement on ws.ts transport"
```

---

## Task 6: Migrate `liveSeries.ts` to `ws.subscribeLive`

**Files:**
- Modify: `frontend/src/api/liveSeries.ts:81-117`
- Modify: `frontend/src/api/liveSeries.test.tsx`

- [ ] **Step 1: Rewrite the SSE effect (lines 81-117) in `liveSeries.ts`** to subscribe via `ws.ts`:

```typescript
  // Subscribe to live snapshots over the shared WebSocket (ADR-0053). The
  // buffer + rAF coalescing stay tab-side; only the transport changed.
  useEffect(() => {
    if (!code) return;
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      setTick((t) => t + 1);
    };
    const unsub = subscribeLive(code, (entry: Record<string, unknown>) => {
      bufferRef.current.push(entry as { t_ms: number; kind: string });
      if (rafId === null) rafId = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      bufferRef.current.clear();
      setTick(0);
    };
  }, [code]);
```

Update imports at top of `liveSeries.ts`: remove `apiUrl` if now unused (still used? `apiCall` is used for the initial fetch; `apiUrl` was only for the EventSource — remove it from the import), add:
```typescript
import { subscribeLive } from './ws';
```

- [ ] **Step 2: Rewrite the SSE parts of `liveSeries.test.tsx`** — swap `StubEventSource` for the fake WebSocket and fire `ch:'live'` frames. Replace the stub class + setup (lines 7-43) with:

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

Replace the "subscribes to SSE" test body (lines 64-91) with:

```typescript
  it('subscribes over WebSocket and appends incoming snapshots by kind', async () => {
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
    expect(sock.sent.map((s) => JSON.parse(s))).toContainEqual({ action: 'subscribe', code: '005930' });
    act(() => {
      sock.message({ ch: 'live', data: { t_ms: 100, kind: 'ob', total_bid_qty: 999 } });
      sock.message({ ch: 'live', data: { t_ms: 100, kind: 'trade', trades: [] } });
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
    expect(sock.sent.map((s) => JSON.parse(s))).toContainEqual({ action: 'unsubscribe', code: '005930' });
  });
```

The "fetches initial series" and "hydrates from initial series" tests are unchanged (they don't touch the stream).

- [ ] **Step 3: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/api/liveSeries.test.tsx && npx tsc --noEmit`
Expected: PASS. This test now fires a NAMED-channel `ch:'live'` frame, exercising the path that the old `es.onmessage` silently dropped — the regression guard for the latent bug.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/liveSeries.ts frontend/src/api/liveSeries.test.tsx
git commit -m "refactor(ws): liveSeries subscribes via ws.ts; fixes dropped live ticks (named-event bug)"
```

---

## Task 7: Verify the four ancillary tests still pass (no change expected)

**Files (verify only):** `LivePage.test.tsx`, `inventory/useInventoryRecapture.test.tsx`, `capture/CaptureForm.test.tsx`, `inventory/StockDateGroupDetail.test.tsx`

- [ ] **Step 1: Run them**

Run: `cd frontend && npx vitest run src/live/LivePage.test.tsx src/inventory/useInventoryRecapture.test.tsx src/capture/CaptureForm.test.tsx src/inventory/StockDateGroupDetail.test.tsx`
Expected: PASS unchanged. These never stubbed EventSource (only mentioned it in comments); `useEventStream`/`useCaptureQueue` now call `ws.ts`'s `open()`, which **no-ops** when `globalThis.WebSocket` is undefined (jsdom). No unhandled rejection (the old `new EventSource` threw inside an un-caught async; `ws.ts` guards with `wsCtor()` returning null).

- [ ] **Step 2: If any fails** because the component now logs a different warning or an unhandled rejection appears, add `installFakeWebSocket()` from `../test/fakeWebSocket` in that file's `beforeEach`. Show the exact diff in the commit. Otherwise no change.

- [ ] **Step 3: Commit (only if a file changed)**

```bash
git add -A frontend/src
git commit -m "test(ws): keep ancillary suites green under WebSocket transport"
```

---

## Task 8: Remove the `sse-starlette` dependency

**Files:** `pyproject.toml`, lockfile

- [ ] **Step 1: Confirm no remaining users**

Run: `grep -rn "sse_starlette\|EventSourceResponse" hoga tests`
Expected: no matches. If any remain, do not remove the dep — stop and report.

- [ ] **Step 2: Remove the dependency** — delete the `"sse-starlette>=3.4.4",` line from `pyproject.toml` `dependencies`.

- [ ] **Step 3: Sync + test**

Run: `uv sync && uv run pytest -q`
Expected: install succeeds without sse-starlette; tests pass.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "chore(ws): drop sse-starlette dependency (no SSE endpoints remain)"
```

---

## Task 9: End-to-end verification (cross-origin WS + multi-tab)

**Files:** none (manual verification with running dev servers)

- [ ] **Step 1: Start both dev servers** per CLAUDE.md (uvicorn `--reload --reload-dir hoga`; `npm run dev`).

- [ ] **Step 2: Confirm the cross-origin WS handshake** (`:5173` page → `:8000` `/api/ws`). Using `/browse`:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/live
$B js "await (async()=>{const ws=new WebSocket('ws://localhost:8000/api/ws');return await new Promise(r=>{ws.onopen=()=>r('open');ws.onerror=()=>r('error');setTimeout(()=>r('timeout'),3000)})})()"
```
Expected: `open`. If `error`, the backend rejected the Origin — add an explicit Origin allowlist to the WS endpoint and re-run.

- [ ] **Step 3: Reproduce the original failure is GONE.** Open 4 `/live` tabs (or, faithfully, hold the equivalent connections) and time the hover orderbook fetch with the harness from the diagnosis:

```bash
$B newtab http://localhost:5173/live   # repeat to 4 tabs
# In any tab, time a real orderbook fetch while all tabs are live:
$B js "await (t0=>fetch('http://localhost:8000/api/orderbook?code=005930&date=20260530&t=0&bucket_ms=60000&source_pref=auto',{cache:'no-store',signal:AbortSignal.timeout(3000)}).then(r=>Math.round(performance.now()-t0)+'ms HTTP'+r.status,e=>Math.round(performance.now()-t0)+'ms '+(e.name||e)))(performance.now())"
```
Expected: fast `…ms HTTP<status>` (NOT `3000ms TimeoutError`) with 4+ tabs open — the HTTP pool is no longer held by SSE.

- [ ] **Step 4: Confirm live ticks now stream** (during market hours, or via a published snapshot): hover/observe that the chart updates without reload (the named-event bug fix). If market is closed, assert via the `liveSeries.test.tsx` `ch:'live'` test added in Task 6.

- [ ] **Step 5: Final full verification**

Run: `uv run pytest -q && cd frontend && npm run build`
Expected: all pass; production build succeeds.

- [ ] **Step 6: Commit (if Step 2 required an Origin allowlist)**

```bash
git add hoga/api/ws.py
git commit -m "fix(ws): explicit Origin allowlist for cross-origin dev handshake"
```

---

## Self-Review

**Spec coverage:**
- §3 WS decision, §4.2 backend endpoint → Tasks 1-3. ✓
- §4.3 `ws.ts` / eventStream / liveSeries → Tasks 4-6. ✓
- §4.1 protocol `{ch,data}` / `{action,code}` → Task 1 (server) + Task 4 (client). ✓
- §5 reconnect → Task 4 (`scheduleReconnect`, onopen resubscribe). ✓
- §6 error handling (disconnect recovery, queue overflow drop, ping) → Task 1 (ping/teardown), Task 5 (disconnect recovery). ✓
- §7 testing (FakeWebSocket, DI) → Tasks 4-7. ✓
- §8 scope/blast radius → matches File Structure. ✓
- §9 hard-cut migration → Tasks 2,3,8 remove SSE wholesale. ✓
- §10 cross-origin WS risk → Task 9 Step 2. ✓
- §11 ADR-0044 invariant preserved → no task touches the hover-spot hooks. ✓
- §12 deferred memos → resolved in header. ✓

**Placeholder scan:** every code step shows full code; no TBD/TODO. ✓

**Type consistency:** `Frame{ch,data}`, `subscribeEvents(SSEEvent)`, `subscribeLive(code, Record<string,unknown>)`, `__resetForTests`, `wsUrl`, `build_event_bus`→3-tuple, `build_ws_router(bus, get_buffer)` — names used identically across backend (Tasks 1-3), client (Task 4), consumers (Tasks 5-6), tests (Tasks 4-7). ✓

**Known follow-ups (out of scope, noted):** `SSEEvent` type name retained (cosmetic); `capture_dismissed` added to the capture filter (Task 5 note).

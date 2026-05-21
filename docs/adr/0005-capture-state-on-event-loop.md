# 0005 — Capture state mutation lives on the event loop

**Status:** accepted (2026-05-21)

## Decision

All mutation of `hoga.api.captures.CaptureJobState` happens on the FastAPI event loop, never on the collector's executor thread. The `on_progress` callback the collector invokes from its worker thread does NOT touch state directly — it hops to the event loop via `asyncio.AbstractEventLoop.call_soon_threadsafe(_apply_progress, state, evt)`. `_apply_progress` is the only function that mutates state in response to collector telemetry, and it runs on the loop alongside the route handlers, the SSE publisher, and `state.to_wire()`.

The same rule applies to anything future code adds: if a new mechanism produces capture state changes from outside the event loop (a watchdog timer, a webhook, a background thread), it routes through `call_soon_threadsafe` (or a future `_apply_*` helper). Lock-based synchronization is rejected.

## Why

`collect_stock_date` is sync (httpx + pyarrow), so the API layer runs it via `loop.run_in_executor`. Its `on_progress` callback therefore fires on the executor's worker thread. Meanwhile, `_run_capture_job` (the coroutine wrapping the executor call) mutates `phase`, `result`, and `error` from the event loop, and `GET /api/captures/latest` reads `state.to_wire()` from the event loop too.

Two threads writing different fields of the same dataclass is a race — small in practice (microsecond windows), but real. The first measurable failure mode would be a `capture_progress` SSE event whose `phase` field reflects a transition the event loop just made *while the callback was already running*, giving consumers an inconsistent snapshot. The second would be `state.to_wire()` reading a half-updated `frontier_hhmmss` + `pages_done` mid-mutation.

The same project already established this exact pattern for a different cross-thread hazard: `hoga/api/sse.py:57` uses `loop.call_soon_threadsafe(bus.publish, evt)` for watchdog observer events. The /plan-eng-review caught the parallel hazard for our capture publishes (F1). This ADR generalizes that single fix into a project-wide rule for capture state: **the event loop is the single mutation thread.**

## Considered alternatives

- **Per-state `threading.Lock` / `RLock`.** Rejected. Every read site (`state.to_wire()`, `is_terminal`, the GET handler, the 409 conflict body, future cancel/dismiss paths) would need to acquire the lock — easy to miss coverage, and a missed read site reintroduces the race silently. Locks also surface as a deadlock surface area whenever a future contributor adds a callback that itself reads state.

- **Immutable state + atomic singleton swap.** Each mutation produces a new frozen `CaptureJobState`; `_latest` is replaced atomically. Rejected as a bigger refactor with little local payoff for a single-user tool. The mutability is contained to one module and one function (`_apply_progress`); we don't get enough leverage from immutability to justify the rewrite.

- **Status quo (no synchronization).** Rejected. The current code passes tests but the race window grows whenever someone adds a new mutation site. Documenting a discipline now is cheap; debugging an intermittent SSE event with a stale phase later is not.

## Consequences worth flagging for future readers

- **The collector thread is purely a producer.** It builds `ProgressEvent` instances and hands them to the callback. It MUST NOT mutate `CaptureJobState` directly — every access to state from the collector side goes through `call_soon_threadsafe`.

- **Tests have a fallback.** When `_loop` is `None` (no `set_bus(bus, loop)` call), the callback applies inline so unit tests of the collector path don't require uvicorn. The fallback exists explicitly for testing; production startup always wires the loop in `hoga/api/app.py::lifespan`.

- **`_publish_event` still hops too.** It's a redundant hop when called from `_apply_progress` (already on the loop), but harmless — `call_soon_threadsafe` from the same loop just schedules a tick later. We keep the hop because `_publish_event` is also called from `_run_capture_job` paths that could in principle be invoked from elsewhere; the hop makes it safe by construction.

- **New cross-thread mechanisms follow the same pattern.** If a future change adds, say, a heartbeat watcher or a retry coordinator that touches state, it hops to the loop. The rule is uniform — no per-callback exceptions.

- **What this does not address.** Mutations from inside the event loop are still unordered with respect to each other if they suspend (`await`). The lock pattern is gone, so two route handlers can interleave at `await` points. The current routes don't have this issue (no `await` between state read and write inside a handler), but future complex flows might. When they appear, prefer `asyncio.Lock` scoped narrowly over reintroducing cross-thread locks.

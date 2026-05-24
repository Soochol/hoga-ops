# `_InventoryHandler` — Pure-Function Extraction, Timing Fix, `_Bus` Tests

**Date**: 2026-05-24
**Status**: Draft
**Type**: backend correctness + testability
**Scope**: [hoga/api/sse.py](../../hoga/api/sse.py) — `_InventoryHandler` and `_Bus`. Plus a new test file.

**Related:**
- [hoga/api/sse.py:38-65](../../hoga/api/sse.py#L38-L65) — current `_InventoryHandler`: emits on directory create/delete only, never on file events.
- [hoga/parser/__init__.py:111,166](../../hoga/parser/__init__.py#L111-L166) — `parse_stock_date` creates `out_dir` FIRST (line 111), writes `meta.json` LAST (line 166). The dir-create-before-meta-write timing gap is what the watchdog `on_created` currently fires into.
- [hoga/api/queries.py:53-90](../../hoga/api/queries.py#L53-L90) — `list_stock_dates` skips dirs without `meta.json` (`try: meta_path.stat().st_mtime_ns except FileNotFoundError: continue`). The list's natural visibility rule is "meta.json exists," not "dir exists."
- [frontend/src/api/sse.ts:78-90](../../frontend/src/api/sse.ts#L78-L90) — frontend invalidates `STOCK_DATES_QUERY_KEY` on `inventory_added` / `inventory_removed`.
- Prior spec [2026-05-24-stock-dates-mtime-cache-design.md](2026-05-24-stock-dates-mtime-cache-design.md) — documented this timing bug as a deferred concern under "Follow-up: SSE Delta Patch."

## Problem

Three issues, all in [hoga/api/sse.py](../../hoga/api/sse.py).

### 1. Latent timing bug — `inventory_added` fires before the row exists

`_InventoryHandler.on_created` fires when watchdog observes a directory created under `parquet/<date>/<code>/`. The capture worker's `parse_stock_date` creates that directory FIRST, then writes parquet files, then writes `meta.json` LAST (over a span of ~10–100 ms for a typical Stock-Date). The frontend receives `inventory_added` immediately, calls `/api/stock-dates`, but `list_stock_dates` silently skips the new dir (no `meta.json` yet). The new row appears only when SOME OTHER invalidation (a different Stock-Date completing, an SSE reconnect) happens to fire after `meta.json` is written.

User-visible: in active capture sessions ("3 capturing · 86 queued"), newly completed Stock-Dates appear in the inventory with a one-cycle lag — they pop in when the *next* capture finishes, not when their own does.

### 2. `_InventoryHandler` filter logic is untested at unit level

The path-relative check, the depth-2 filter (`len(parts) != 2`), the `is_directory` guard, and the `loop is None` short-circuit are all exercised only via `tests/test_api_sse.py::test_sse_inventory_added` — a full uvicorn + inotify integration test that covers exactly one happy path. None of the negative branches (file events, wrong-depth paths, events outside root) have a regression net.

### 3. `_Bus` slow-subscriber drop path is untested

[sse.py:29-36](../../hoga/api/sse.py#L29-L36) — `_Bus.publish` catches `asyncio.QueueFull` and logs a warning. This is the SSE channel's congestion safety net. It is never tested. `subscribe` / `unsubscribe` are also untested.

## Goals

1. Eliminate the dir-create-before-meta-write timing bug so the frontend sees new rows on first invalidation, not the next.
2. Extract the filter / payload-build logic from `_InventoryHandler` into a pure function so the branches are testable without uvicorn or inotify.
3. Cover the `_Bus` invariants (subscribe / publish / unsubscribe / QueueFull drop) with direct unit tests.

All within `hoga/api/sse.py` plus one new test file.

## Non-goals

- **SSE Delta Patch.** Upgrading event payloads to carry the full `StockDate` row so the frontend can `queryClient.setQueryData(...)` instead of refetching is deferred (4–5 files, broader review surface). The prior spec records it.
- **Capture worker rewrite.** `parse_stock_date` continues to create the dir before writing `meta.json`. We adapt the watchdog to the existing write order rather than re-sequencing the writer (which would require atomic-rename plumbing and a wider blast radius).
- **Watchdog observer or `_Bus` restructuring.** Both stay where they are. We add tests and tighten one filter; we don't move the seam.
- **New SSE event types.** The two events (`inventory_added`, `inventory_removed`) keep their names and payload shape. The trigger condition changes; the wire contract does not.

## Design

### Trigger change for `inventory_added`

Move the trigger from "directory created at depth=2" to "**meta.json file created or modified at depth=3**":

| Watchdog event | Path shape | Today | Proposed |
|---|---|---|---|
| `on_created`, is_directory=True | `parquet/<date>/<code>/` | emit `inventory_added` | (no emit) |
| `on_created`, is_directory=False | `parquet/<date>/<code>/meta.json` | (no emit) | emit `inventory_added` |
| `on_modified`, is_directory=False | `parquet/<date>/<code>/meta.json` | (no emit) | emit `inventory_added` |
| `on_deleted`, is_directory=True | `parquet/<date>/<code>/` | emit `inventory_removed` | unchanged |
| any other path / depth | — | (no emit) | (no emit) |

Why this is correct:
- `list_stock_dates` silently skips dirs without `meta.json`, so a dir-without-meta has no inventory presence anyway. There is nothing to refetch for.
- `meta.json` is written LAST by `parse_stock_date` (after all parquet files). When the watchdog sees it appear, every other artifact the row depends on is already on disk. The cache miss → recompute path that the prior spec landed will succeed on the first try.
- Re-captures (overwrite of existing `meta.json`) fire `on_modified`, also emitting `inventory_added`. Semantically the row's stats may have changed; the frontend already treats `inventory_added` as "may be add OR update" (it just calls `invalidateQueries`). No frontend change needed.
- `inventory_removed` keeps its dir-delete trigger because (a) when a dir is removed, `meta.json` was removed with it — no separate file event arrives in a stable ordering; (b) the row's "removed" semantics are tied to the dir's disappearance, not the meta file's.

### Why we don't watch `on_deleted` for `meta.json` files

If `meta.json` is deleted but the dir survives (manual cleanup, partial re-capture preparation), the row disappears from `list_stock_dates` on the next call regardless of any event. Adding a `meta.json` delete trigger would help latency in that narrow case but adds another conditional. Out of scope; the dir-delete path covers the common case (rmtree of the Stock-Date dir).

### Pure-function extraction

Split `_InventoryHandler._maybe_emit` into:

```python
from typing import Literal

WatchdogKind = Literal["created", "modified", "deleted"]


def classify_inventory_event(
    src_path: str,
    parquet_root: Path,
    *,
    is_directory: bool,
    kind: WatchdogKind,
) -> dict | None:
    """Decide whether a watchdog event should produce an inventory_* SSE event,
    and build the payload if so.

    Returns None when the event is irrelevant (wrong path, wrong depth,
    wrong kind/is_directory combination). Returns a payload dict
    {"type": "inventory_added" | "inventory_removed", "code": str, "date": str}
    when the event maps to an inventory change.

    Pure function: no asyncio, no Bus, no I/O. Filesystem state is implicit
    in the inputs.
    """
    p = Path(src_path)
    try:
        rel = p.relative_to(parquet_root)
    except ValueError:
        return None
    parts = rel.parts

    # inventory_removed: dir deletion at depth=2 (parquet/<date>/<code>/).
    if kind == "deleted" and is_directory and len(parts) == 2:
        date, code = parts
        return {"type": "inventory_removed", "code": code, "date": date}

    # inventory_added: meta.json create or modify at depth=3.
    if kind in ("created", "modified") and not is_directory and len(parts) == 3:
        date, code, fname = parts
        if fname == "meta.json":
            return {"type": "inventory_added", "code": code, "date": date}

    return None
```

`_InventoryHandler` reduces to a thin watchdog adapter:

```python
class _InventoryHandler(FileSystemEventHandler):
    def __init__(
        self,
        bus: _Bus,
        parquet_root: Path,
        loop: asyncio.AbstractEventLoop | None,
    ) -> None:
        self.bus = bus
        self.root = parquet_root
        self.loop = loop

    def _dispatch(self, src_path: str, *, is_directory: bool, kind: WatchdogKind) -> None:
        if self.loop is None:
            return
        payload = classify_inventory_event(
            src_path, self.root, is_directory=is_directory, kind=kind
        )
        if payload is None:
            return
        self.loop.call_soon_threadsafe(self.bus.publish, payload)

    def on_created(self, event):
        self._dispatch(event.src_path, is_directory=event.is_directory, kind="created")

    def on_modified(self, event):
        self._dispatch(event.src_path, is_directory=event.is_directory, kind="modified")

    def on_deleted(self, event):
        self._dispatch(event.src_path, is_directory=event.is_directory, kind="deleted")
```

The handler now has three small methods that all delegate to one private `_dispatch` and the pure `classify_inventory_event`. Every branch of the filter logic is testable without touching the filesystem or asyncio.

### `_Bus` interface and tests

`_Bus` does not change structurally. The class is small (~20 lines), single-responsibility (pub-sub with bounded queues), and correctly extracted. We add direct unit tests covering:

- `subscribe()` returns a `Queue` with the documented `maxsize=64`
- `publish(evt)` puts the event in every subscribed queue
- `unsubscribe(q)` removes the queue; subsequent `publish` does not put into it
- `unsubscribe(q)` is idempotent (`discard` semantics — calling twice does not raise)
- `publish` on a `Queue(maxsize=1)` already containing one event logs a warning at `WARNING` level and does **not** raise or block

No threading involved in these tests — `asyncio.Queue` is single-loop and we exercise it in a synchronous test by sizing the queue so the synchronous `put_nowait` reaches `QueueFull` without yielding.

### Error handling

Three classes of failure:
- **Watchdog event with a path outside `parquet_root`**: `classify_inventory_event` returns `None` (existing behavior). No emit.
- **`loop is None`**: `_dispatch` short-circuits (existing behavior). Pre-startup events are dropped silently — same as today.
- **`bus.publish` raises**: would crash the watchdog observer thread. Today's code does not guard; we do not add a guard. The bus's only documented exception path (`QueueFull`) is caught inside `_Bus.publish` already.

### Testing matrix

New file `tests/test_api_sse_inventory.py` (sibling of the existing `tests/test_api_sse.py` which is the integration test). Contents:

**Pure-function tests** (parameterized via `pytest.mark.parametrize`):

| Input (src_path relative to root) | is_directory | kind | Expected output |
|---|---|---|---|
| `20260524/003490/meta.json` | False | `created` | `{type: inventory_added, code: 003490, date: 20260524}` |
| `20260524/003490/meta.json` | False | `modified` | `{type: inventory_added, code: 003490, date: 20260524}` |
| `20260524/003490/meta.json` | False | `deleted` | `None` |
| `20260524/003490/trades.parquet` | False | `created` | `None` |
| `20260524/003490/` | True | `created` | `None` (no longer triggers) |
| `20260524/003490/` | True | `deleted` | `{type: inventory_removed, code: 003490, date: 20260524}` |
| `20260524/` | True | `deleted` | `None` (wrong depth) |
| `20260524/003490/subdir/meta.json` | False | `created` | `None` (wrong depth) |
| `<absolute path outside root>` | True | `created` | `None` |

**`_Bus` tests:**

- `test_bus_publish_fans_to_all_subscribers`
- `test_bus_unsubscribe_stops_delivery`
- `test_bus_unsubscribe_idempotent`
- `test_bus_publish_drops_with_warning_when_queue_full` (uses `caplog`; covers the maxsize behavior end-to-end without asserting on the constant directly)

**`_InventoryHandler` thin-adapter test** (no inotify, just synthetic watchdog events): construct a handler with a real loop reference, feed it a fake `FileCreatedEvent` whose `src_path` and `is_directory` are set, assert `bus.publish` was called with the expected payload.

**Path construction in test data:** parameterized inputs must build `src_path` from a real `Path` (e.g., `str(parquet_root / "20260524" / "003490" / "meta.json")`), not by string-concatenating with `/`. Watchdog emits paths in the OS-native separator; the production filter survives mixed separators because `Path.relative_to` normalizes, and the tests should exercise that same normalization rather than hard-coding POSIX slashes.

### Backwards compatibility

Watching `on_modified` brings a new source of events: every parquet file write under `parquet/<date>/<code>/` will fire `on_modified` repeatedly during a single capture's parquet-write phase. The `classify_inventory_event` filter rejects all of them (not `meta.json`), so the cost is purely watchdog-handler invocations — no SSE traffic. Acceptable.

`test_api_sse.py::test_sse_inventory_added` currently asserts `inventory_added` fires on a dir create. **This test must be updated** to instead `Path.touch()` a `meta.json` file under a pre-created dir, or equivalently use `parse_stock_date` to drive the full write sequence. This is the only existing test whose contract changes. (The `inventory_removed` test is unaffected.)

### Memory & throughput

Same as today. Three watchdog method dispatches instead of two, with the third (`on_modified`) firing more often. The pure function returns `None` quickly for non-`meta.json` files, and the GIL-bound work is sub-microsecond. The `_Bus` queues remain capped at 64.

## Out of scope (recorded for future)

### SSE Delta Patch

Still deferred. Upgrading `inventory_added` payloads to carry the full `StockDate` row would let the frontend skip the refetch entirely. Estimated 4–5 file change spanning `captures.py`, `queries.py`, `sse.py`, frontend `sse.ts`, `types.ts`. After this spec lands, the timing bug is fixed without that work — the delta patch becomes a pure performance optimization, not a correctness fix.

### `meta.json` file-delete trigger

If a `meta.json` is removed without removing its containing dir (a partial-cleanup scenario), the row remains in `list_stock_dates`'s output until the next invalidation. Adding an `on_deleted` branch for `meta.json` files would close this latency gap. Out of scope at current usage patterns (no observed manual-cleanup workflow that targets `meta.json` specifically).

## Risks

- **Test fixture drift.** `test_api_sse.py::test_sse_inventory_added` must be updated in this PR (not left for a follow-up). Forgetting it would leave one test asserting the old contract and one asserting the new — confusing future maintainers.
- **Watchdog event ordering on Linux inotify.** On most filesystems, `parse_stock_date`'s sequence (parquet writes → `meta.json` write) produces one `on_modified` per parquet plus one `on_created` for `meta.json`, in order. We rely on `meta.json`'s create event arriving *after* the parquet writes complete on disk. The kernel's inotify buffer can theoretically reorder under extreme load, but `parse_stock_date` is a single-threaded sequential writer and the time gap between writes is wide (10s of ms); reordering would require pathological scheduler pressure.
- **Re-capture overwrite semantics.** When `parse_stock_date` overwrites an existing `meta.json`, the OS may produce just an `on_modified` (atomic-ish overwrite via `write_text`) or both `on_deleted` + `on_created` (some filesystems / editors). Both `on_modified` and `on_created` map to `inventory_added` in our filter, so either kernel behavior produces the right SSE event. The `on_deleted` for the file is filtered out (not depth=2, not is_directory).

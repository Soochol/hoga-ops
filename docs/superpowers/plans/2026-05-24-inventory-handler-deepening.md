# `_InventoryHandler` Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `_InventoryHandler`'s dir-create trigger with a meta.json-file trigger so `inventory_added` fires after the row is actually visible to `list_stock_dates`, extract the filter logic as a pure function for testability, and add direct unit tests for `_Bus`.

**Architecture:** Single-file change to [hoga/api/sse.py](../../hoga/api/sse.py): introduce `classify_inventory_event` as a pure path-filter function, refactor `_InventoryHandler` into a thin watchdog-to-function adapter that also subscribes to `on_modified`. The wire contract (event names, payload shape, `_Bus` interface) is unchanged; only the trigger condition shifts from dir-create to meta.json-file create-or-modify.

**Tech Stack:** Python 3.11, FastAPI, watchdog FileSystemEventHandler, asyncio.Queue-backed pub-sub, pytest + caplog for warning assertions.

**Spec:** [docs/superpowers/specs/2026-05-24-inventory-handler-deepening-design.md](../specs/2026-05-24-inventory-handler-deepening-design.md)

---

## File Structure

**Modified (single production source):**
- `hoga/api/sse.py` — add `WatchdogKind` Literal and `classify_inventory_event` pure function; refactor `_InventoryHandler` into a three-method adapter (`on_created`, `on_modified`, `on_deleted`) that all delegate through a private `_dispatch`.

**Created (new test file):**
- `tests/test_api_sse_inventory.py` — owns the pure-function parameterized tests, the `_Bus` behavioral tests, and the synthetic-event handler adapter test. Kept separate from the existing `tests/test_api_sse.py` (which is the live-uvicorn integration test) because the new tests are purely in-process and have a different fixture surface.

**Modified (existing test must adapt to the new trigger contract):**
- `tests/test_api_sse.py` — `test_sse_inventory_added` currently triggers the event by `mkdir`-ing a Stock-Date dir. After Task 2 the trigger is meta.json create/modify, so the test must write a `meta.json` file inside the dir.

**Unchanged:** everything else — `_Bus` keeps its current shape; `app.py`, `routes.py`, `queries.py`, the frontend SSE handler all see the same wire contract.

---

## Pre-flight

Capture the baseline before Task 1:

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend4
uv run pytest -q
```

Expected: `1 failed, 468 passed`. The single failure is the pre-existing `test_e2e_completeness::test_collect_then_parse_then_query_marks_complete` — unrelated, do not investigate. If any other failure appears, stop and report to the user before continuing.

Capture the starting commit SHA: `git rev-parse HEAD`. Tasks 1–4 must commit on top of it.

---

## Task 1: Add `classify_inventory_event` pure function (TDD, additive)

**Files:**
- Create: `tests/test_api_sse_inventory.py`
- Modify: `hoga/api/sse.py` — add the `WatchdogKind` Literal and the `classify_inventory_event` function. Do NOT modify `_InventoryHandler` yet; that's Task 2.

**Rationale:** Land the pure function first so it can be tested exhaustively without touching the live watchdog path. Until Task 2 wires it in, `_InventoryHandler` continues using its current inline logic — no behavior change in this task.

- [ ] **Step 1: Create the test file with the parameterized pure-function tests**

Create `tests/test_api_sse_inventory.py`:

```python
"""Pure-function and behavioral tests for the inventory SSE pipeline.

Separate from test_api_sse.py (the live uvicorn integration test) because
these tests are purely in-process — no inotify, no asyncio loop, no
network. The pure function and _Bus are unit-testable without fixtures.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api.sse import classify_inventory_event


@pytest.fixture
def parquet_root(tmp_path: Path) -> Path:
    root = tmp_path / "parquet"
    root.mkdir()
    return root


# All test paths are built via Path operations (not string concatenation
# with "/") so the test exercises the same normalisation that production
# watchdog paths go through on whatever OS the test runs on.
@pytest.mark.parametrize(
    "build_relative, is_directory, kind, expected",
    [
        # inventory_added: meta.json file create/modify at depth=3
        (
            ("20260524", "003490", "meta.json"), False, "created",
            {"type": "inventory_added", "code": "003490", "date": "20260524"},
        ),
        (
            ("20260524", "003490", "meta.json"), False, "modified",
            {"type": "inventory_added", "code": "003490", "date": "20260524"},
        ),
        # meta.json deletion is NOT an inventory_removed signal (dir-delete
        # is). The function returns None so the watchdog event is silently
        # filtered.
        (("20260524", "003490", "meta.json"), False, "deleted", None),
        # Non-meta.json file at the right depth: ignored.
        (("20260524", "003490", "trades.parquet"), False, "created", None),
        # Dir create at depth=2: no longer triggers inventory_added under
        # the new contract — meta.json doesn't exist yet at this moment.
        (("20260524", "003490"), True, "created", None),
        # Dir delete at depth=2: inventory_removed.
        (
            ("20260524", "003490"), True, "deleted",
            {"type": "inventory_removed", "code": "003490", "date": "20260524"},
        ),
        # Wrong depths.
        (("20260524",), True, "deleted", None),
        (("20260524", "003490", "subdir", "meta.json"), False, "created", None),
    ],
)
def test_classify_inventory_event(
    parquet_root: Path,
    build_relative: tuple[str, ...],
    is_directory: bool,
    kind: str,
    expected: dict | None,
) -> None:
    src_path = str(parquet_root.joinpath(*build_relative))
    result = classify_inventory_event(
        src_path, parquet_root, is_directory=is_directory, kind=kind
    )
    assert result == expected


def test_classify_inventory_event_rejects_path_outside_root(
    parquet_root: Path, tmp_path: Path,
) -> None:
    """A watchdog event for a path outside parquet_root returns None.

    Defensive: the observer is scheduled on parquet_root, so this
    shouldn't happen in production, but the function must not crash
    or misclassify if it does.
    """
    outside = tmp_path / "elsewhere" / "20260524" / "003490" / "meta.json"
    result = classify_inventory_event(
        str(outside), parquet_root, is_directory=False, kind="created",
    )
    assert result is None
```

- [ ] **Step 2: Run the tests — expect collection error**

```bash
uv run pytest tests/test_api_sse_inventory.py -v
```

Expected: ImportError / collection error — `classify_inventory_event` is not yet defined in `hoga/api/sse.py`.

- [ ] **Step 3: Add `WatchdogKind` Literal and `classify_inventory_event` to sse.py**

Open `hoga/api/sse.py`. The existing imports at the top look like:

```python
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer
```

Add `Literal` to the typing imports (or add `from typing import Literal` if not present):

```python
from typing import Literal
```

After the imports and before `class _Bus:`, add:

```python
WatchdogKind = Literal["created", "modified", "deleted"]


def classify_inventory_event(
    src_path: str,
    parquet_root: Path,
    *,
    is_directory: bool,
    kind: WatchdogKind,
) -> dict | None:
    """Decide whether a watchdog filesystem event should produce an
    inventory_* SSE event, and build the payload if so.

    Returns None when the event is irrelevant (wrong path, wrong depth,
    or wrong kind/is_directory combination). Returns a payload dict
    when the event maps to a visible inventory change.

    Pure function: no asyncio, no Bus, no I/O. Filesystem state is
    implicit in the inputs.

    Rules:
      - ``inventory_removed`` fires on directory deletion at depth=2
        (``parquet/<date>/<code>/``). When the dir vanishes, the row
        vanishes from ``list_stock_dates``.
      - ``inventory_added`` fires on ``meta.json`` create OR modify at
        depth=3 (``parquet/<date>/<code>/meta.json``). The capture
        worker writes ``meta.json`` LAST, so its appearance is when
        ``list_stock_dates`` first sees the row; re-captures overwrite
        the file, firing ``on_modified`` — also a refresh signal.
      - Everything else returns ``None``.
    """
    p = Path(src_path)
    try:
        rel = p.relative_to(parquet_root)
    except ValueError:
        return None
    parts = rel.parts

    if kind == "deleted" and is_directory and len(parts) == 2:
        date, code = parts
        return {"type": "inventory_removed", "code": code, "date": date}

    if kind in ("created", "modified") and not is_directory and len(parts) == 3:
        date, code, fname = parts
        if fname == "meta.json":
            return {"type": "inventory_added", "code": code, "date": date}

    return None
```

- [ ] **Step 4: Run the tests — expect PASS**

```bash
uv run pytest tests/test_api_sse_inventory.py -v
```

Expected: 9 parameterized cases + 1 outside-root test all pass.

- [ ] **Step 5: Run the full suite for regressions**

```bash
uv run pytest -q
```

Expected: 1 pre-existing failure, all others pass (the count should grow by 10 from the baseline).

- [ ] **Step 6: Commit**

```bash
git add hoga/api/sse.py tests/test_api_sse_inventory.py
git commit -m "feat(sse): add classify_inventory_event pure function for inventory filter

Extracts the (path, is_directory, kind) → inventory event decision
into a pure function so every branch is testable without uvicorn or
inotify. Production handler is untouched; Task 2 wires it in and
shifts the trigger to meta.json events."
```

---

## Task 2: Refactor `_InventoryHandler` + update integration test (TRIGGER CHANGE)

**Files:**
- Modify: `hoga/api/sse.py` — replace `_InventoryHandler._maybe_emit` + `on_created` + `on_deleted` with the three-method adapter that delegates through `_dispatch` to `classify_inventory_event`. Add `on_modified` handler.
- Modify: `tests/test_api_sse_inventory.py` — add the synthetic-event handler adapter test.
- Modify: `tests/test_api_sse.py` — update `test_sse_inventory_added` to write `meta.json` instead of just creating the dir.

**Rationale:** This is the behavior change. The trigger shifts from dir-create-at-depth-2 to meta.json-create-or-modify-at-depth-3. The existing integration test will fail until updated because it relies on the old contract.

- [ ] **Step 1: Update `test_sse_inventory_added` to write a `meta.json` file**

Open `tests/test_api_sse.py`. Replace the `make_dir` inner coroutine in `test_sse_inventory_added` with a `make_meta_json` version. The current code at lines 49–54:

```python
                async def make_dir():
                    # Give watchdog inotify warmup a beat after server start.
                    await asyncio.sleep(0.5)
                    (data_dir / "parquet" / "20260521" / "207940").mkdir(parents=True)

                asyncio.create_task(make_dir())
```

becomes:

```python
                async def make_meta_json():
                    # Give watchdog inotify warmup a beat after server start.
                    await asyncio.sleep(0.5)
                    code_dir = data_dir / "parquet" / "20260521" / "207940"
                    code_dir.mkdir(parents=True)
                    # Per the _InventoryHandler design: dir-create no longer
                    # fires inventory_added. The event fires when meta.json
                    # appears, since that is when list_stock_dates first
                    # sees the row.
                    (code_dir / "meta.json").write_text("{}", encoding="utf-8")

                asyncio.create_task(make_meta_json())
```

Also update the module docstring on line 1:

```python
"""SSE inventory_added event fires when a new Stock-Date directory appears.
```

becomes:

```python
"""SSE inventory_added event fires when a Stock-Date's meta.json appears.
```

- [ ] **Step 2: Add the synthetic-event handler adapter test**

Append to `tests/test_api_sse_inventory.py`:

```python
import asyncio
from unittest.mock import MagicMock

from hoga.api.sse import _Bus, _InventoryHandler


class _FakeEvent:
    """Stand-in for watchdog FileSystemEvent — only the attributes our
    handler reads (src_path, is_directory)."""

    def __init__(self, src_path: str, is_directory: bool) -> None:
        self.src_path = src_path
        self.is_directory = is_directory


@pytest.mark.asyncio
async def test_inventory_handler_dispatches_meta_create_to_bus(
    parquet_root: Path,
) -> None:
    """A meta.json file_created event reaches bus.publish with the right payload."""
    bus = _Bus()
    loop = asyncio.get_running_loop()
    handler = _InventoryHandler(bus, parquet_root, loop=loop)
    # Spy on the bus
    bus.publish = MagicMock(wraps=bus.publish)  # type: ignore[method-assign]

    meta_path = parquet_root / "20260524" / "003490" / "meta.json"
    handler.on_created(_FakeEvent(str(meta_path), is_directory=False))

    # _dispatch hops to the event loop via call_soon_threadsafe — yield
    # once so the scheduled publish runs.
    await asyncio.sleep(0)

    bus.publish.assert_called_once_with(
        {"type": "inventory_added", "code": "003490", "date": "20260524"},
    )


@pytest.mark.asyncio
async def test_inventory_handler_short_circuits_when_loop_none(
    parquet_root: Path,
) -> None:
    """Pre-startup events (loop=None) are silently dropped."""
    bus = _Bus()
    handler = _InventoryHandler(bus, parquet_root, loop=None)
    bus.publish = MagicMock(wraps=bus.publish)  # type: ignore[method-assign]

    meta_path = parquet_root / "20260524" / "003490" / "meta.json"
    handler.on_created(_FakeEvent(str(meta_path), is_directory=False))

    bus.publish.assert_not_called()
```

- [ ] **Step 3: Run new tests + the existing integration test — expect FAIL**

```bash
uv run pytest tests/test_api_sse_inventory.py tests/test_api_sse.py -v
```

Expected:
- `test_inventory_handler_dispatches_meta_create_to_bus` FAILS (current handler ignores file events; `bus.publish` not called)
- `test_inventory_handler_short_circuits_when_loop_none` may pass coincidentally (`loop=None` short-circuit exists today)
- `test_sse_inventory_added` (updated) FAILS because the current handler fires on dir create, not on meta.json create — *but* the test now also creates the dir, which fires the old event, which the test sees. So this test might actually still pass. Capture the actual outcome to inform Step 4.

If `test_sse_inventory_added` still passes at this point: it means the current handler's dir-create path is what's catching it. After Task 2's refactor that path disappears, and the test only succeeds via the new meta.json path. Either way, the new contract is enforced after Step 4.

- [ ] **Step 4: Refactor `_InventoryHandler`**

Replace the current `_InventoryHandler` class body in `hoga/api/sse.py` (currently lines 38–65 — the four methods `__init__`, `_maybe_emit`, `on_created`, `on_deleted`) with:

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

    def _dispatch(
        self, src_path: str, *, is_directory: bool, kind: WatchdogKind,
    ) -> None:
        if self.loop is None:
            return
        payload = classify_inventory_event(
            src_path, self.root, is_directory=is_directory, kind=kind,
        )
        if payload is None:
            return
        self.loop.call_soon_threadsafe(self.bus.publish, payload)

    def on_created(self, event):
        self._dispatch(
            event.src_path, is_directory=event.is_directory, kind="created",
        )

    def on_modified(self, event):
        self._dispatch(
            event.src_path, is_directory=event.is_directory, kind="modified",
        )

    def on_deleted(self, event):
        self._dispatch(
            event.src_path, is_directory=event.is_directory, kind="deleted",
        )
```

- [ ] **Step 5: Run the affected tests — expect PASS**

```bash
uv run pytest tests/test_api_sse_inventory.py tests/test_api_sse.py -v
```

Expected: all tests pass — the handler adapter unit tests, the existing integration test (now triggered by the meta.json write), and the pure-function tests from Task 1.

- [ ] **Step 6: Run the full suite for regressions**

```bash
uv run pytest -q
```

Expected: same 1 pre-existing failure as baseline, all others pass. Pay particular attention to tests touching SSE or captures — if any new failures appear, the trigger change has broken an assumption somewhere.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/sse.py tests/test_api_sse.py tests/test_api_sse_inventory.py
git commit -m "fix(sse): trigger inventory_added on meta.json, not dir create

The capture worker creates the Stock-Date dir FIRST and writes
meta.json LAST. The old handler emitted inventory_added on dir
create, before list_stock_dates would see the row — the frontend
refetched and got nothing, then had to wait for an unrelated
invalidation to pick up the new row.

The new handler watches meta.json file create/modify at depth=3.
inventory_removed keeps its dir-delete trigger (when the dir
disappears, the row disappears).

Also adds the synthetic-event handler adapter test and updates the
existing test_sse_inventory_added integration test to write meta.json
instead of only creating the dir."
```

---

## Task 3: Add `_Bus` behavioral tests (additive)

**Files:**
- Modify: `tests/test_api_sse_inventory.py` — append `_Bus` tests.

**Rationale:** The slow-subscriber `QueueFull` drop path is documented in `_Bus.publish` and entirely untested. Subscribe / publish / unsubscribe likewise have zero direct coverage. None of these tests require asyncio fixtures beyond the basic `pytest.mark.asyncio` because `asyncio.Queue.put_nowait` is synchronous from the caller's perspective.

- [ ] **Step 1: Append the `_Bus` tests to `tests/test_api_sse_inventory.py`**

```python
import logging


@pytest.mark.asyncio
async def test_bus_publish_fans_to_all_subscribers() -> None:
    bus = _Bus()
    q1 = bus.subscribe()
    q2 = bus.subscribe()

    bus.publish({"type": "heartbeat"})

    assert q1.get_nowait() == {"type": "heartbeat"}
    assert q2.get_nowait() == {"type": "heartbeat"}


@pytest.mark.asyncio
async def test_bus_unsubscribe_stops_delivery() -> None:
    bus = _Bus()
    q1 = bus.subscribe()
    q2 = bus.subscribe()
    bus.unsubscribe(q1)

    bus.publish({"type": "heartbeat"})

    # q1 was unsubscribed — its queue must stay empty.
    with pytest.raises(asyncio.QueueEmpty):
        q1.get_nowait()
    # q2 still subscribed — receives the event.
    assert q2.get_nowait() == {"type": "heartbeat"}


@pytest.mark.asyncio
async def test_bus_unsubscribe_idempotent() -> None:
    """Calling unsubscribe twice on the same queue must not raise.

    _Bus uses set.discard internally, which is the no-raise contract
    the caller relies on (the SSE stream's finally-block always calls
    unsubscribe, even if the client disconnected before subscribe
    completed in some error paths).
    """
    bus = _Bus()
    q = bus.subscribe()
    bus.unsubscribe(q)
    bus.unsubscribe(q)  # must not raise


@pytest.mark.asyncio
async def test_bus_publish_drops_with_warning_when_queue_full(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When a subscriber's queue is full, publish logs a warning and
    does NOT raise. This protects fast publishers from one slow client."""
    bus = _Bus()
    q = bus.subscribe()
    # Saturate the queue (maxsize=64 per the bus implementation) so the
    # next publish hits QueueFull. Use put_nowait to avoid await yield
    # semantics affecting the test.
    while not q.full():
        q.put_nowait({"type": "filler"})

    with caplog.at_level(logging.WARNING, logger="hoga.api.sse"):
        bus.publish({"type": "heartbeat"})

    assert any(
        "SSE queue full" in rec.message for rec in caplog.records
    ), f"expected QueueFull warning in caplog records: {[r.message for r in caplog.records]}"
```

- [ ] **Step 2: Run the new tests — expect PASS**

```bash
uv run pytest tests/test_api_sse_inventory.py -v -k bus
```

Expected: 4 bus tests pass. If `test_bus_publish_drops_with_warning_when_queue_full` fails on the caplog assertion, check the logger name used in `_Bus.publish` (currently `logger = logging.getLogger(__name__)` which resolves to `hoga.api.sse`).

- [ ] **Step 3: Run the full suite**

```bash
uv run pytest -q
```

Expected: pre-existing failure only; new test count higher than baseline.

- [ ] **Step 4: Commit**

```bash
git add tests/test_api_sse_inventory.py
git commit -m "test(sse): direct unit tests for _Bus pub-sub + QueueFull drop path

Covers the four invariants the existing live-uvicorn integration test
never exercises: publish fans to all subscribers, unsubscribe stops
delivery, unsubscribe is idempotent (the SSE stream's finally-block
needs this), and a saturated subscriber gets dropped with a warning
instead of blocking the publisher."
```

---

## Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

```bash
uv run pytest -q
```

Expected: 1 pre-existing failure, all others pass. Test count should be the baseline + new tests from Tasks 1–3 (10 + 2 + 4 = 16 new tests).

- [ ] **Step 2: Stability check (3 runs of the SSE tests)**

```bash
for i in 1 2 3; do
  uv run pytest tests/test_api_sse_inventory.py tests/test_api_sse.py -v || break
done
```

Expected: all tests pass in all three runs. The integration test (`test_sse_inventory_added`) uses real inotify and has a 500 ms warmup sleep — if it flakes, the warmup may need adjustment, but that's a pre-existing concern not introduced by this plan.

- [ ] **Step 3: Manual smoke against a live backend**

In one terminal, start a fresh backend (kill any running one first):

```bash
pkill -f "uvicorn hoga" 2>/dev/null; sleep 1
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

In another terminal, open the SSE stream and watch for events:

```bash
curl -N http://127.0.0.1:8000/api/events &
SSE_PID=$!

# Set up a fresh Stock-Date dir + meta.json (simulating a capture completion)
TEST_DIR="$HOME/.local/share/hoga-ops/data/parquet/19000101/000001"
mkdir -p "$TEST_DIR"

# Trigger the NEW path: writing meta.json should fire inventory_added.
echo '{"name":"test"}' > "$TEST_DIR/meta.json"

# Wait briefly and clean up
sleep 1
rm -rf "$HOME/.local/share/hoga-ops/data/parquet/19000101"
sleep 1
kill $SSE_PID
```

Expected SSE output (between connection messages):
- `event: inventory_added` with `data: {"code":"000001","date":"19000101"}`
- `event: inventory_removed` with `data: {"code":"000001","date":"19000101"}` (after rmtree)

If only `inventory_removed` shows or `inventory_added` fires on the `mkdir` BEFORE the meta.json write, the refactor has not actually landed — check that `_InventoryHandler.on_created` no longer fires for directory events at depth=2.

- [ ] **Step 4: Stop here if anything red**

If the smoke test shows `inventory_added` on `mkdir` (not the meta.json write), the trigger change didn't take effect. Likely causes:
- The old `_maybe_emit` method was left in place alongside the new `_dispatch` (search `_maybe_emit` in `hoga/api/sse.py` — should return zero hits).
- `classify_inventory_event` was wired but its dir-create branch wasn't removed (re-read Task 1 Step 3 — there is no dir-create-fires-inventory_added branch in the function).
- The hot-reloaded uvicorn didn't pick up the change. Kill and restart cold.

---

## Self-Review

**Spec coverage:**
- Spec §"Trigger change for inventory_added" → Task 1 (pure fn) + Task 2 (wire-up). ✓
- Spec §"Pure-function extraction" → Task 1. ✓
- Spec §"`_Bus` interface and tests" → Task 3. ✓
- Spec §"Backwards compatibility" — `test_api_sse.py` update mandated → Task 2 Step 1. ✓
- Spec testing matrix (9 parameterized cases) → Task 1 Step 1 (all 9 + the outside-root case). ✓
- Spec `_Bus` test list (4 behavioral) → Task 3 Step 1 (all 4). ✓
- Spec handler-adapter test → Task 2 Step 2 (dispatches-to-bus + loop-none short-circuit). ✓
- Spec mandated `WatchdogKind = Literal[...]` → Task 1 Step 3. ✓
- Spec mandated Path-based test data → Task 1 Step 1 uses `parquet_root.joinpath(*build_relative)` rather than string concat. ✓
- Spec non-goal — no SSE delta patch, no capture-worker rewrite, no event-name changes → none of the tasks introduce any of these. ✓

**Placeholder scan:** none — every code block has full text.

**Type consistency:**
- `WatchdogKind = Literal["created", "modified", "deleted"]` defined in Task 1 Step 3, used in Task 2 Step 4 `_dispatch` signature. ✓
- `classify_inventory_event(src_path, parquet_root, *, is_directory, kind)` signature identical in Task 1 Step 3 (definition), Task 1 Step 1 (test calls), and Task 2 Step 4 (handler delegate call). ✓
- Payload dict shape `{"type": ..., "code": ..., "date": ...}` consistent across Task 1's tests, Task 2's handler test, and the production handler call site. ✓

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks. The user pre-selected this path (auto-progress chain).
2. **Inline Execution** — `superpowers:executing-plans`, batch with checkpoints.

Auto-decision: **subagent-driven-development**.

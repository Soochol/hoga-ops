# Retry Failed (bulk + in-place replacement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the duplicate-row confusion when retrying failed capture items, and add a one-click "Retry Failed" bulk action. Track each item's attempt count.

**Architecture:** New backend endpoint `POST /api/captures/items/retry` (per [ADR-0031](../../adr/0031-capture-retry-endpoint-split.md)) replaces the failed row in `_done` with a fresh enqueued `QueueItemState` carrying `attempt = prior + 1`. Emits a new `capture_dismissed` SSE event so the frontend drops the old row before the new one appears. Single-row ↻ and the new header button both call the same endpoint.

**Tech Stack:** FastAPI + pydantic v2 (backend), TanStack Query + Vitest + Testing Library (frontend), pytest-asyncio (mode auto).

**References:** [spec](../specs/2026-05-25-retry-failed-bulk-design.md), [ADR-0031](../../adr/0031-capture-retry-endpoint-split.md), [ADR-0019](../../adr/0019-capture-queue-manifest-persistence.md), CONTEXT.md "Retry" term.

---

## Task 1: Add `attempt` field to backend wire + state + manifest models

**Files:**
- Modify: `hoga/api/models.py:152-167` (QueueItem), `hoga/api/models.py:243-256` (QueueManifestItem)
- Modify: `hoga/api/captures.py:88-148` (QueueItemState dataclass + to_wire)
- Test: `tests/test_models.py` (append new test fns)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_models.py`:

```python
def test_queue_item_attempt_defaults_to_1():
    from hoga.api.models import QueueItem
    item = QueueItem(
        item_id="x", code="005930", date="20260520",
        phase="queued", force_retry=False, pause_origin=False,
        enqueued_at_ms=1,
    )
    assert item.attempt == 1


def test_queue_item_attempt_accepts_explicit_value():
    from hoga.api.models import QueueItem
    item = QueueItem(
        item_id="x", code="005930", date="20260520",
        phase="queued", force_retry=False, pause_origin=False,
        enqueued_at_ms=1, attempt=3,
    )
    assert item.attempt == 3


def test_queue_manifest_item_attempt_defaults_to_1():
    """ADR-0031 manifest backward-compat: pre-existing manifest entries
    without `attempt` field must load with attempt=1, no version bump."""
    from hoga.api.models import QueueManifestItem
    legacy_json = (
        '{"item_id":"x","code":"005930","date":"20260520",'
        '"force_retry":false,"enqueued_at_ms":1,"pause_origin":false}'
    )
    item = QueueManifestItem.model_validate_json(legacy_json)
    assert item.attempt == 1
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_models.py::test_queue_item_attempt_defaults_to_1 \
  tests/test_models.py::test_queue_item_attempt_accepts_explicit_value \
  tests/test_models.py::test_queue_manifest_item_attempt_defaults_to_1 -v
```

Expected: 3 FAIL with `AttributeError` or pydantic ValidationError about unknown field.

- [ ] **Step 3: Add `attempt` to QueueItem and QueueManifestItem**

In `hoga/api/models.py`, locate the `QueueItem` class (around line 152) and append the field after `skip_reason`:

```python
class QueueItem(BaseModel):
    """Wire model for one item in the capture queue. Mirrors backend state."""

    item_id: str
    code: str
    date: str
    phase: CapturePhase
    force_retry: bool          # frozen at enqueue per spec §11 Q16
    pause_origin: bool         # True when cancelled by cookie-expired pool pause
    enqueued_at_ms: int
    started_at_ms: int | None = None
    progress: CaptureProgress | None = None
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None
    attempt: int = 1           # 1 = first try; Retry-enqueued items carry prior + 1 (ADR-0031)
```

Locate `QueueManifestItem` (around line 243) and append `attempt`:

```python
class QueueManifestItem(BaseModel):
    """On-disk representation of one queue item. Persistence-only — never
    returned by API endpoints. Fields are the minimum needed to reconstruct
    a QueueItemState on restart: phase is always 'queued' on restore (see
    spec §4.2 and ADR-0019).
    """

    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    pause_origin: bool
    attempt: int = 1           # ADR-0031: additive, schema_version unchanged
```

- [ ] **Step 4: Add `attempt` to QueueItemState and to_wire**

In `hoga/api/captures.py`, locate `QueueItemState` (line 88) and add the field plus pass it through in `to_wire`:

```python
@dataclass
class QueueItemState:
    """Mutable server-side state for one queue item. Not a Wire Model."""
    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    phase: CapturePhase = "queued"
    pause_origin: bool = False
    started_at_ms: int | None = None
    pages_done: int = 0
    events_seen: int = 0
    frontier: HogaMs = HogaMs(0)
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None
    cancel_token: Any = None
    attempt: int = 1
```

In the same class, locate `to_wire` (around line 128) and add `attempt` to the constructor call:

```python
    def to_wire(self):
        from hoga.api.models import QueueItem
        return QueueItem(
            item_id=self.item_id,
            code=self.code,
            date=self.date,
            phase=self.phase,
            force_retry=self.force_retry,
            pause_origin=self.pause_origin,
            enqueued_at_ms=self.enqueued_at_ms,
            started_at_ms=self.started_at_ms,
            progress=self.to_progress(),
            result=self.result,
            error=self.error,
            skip_reason=self.skip_reason,
            attempt=self.attempt,
        )
```

- [ ] **Step 5: Update manifest persistence to round-trip `attempt`**

In `hoga/api/captures.py`, locate `_persist_queue_locked` (around line 268) and add `attempt` to the manifest items:

```python
def _persist_queue_locked() -> None:
    if _data_dir is None:
        return
    assert _lock.locked(), "must hold _lock — see ADR-0019"
    items = [
        QueueManifestItem(
            item_id=s.item_id,
            code=s.code,
            date=s.date,
            force_retry=s.force_retry,
            enqueued_at_ms=s.enqueued_at_ms,
            pause_origin=s.pause_origin,
            attempt=s.attempt,
        )
        for s in _items_in_restore_order()
    ]
    save_manifest(_data_dir, QueueManifest(paused=_queue_paused, items=items))
```

Locate `_restore_queue_from_manifest` (around line 292) and pass `attempt` into the rehydrated state:

```python
    for item in manifest.items:
        state = QueueItemState(
            item_id=item.item_id,
            code=item.code,
            date=item.date,
            force_retry=item.force_retry,
            enqueued_at_ms=item.enqueued_at_ms,
            pause_origin=item.pause_origin,
            attempt=item.attempt,
            phase="cancelled" if item.pause_origin else "queued",
        )
        if item.pause_origin:
            _done.append(state)
        else:
            _queue.append(state)
```

- [ ] **Step 6: Run model tests to verify they pass**

```bash
uv run pytest tests/test_models.py::test_queue_item_attempt_defaults_to_1 \
  tests/test_models.py::test_queue_item_attempt_accepts_explicit_value \
  tests/test_models.py::test_queue_manifest_item_attempt_defaults_to_1 -v
```

Expected: 3 PASS.

- [ ] **Step 7: Run the full backend test suite to verify nothing else broke**

```bash
uv run pytest tests/test_models.py tests/test_api_captures_queue.py \
  tests/test_api_captures_persistence.py tests/test_api_captures_restore.py -v
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/models.py hoga/api/captures.py tests/test_models.py
git commit -m "feat(captures): add attempt field to QueueItem + QueueManifestItem

Additive field with default=1 per ADR-0031. Manifest schema_version stays
at 1 — pydantic default handles legacy entries with no migration."
```

---

## Task 2: Add `CaptureDismissedEvent`, `RetryRequest`, `RetryResponse`, `RetrySkippedRow` models

**Files:**
- Modify: `hoga/api/models.py` (append after `CaptureQueueDrainedEvent` and after `EnqueueResponse`)
- Test: `tests/test_models.py` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_models.py`:

```python
def test_capture_dismissed_event_carries_item_ids():
    from hoga.api.models import CaptureDismissedEvent
    e = CaptureDismissedEvent(item_ids=["a", "b"])
    assert e.type == "capture_dismissed"
    assert e.item_ids == ["a", "b"]


def test_retry_request_accepts_item_ids_list():
    from hoga.api.models import RetryRequest
    req = RetryRequest(item_ids=["x", "y"])
    assert req.item_ids == ["x", "y"]


def test_retry_request_rejects_empty_item_ids():
    """Per ADR-0031: empty retry call is a usage error, not a no-op."""
    import pytest
    from pydantic import ValidationError
    from hoga.api.models import RetryRequest
    with pytest.raises(ValidationError):
        RetryRequest(item_ids=[])


def test_retry_skipped_row_reasons_are_constrained():
    """Reason field is a Literal of the 4 documented skip reasons."""
    import pytest
    from pydantic import ValidationError
    from hoga.api.models import RetrySkippedRow
    for reason in ("not_found", "not_failed", "already_in_queue", "already_running"):
        RetrySkippedRow(item_id="x", reason=reason)
    with pytest.raises(ValidationError):
        RetrySkippedRow(item_id="x", reason="something_else")


def test_retry_response_shape():
    from hoga.api.models import QueueItem, RetryResponse, RetrySkippedRow
    item = QueueItem(
        item_id="new", code="005930", date="20260520",
        phase="queued", force_retry=False, pause_origin=False,
        enqueued_at_ms=1, attempt=2,
    )
    resp = RetryResponse(
        enqueued=[item],
        skipped=[RetrySkippedRow(item_id="old", reason="not_found")],
    )
    assert resp.enqueued[0].attempt == 2
    assert resp.skipped[0].reason == "not_found"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_models.py::test_capture_dismissed_event_carries_item_ids \
  tests/test_models.py::test_retry_request_accepts_item_ids_list \
  tests/test_models.py::test_retry_request_rejects_empty_item_ids \
  tests/test_models.py::test_retry_skipped_row_reasons_are_constrained \
  tests/test_models.py::test_retry_response_shape -v
```

Expected: 5 FAIL with `ImportError` — symbols not defined.

- [ ] **Step 3: Add the four new models**

In `hoga/api/models.py`, find `CaptureQueueDrainedEvent` (around line 225) and add `CaptureDismissedEvent` directly after it:

```python
class CaptureDismissedEvent(BaseModel):
    """Tells the frontend to drop these item_ids from any bucket. Emitted by
    the Retry flow when the old failed row is removed from `_done` before
    the new attempt is enqueued. See ADR-0031.
    """

    type: Literal["capture_dismissed"] = "capture_dismissed"
    item_ids: list[str]
```

Find `EnqueueResponse` (around line 286) and add the three Retry models directly after it:

```python
# --- POST /api/captures/items/retry request/response (ADR-0031) ------------


class RetryRequest(BaseModel):
    """Bulk Retry payload. Single-row ↻ sends a one-element list."""

    item_ids: list[str] = Field(min_length=1)


class RetrySkippedRow(BaseModel):
    """One item_id that did not produce a Retry enqueue and why."""

    item_id: str
    reason: Literal["not_found", "not_failed", "already_in_queue", "already_running"]


class RetryResponse(BaseModel):
    """Mirrors EnqueueResponse shape (enqueued + diagnostic list)."""

    enqueued: list[QueueItem]
    skipped: list[RetrySkippedRow]
```

Verify `Field` is imported at the top of `models.py`. If not, find the existing `from pydantic import …` line and add `Field` to the import.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest tests/test_models.py -v -k "retry or dismissed"
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_models.py
git commit -m "feat(captures): add CaptureDismissedEvent + RetryRequest/Response/SkippedRow models

Per ADR-0031: dedicated wire models for the new /api/captures/items/retry
endpoint and the capture_dismissed SSE event it emits."
```

---

## Task 3: Implement `_retry_items` core logic (no HTTP yet)

**Files:**
- Modify: `hoga/api/captures.py` (add helper near other queue mutation helpers, before `build_router`)
- Test: `tests/test_api_captures_queue.py` (append unit tests at the bottom)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api_captures_queue.py`:

```python
# --- Retry endpoint core logic (ADR-0031) ----------------------------------


async def test_retry_items_moves_failed_done_item_to_queue_with_incremented_attempt(
    monkeypatch, tmp_path,
):
    """Happy path: a single failed item_id is removed from _done and a new
    QueueItemState appears in _queue with attempt=prior+1 and the same
    force_retry flag."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    # Seed _done with a failed item.
    failed = _make_item("old-1", code="005930", date="20260520")
    failed.phase = "failed"
    failed.attempt = 1
    captures._done.append(failed)

    result = await captures._retry_items(["old-1"])

    assert result.enqueued[0].attempt == 2
    assert result.enqueued[0].force_retry is False
    assert result.enqueued[0].item_id != "old-1"   # new id
    assert result.skipped == []
    assert len(captures._queue) == 1
    assert captures._queue[0].code == "005930"
    assert captures._queue[0].attempt == 2
    assert all(s.item_id != "old-1" for s in captures._done)
    assert result.dismissed_item_ids == ["old-1"]


async def test_retry_items_preserves_force_retry_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("old-fr", code="005930", date="20260520")
    failed.phase = "failed"
    failed.force_retry = True
    failed.attempt = 2
    captures._done.append(failed)

    result = await captures._retry_items(["old-fr"])

    assert result.enqueued[0].force_retry is True
    assert result.enqueued[0].attempt == 3


async def test_retry_items_skips_not_found(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    result = await captures._retry_items(["does-not-exist"])
    assert result.enqueued == []
    assert result.skipped == [{"item_id": "does-not-exist", "reason": "not_found"}]
    assert result.dismissed_item_ids == []


async def test_retry_items_skips_not_failed(monkeypatch, tmp_path):
    """A done-phase item should not be retryable — only `failed`."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    completed = _make_item("done-1", code="005930", date="20260520")
    completed.phase = "done"
    captures._done.append(completed)

    result = await captures._retry_items(["done-1"])

    assert result.enqueued == []
    assert result.skipped == [{"item_id": "done-1", "reason": "not_failed"}]
    # Done item remains in _done untouched.
    assert any(s.item_id == "done-1" for s in captures._done)


async def test_retry_items_skips_already_in_queue(monkeypatch, tmp_path):
    """(code, date) already in _queue → skipped as already_in_queue."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("old-2", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)
    # Same (code, date) already in queue from a manual addItems.
    captures._queue.append(_make_item("q-1", code="005930", date="20260520"))

    result = await captures._retry_items(["old-2"])

    assert result.enqueued == []
    assert result.skipped == [{"item_id": "old-2", "reason": "already_in_queue"}]
    # Failed item is NOT removed when skipped.
    assert any(s.item_id == "old-2" for s in captures._done)


async def test_retry_items_skips_already_running(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("old-3", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)
    active = _make_item("a-1", code="005930", date="20260520")
    active.phase = "capturing"
    captures._active["a-1"] = active

    result = await captures._retry_items(["old-3"])

    assert result.enqueued == []
    assert result.skipped == [{"item_id": "old-3", "reason": "already_running"}]


async def test_retry_items_bulk_mixed_outcomes(monkeypatch, tmp_path):
    """Three item_ids: one valid failed, one not_found, one not_failed.
    The valid one retries, the other two get distinct skip reasons."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    f1 = _make_item("f1", code="005930", date="20260520")
    f1.phase = "failed"
    f2 = _make_item("d1", code="000660", date="20260521")
    f2.phase = "done"
    captures._done.extend([f1, f2])

    result = await captures._retry_items(["f1", "missing", "d1"])

    assert len(result.enqueued) == 1
    assert result.enqueued[0].code == "005930"
    skip_reasons = {row["item_id"]: row["reason"] for row in result.skipped}
    assert skip_reasons == {"missing": "not_found", "d1": "not_failed"}
    assert result.dismissed_item_ids == ["f1"]


async def test_retry_items_dedupes_duplicates_within_batch(monkeypatch, tmp_path):
    """Same item_id passed twice → first retries, second sees not_found
    (already removed from _done)."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("dup", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)

    result = await captures._retry_items(["dup", "dup"])

    assert len(result.enqueued) == 1
    assert result.skipped == [{"item_id": "dup", "reason": "not_found"}]


async def test_retry_items_persists_manifest_after_mutation(monkeypatch, tmp_path):
    """Sanity-check ADR-0019: a successful Retry persists the manifest."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("p1", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)

    await captures._retry_items(["p1"])

    from hoga.api.captures_persistence import manifest_path
    path = manifest_path(tmp_path)
    assert path.exists()
    data = json.loads(path.read_text())
    # The new (retry-enqueued) item should be in the manifest's items list,
    # with attempt=2.
    assert any(it["attempt"] == 2 for it in data["items"])
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_captures_queue.py -v -k retry_items
```

Expected: all FAIL — `captures._retry_items` does not exist.

- [ ] **Step 3: Implement `_retry_items`**

In `hoga/api/captures.py`, add the helper directly before the `build_router` function (around line 836). Also add a small named tuple-style result for clarity:

```python
@dataclass
class _RetryResult:
    """Internal Retry outcome — what the HTTP handler turns into RetryResponse."""
    enqueued: list[QueueItemState]
    skipped: list[dict]                     # [{"item_id": str, "reason": str}]
    dismissed_item_ids: list[str]           # original ids removed from _done


async def _retry_items(item_ids: list[str]) -> _RetryResult:
    """Core Retry logic (ADR-0031). Caller holds no lock; we acquire ``_lock``
    inside and publish events after release.

    For each item_id (preserving input order):
    - Look up in ``_done``. Missing → skip ``not_found``.
    - Phase must be ``failed`` → otherwise skip ``not_failed``.
    - Apply (code, date) dedupe against ``_queue ∪ _active ∪ _inflight_paths``.
      Hit → skip ``already_running`` / ``already_in_queue``.
    - Remove from ``_done``; enqueue a new ``QueueItemState`` with
      ``attempt = prior + 1`` and the same ``force_retry``.

    Duplicate item_ids in the same batch: the first attempt removes the row
    from ``_done``; the second sees ``not_found``.
    """
    enqueued: list[QueueItemState] = []
    skipped: list[dict] = []
    dismissed: list[str] = []
    enqueued_at_ms = int(time.time() * 1000)

    async with _lock:
        active_pairs = {(s.code, s.date) for s in _active.values()}
        queue_pairs: set[tuple[str, str]] = {(s.code, s.date) for s in _queue}
        for item_id in item_ids:
            # 1. Find in _done.
            target: QueueItemState | None = None
            target_idx = -1
            for i, s in enumerate(_done):
                if s.item_id == item_id:
                    target = s
                    target_idx = i
                    break
            if target is None:
                skipped.append({"item_id": item_id, "reason": "not_found"})
                continue
            # 2. Phase guard.
            if target.phase != "failed":
                skipped.append({"item_id": item_id, "reason": "not_failed"})
                continue
            # 3. Dedupe.
            pair = (target.code, target.date)
            if pair in active_pairs or pair in _inflight_paths:
                skipped.append({"item_id": item_id, "reason": "already_running"})
                continue
            if pair in queue_pairs:
                skipped.append({"item_id": item_id, "reason": "already_in_queue"})
                continue
            # 4. Apply: remove old, enqueue new.
            del _done[target_idx]
            dismissed.append(target.item_id)
            new_state = QueueItemState(
                item_id=_make_item_id(target.code, target.date),
                code=target.code,
                date=target.date,
                force_retry=target.force_retry,
                enqueued_at_ms=enqueued_at_ms,
                attempt=target.attempt + 1,
            )
            _queue.append(new_state)
            enqueued.append(new_state)
            queue_pairs.add(pair)   # so a second id targeting same (code, date) is deduped
        if enqueued and _wakeup is not None:
            _wakeup.set()
        _persist_queue_locked()

    # Publish events outside the lock — dismissed first so the UI removes
    # the old rows before the new ones land.
    from hoga.api.models import CaptureDismissedEvent  # local import to keep top tidy
    if dismissed:
        _publish_event(CaptureDismissedEvent(item_ids=dismissed))
    if enqueued:
        _publish_event(CaptureQueuedEvent(items=[s.to_wire() for s in enqueued]))

    return _RetryResult(enqueued=enqueued, skipped=skipped, dismissed_item_ids=dismissed)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_captures_queue.py -v -k retry_items
```

Expected: 9 PASS.

- [ ] **Step 5: Run the broader captures suite to confirm no regression**

```bash
uv run pytest tests/test_api_captures_queue.py tests/test_api_captures_persistence.py \
  tests/test_api_captures_restore.py -v
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): implement _retry_items core (ADR-0031)

Move a failed _done item to _queue with attempt+1 and same force_retry.
Skip reasons: not_found, not_failed, already_in_queue, already_running.
Emits CaptureDismissedEvent before CaptureQueuedEvent so the UI removes
the old row first."
```

---

## Task 4: Wire `POST /api/captures/items/retry` route

**Files:**
- Modify: `hoga/api/captures.py` (inside `build_router`, after `enqueue_items`)
- Test: `tests/test_api_captures_queue.py` (append HTTP-level tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api_captures_queue.py`:

```python
def test_retry_route_returns_201_and_response_shape(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        # Seed: a failed item in _done.
        failed = _make_item("r-1", code="005930", date="20260520")
        failed.phase = "failed"
        captures._done.append(failed)

        r = c.post("/api/captures/items/retry", json={"item_ids": ["r-1"]})
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["code"] == "005930"
        assert body["enqueued"][0]["date"] == "20260520"
        assert body["enqueued"][0]["attempt"] == 2
        assert body["skipped"] == []


def test_retry_route_400_on_empty_item_ids(monkeypatch, tmp_path):
    """RetryRequest declares min_length=1 — FastAPI returns 422."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items/retry", json={"item_ids": []})
        assert r.status_code == 422


def test_retry_route_returns_skipped_reasons(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        completed = _make_item("d-1", code="005930", date="20260520")
        completed.phase = "done"
        captures._done.append(completed)

        r = c.post("/api/captures/items/retry", json={
            "item_ids": ["missing-x", "d-1"],
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"] == []
        reasons = {row["item_id"]: row["reason"] for row in body["skipped"]}
        assert reasons == {"missing-x": "not_found", "d-1": "not_failed"}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_captures_queue.py -v -k retry_route
```

Expected: 3 FAIL with 404 (route not registered).

- [ ] **Step 3: Wire the route inside `build_router`**

Open `hoga/api/captures.py`, find `enqueue_items` (around line 855) and add the new route handler directly after the existing `@router.post("/items", ...)` block, before `@router.post("/items/{item_id}/cancel", ...)`. Also import the new wire models at the top.

In the imports block (around line 24, the `from hoga.api.models import (...)`), add three names:

```python
from hoga.api.models import (
    CaptureDismissedEvent,
    CaptureError,
    CaptureFinishedEvent,
    CapturePhase,
    CapturePhaseEvent,
    CaptureProgress,
    CaptureProgressEvent,
    CaptureQueuedEvent,
    CaptureQueuePausedEvent,
    CaptureQueueResumedEvent,
    CaptureResult,
    EnqueueDedupedRow,
    EnqueueRequest,
    EnqueueResponse,
    QueueManifest,
    QueueManifestItem,
    QueueSnapshot,
    RetryRequest,
    RetryResponse,
    RetrySkippedRow,
    SkipReason,
)
```

In `build_router`, add after the `enqueue_items` handler:

```python
    @router.post("/items/retry", status_code=201)
    async def retry_items_route(req: RetryRequest) -> RetryResponse:
        """Retry one or more failed queue items (ADR-0031).

        Each item_id must reference a _done entry whose phase == "failed".
        Other states (`not_found`, `not_failed`, `already_in_queue`,
        `already_running`) return diagnostic rows in `skipped`.
        """
        result = await _retry_items(req.item_ids)
        return RetryResponse(
            enqueued=[s.to_wire() for s in result.enqueued],
            skipped=[RetrySkippedRow(**row) for row in result.skipped],
        )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_captures_queue.py -v -k "retry_route or retry_items"
```

Expected: all PASS.

- [ ] **Step 5: Run the whole captures suite**

```bash
uv run pytest tests/test_api_captures_queue.py tests/test_api_captures_persistence.py \
  tests/test_api_captures_restore.py -v
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): POST /api/captures/items/retry route (ADR-0031)

Wraps _retry_items and returns RetryResponse. Empty item_ids is rejected
by pydantic min_length=1 (422)."
```

---

## Task 5: Mirror new types in frontend `types.ts`

**Files:**
- Modify: `frontend/src/api/types.ts` (mirror three model groups: QueueItem.attempt, Retry request/response, capture_dismissed SSE)

- [ ] **Step 1: Identify the four edit sites**

These exist in `frontend/src/api/types.ts`:
- `QueueItem` interface (line 156): add `attempt: number`
- `SSEEvent` union (line 180): add `{ type: 'capture_dismissed'; item_ids: string[] }`
- After `EnqueueResponse` (line 281): add `RetryRequest`, `RetrySkippedRow`, `RetryResponse`

- [ ] **Step 2: Add `attempt` to `QueueItem`**

```ts
/** Mirrors hoga/api/models.py::QueueItem. */
export interface QueueItem {
  item_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
  force_retry: boolean;
  pause_origin: boolean;
  enqueued_at_ms: number;
  started_at_ms: number | null;
  progress: CaptureProgress | null;
  result: CaptureResult | null;
  error: CaptureError | null;
  skip_reason: SkipReason | null;
  attempt: number;
}
```

- [ ] **Step 3: Add `capture_dismissed` to `SSEEvent`**

In the `SSEEvent` union (around line 180), add a new arm after `capture_queued`:

```ts
  | { type: 'capture_queued'; items: QueueItem[] }
  | { type: 'capture_dismissed'; item_ids: string[] }
  | { type: 'capture_queue_paused'; reason: 'cookie_expired'; message: string }
```

- [ ] **Step 4: Add Retry request/response types**

After `EnqueueResponse` (around line 281), add:

```ts
/** Mirrors hoga/api/models.py::RetryRequest. */
export interface RetryRequest {
  item_ids: string[];   // non-empty per backend validator
}

export interface RetrySkippedRow {
  item_id: string;
  reason: 'not_found' | 'not_failed' | 'already_in_queue' | 'already_running';
}

/** Mirrors hoga/api/models.py::RetryResponse. */
export interface RetryResponse {
  enqueued: QueueItem[];
  skipped: RetrySkippedRow[];
}
```

- [ ] **Step 5: Type-check the frontend**

```bash
cd frontend && npx tsc --noEmit
```

Expected: zero errors. (If references to `attempt` already exist in test fixtures from Task 8 review, ensure those tests also include it — see Task 8 step 5.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend): mirror QueueItem.attempt + Retry types + capture_dismissed SSE"
```

---

## Task 6: Add `retryItems` API client function

**Files:**
- Modify: `frontend/src/api/captures.ts`
- Test: `frontend/src/api/captures.test.ts` (create or append if it exists)

- [ ] **Step 1: Check whether a test file exists**

```bash
ls frontend/src/api/captures.test.ts 2>&1
```

If it does, append; otherwise create.

- [ ] **Step 2: Write the failing test**

In `frontend/src/api/captures.test.ts` (create if missing):

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { retryItems } from './captures';

describe('retryItems', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('POSTs item_ids to /api/captures/items/retry and returns the body', async () => {
    const body = {
      enqueued: [{ item_id: 'new-1', code: '005930', date: '20260520', phase: 'queued',
                   force_retry: false, pause_origin: false, enqueued_at_ms: 1,
                   started_at_ms: null, progress: null, result: null, error: null,
                   skip_reason: null, attempt: 2 }],
      skipped: [],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 201, json: async () => body,
    } as Response);

    const result = await retryItems({ item_ids: ['old-1'] });

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/captures/items/retry');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ item_ids: ['old-1'] });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/api/captures.test.ts
```

Expected: FAIL — `retryItems` not exported.

- [ ] **Step 4: Add `retryItems` to the captures module**

In `frontend/src/api/captures.ts`, append the new export and add `RetryRequest`/`RetryResponse` to the existing import line:

```ts
import { apiAction, apiCall, type ApiError } from './client';
import type {
  CaptureErrorCode, EnqueueRequest, EnqueueResponse, QueueSnapshot,
  RetryRequest, RetryResponse,
} from './types';
```

Then below the existing `dismissDone` function, add:

```ts
export function retryItems(req: RetryRequest): Promise<RetryResponse> {
  return apiCall<RetryResponse>('/api/captures/items/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd frontend && npx vitest run src/api/captures.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/captures.ts frontend/src/api/captures.test.ts
git commit -m "feat(frontend): add retryItems API client (ADR-0031)"
```

---

## Task 7: `useCaptureQueue` — new mutation + `capture_dismissed` SSE handler

**Files:**
- Modify: `frontend/src/capture/useCaptureQueue.ts`
- Test: `frontend/src/capture/useCaptureQueue.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/capture/useCaptureQueue.test.tsx` (model the existing tests' setup):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCaptureQueue, patchQueueItem } from './useCaptureQueue';
import type { QueueSnapshot, SSEEvent } from '../api/types';

// Capture the SSE callback so the test can drive it directly.
let _onEvent: ((e: SSEEvent) => void) | null = null;
vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: (cb: (e: SSEEvent) => void) => {
    _onEvent = cb;
    return () => { _onEvent = null; };
  },
}));

function W(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const snap = (): QueueSnapshot => ({
  active: [],
  queued: [],
  done: [
    { item_id: 'f1', code: '005930', date: '20260520', phase: 'failed',
      force_retry: false, pause_origin: false, enqueued_at_ms: 1,
      started_at_ms: null, progress: null, result: null, error: null,
      skip_reason: null, attempt: 1 },
    { item_id: 'f2', code: '005930', date: '20260521', phase: 'failed',
      force_retry: false, pause_origin: false, enqueued_at_ms: 1,
      started_at_ms: null, progress: null, result: null, error: null,
      skip_reason: null, attempt: 1 },
  ],
  paused: false, max_concurrent: 3,
});

describe('useCaptureQueue capture_dismissed handling', () => {
  it('removes item_ids from active/queued/done buckets when capture_dismissed arrives', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/queue')) {
        return { ok: true, status: 200, json: async () => snap() } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCaptureQueue(), { wrapper: W(qc) });

    await waitFor(() => expect(result.current.queue).toBeDefined());
    expect(result.current.queue?.done.length).toBe(2);

    _onEvent!({ type: 'capture_dismissed', item_ids: ['f1'] } as SSEEvent);

    await waitFor(() => expect(result.current.queue?.done.length).toBe(1));
    expect(result.current.queue?.done[0].item_id).toBe('f2');
  });

  it('exposes retryItems mutation that posts to /items/retry', async () => {
    let postedBody: any = null;
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.includes('/queue')) {
        return { ok: true, status: 200, json: async () => snap() } as Response;
      }
      if (s.includes('/items/retry')) {
        postedBody = JSON.parse(String(init?.body));
        return { ok: true, status: 201, json: async () => ({ enqueued: [], skipped: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { result } = renderHook(() => useCaptureQueue(), { wrapper: W(qc) });

    await waitFor(() => expect(result.current.queue).toBeDefined());
    result.current.retryItems.mutate({ item_ids: ['f1', 'f2'] });

    await waitFor(() => expect(postedBody).toEqual({ item_ids: ['f1', 'f2'] }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/capture/useCaptureQueue.test.tsx -t capture_dismissed
```

Expected: FAIL — `retryItems` not on hook return, SSE handler not present.

- [ ] **Step 3: Add the mutation + SSE handler**

In `frontend/src/capture/useCaptureQueue.ts`, add the import:

```ts
import {
  addItems, getQueue, cancelItem, cancelAll, resumeQueue, dismissDone, retryItems,
} from '../api/captures';
```

In the `useEffect` SSE subscriber (around line 50), add a new branch alongside the existing `capture_progress` / `capture_phase` / `capture_finished` ones. Place it after `capture_finished`:

```ts
      } else if (e.type === 'capture_dismissed') {
        qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) => {
          if (!prev) return prev;
          const ids = new Set(e.item_ids);
          const filter = (list: QueueItem[]) => list.filter((i) => !ids.has(i.item_id));
          const next: QueueSnapshot = {
            ...prev,
            active: filter(prev.active),
            queued: filter(prev.queued),
            done: filter(prev.done),
          };
          // Reference-equality short-circuit if no list actually changed.
          if (next.active === prev.active && next.queued === prev.queued && next.done === prev.done) {
            return prev;
          }
          return next;
        });
      } else if (
```

(The leading `} else if (` line is the existing `capture_queued` branch — keep it intact.)

Below the existing mutations (`resumeQueueM`), add:

```ts
  const retryItemsM = useMutation({
    mutationFn: retryItems,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
```

Extend the return object:

```ts
  return {
    queue: queue.data,
    isLoading: queue.isLoading,
    addItems: addItemsM,
    cancelItem: cancelItemM,
    cancelAll: cancelAllM,
    dismissDone: dismissDoneM,
    resumeQueue: resumeQueueM,
    retryItems: retryItemsM,
  };
```

Verify that `filter` references work: `QueueItem` must already be imported at the top. If not, ensure the existing `import type { QueueItem, QueueSnapshot, SSEEvent } from '../api/types';` is present.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/capture/useCaptureQueue.test.tsx
```

Expected: all PASS (existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/useCaptureQueue.ts frontend/src/capture/useCaptureQueue.test.tsx
git commit -m "feat(frontend): wire retryItems mutation + capture_dismissed SSE handler

ADR-0031: dismissed event drops item_ids from active/queued/done buckets
in the React Query cache so old failed rows disappear instantly."
```

---

## Task 8: `CaptureQueueRow` — `×N` attempt badge

**Files:**
- Modify: `frontend/src/capture/CaptureQueueRow.tsx:43-51` (symbol-name area)
- Test: `frontend/src/capture/CaptureQueueRow.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/capture/CaptureQueueRow.test.tsx`:

```tsx
describe('CaptureQueueRow attempt badge (ADR-0031)', () => {
  it('hides the attempt badge when attempt === 1', () => {
    render(<CaptureQueueRow item={{ ...base, attempt: 1 }} symbolName="삼성전자"
                           onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.queryByTitle(/Attempt/i)).toBeNull();
  });

  it('renders ×N badge when attempt > 1', () => {
    render(<CaptureQueueRow item={{ ...base, attempt: 3 }} symbolName="삼성전자"
                           onCancel={() => {}} onRetry={() => {}} />);
    const badge = screen.getByTitle(/Attempt 3/i);
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('×3');
  });

  it('renders both ⚠ force and ×N badges together when both apply', () => {
    render(<CaptureQueueRow item={{ ...base, force_retry: true, attempt: 2 }}
                           symbolName="삼성전자"
                           onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByTitle(/force re-capture/i)).toBeTruthy();
    expect(screen.getByTitle(/Attempt 2/i)).toBeTruthy();
  });
});
```

Also add `attempt: 1` to the `base` fixture object at the top of the file so the existing tests keep type-checking:

```ts
const base: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'queued', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
  attempt: 1,
};
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/capture/CaptureQueueRow.test.tsx -t "attempt badge"
```

Expected: FAIL — badge not rendered.

- [ ] **Step 3: Render the badge**

In `frontend/src/capture/CaptureQueueRow.tsx`, locate the `<span className="font-normal text-sm text-fg-dim">` block (lines 43-51). The `⚠ force` badge currently lives there; add the attempt badge directly after the force badge, still inside that `<span>`:

```tsx
        <span className="font-normal text-sm text-fg-dim">
          {symbolName}
          {item.force_retry && (
            <span
              title="Force re-capture"
              className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--warn)] text-[var(--warn)]"
            >⚠ force</span>
          )}
          {item.attempt > 1 && (
            <span
              title={`Attempt ${item.attempt}`}
              className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--fg-dim)] text-fg-dim"
            >×{item.attempt}</span>
          )}
        </span>
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/capture/CaptureQueueRow.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Find and fix any other test fixtures missing `attempt`**

```bash
cd frontend && grep -rn "item_id:" src --include="*.ts" --include="*.tsx" \
  | grep -v "attempt" | grep -i "queueitem\|enqueued_at_ms"
```

For every QueueItem literal that lacks `attempt`, add `attempt: 1` so type-checking passes.

```bash
cd frontend && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/capture/CaptureQueueRow.tsx frontend/src/capture/CaptureQueueRow.test.tsx \
  $(git ls-files -m frontend/src --exclude-standard | grep -E '\.test\.tsx?$')
git commit -m "feat(frontend): show ×N attempt badge on queue rows

Hidden for attempt=1; renders neutral fg-dim badge (vs warn-colored
⚠ force) to read as information rather than warning."
```

---

## Task 9: `CaptureQueue` — header "Retry Failed" button + route ↻ through new mutation

**Files:**
- Modify: `frontend/src/capture/CaptureQueue.tsx:91-120`
- Test: `frontend/src/capture/CaptureQueue.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/capture/CaptureQueue.test.tsx`:

```tsx
describe('CaptureQueue Retry Failed (ADR-0031)', () => {
  it('renders Retry Failed button disabled when failed count is 0', async () => {
    const snap = { ...SNAPSHOT(), done: [item('d1', 'done')] };  // 0 failed
    const qc = setup(snap);
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    const btn = screen.getByRole('button', { name: /Retry Failed/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('Retry Failed enabled when failed > 0, POSTs all failed item_ids', async () => {
    let postedBody: any = null;
    const failed1 = { ...item('f1', 'failed'), date: '20260518' };
    const failed2 = { ...item('f2', 'failed'), date: '20260519' };
    const snap: QueueSnapshot = {
      active: [], queued: [], done: [failed1, failed2],
      paused: false, max_concurrent: 3,
    };
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url, init) => {
      const s = String(url);
      if (s.includes('/queue')) return { ok: true, status: 200, json: async () => snap } as Response;
      if (s.includes('/items/retry')) {
        postedBody = JSON.parse(String(init?.body));
        return { ok: true, status: 201, json: async () => ({ enqueued: [], skipped: [] }) } as Response;
      }
      if (s.includes('/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    const btn = screen.getByRole('button', { name: /Retry Failed/i });
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 30));

    expect(postedBody).toEqual({ item_ids: ['f1', 'f2'] });
  });

  it('per-row ↻ click routes through retryItems mutation (not addItems)', async () => {
    const calls: string[] = [];
    const failed = { ...item('f1', 'failed'), date: '20260518' };
    const snap: QueueSnapshot = {
      active: [], queued: [], done: [failed],
      paused: false, max_concurrent: 3,
    };
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
      const s = String(url);
      if (s.includes('/items/retry')) { calls.push('retry'); return { ok: true, status: 201, json: async () => ({ enqueued: [], skipped: [] }) } as Response; }
      if (s.includes('/items')) { calls.push('items'); return { ok: true, status: 201, json: async () => ({ enqueued: [], deduped: [] }) } as Response; }
      if (s.includes('/queue')) return { ok: true, status: 200, json: async () => snap } as Response;
      if (s.includes('/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    fireEvent.click(screen.getByRole('button', { name: /retry|↻/i }));
    await new Promise((r) => setTimeout(r, 30));

    expect(calls).toContain('retry');
    expect(calls).not.toContain('items');
  });
});
```

Also extend the test fixture so `item()` includes `attempt`:

```ts
const item = (id: string, phase: QueueItem['phase']): QueueItem => ({
  item_id: id, code: '005930', date: '20260518', phase,
  force_retry: false, pause_origin: false, enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null, attempt: 1,
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run src/capture/CaptureQueue.test.tsx -t "Retry Failed"
```

Expected: FAIL — button missing, ↻ still calls addItems.

- [ ] **Step 3: Wire the button + reroute ↻**

In `frontend/src/capture/CaptureQueue.tsx`, locate the `useCaptureQueue` destructure (line 33) and add `retryItems`:

```tsx
  const { queue, cancelItem, cancelAll, dismissDone, addItems, resumeQueue, retryItems } = useCaptureQueue();
```

Locate `onRetry` (line 91) and replace its body so single-row ↻ now goes through `retryItems`:

```tsx
  const onRetry = (item: QueueItem) => {
    retryItems.mutate({ item_ids: [item.item_id] });
  };
```

`addItems` is no longer referenced inside this component — remove it from the destructure (or keep it if other call sites use it; check first). Quick grep:

```bash
cd frontend && grep -n "addItems" src/capture/CaptureQueue.tsx
```

If only the removed `onRetry` referenced it, drop `addItems` from the destructure to satisfy the linter.

Then locate the header `<div>` (line 103) and add the new button between `Cancel All` and `Dismiss Done`:

```tsx
      <div className="flex items-center gap-3 px-sm">
        <div className="flex-1 font-medium text-sm font-mono text-fg-dim tabular-nums">
          {summary.done} of {summary.total} done · {summary.failed} failed · {summary.capturing} capturing
        </div>
        <button
          type="button"
          onClick={handleCancelAll}
          style={cancelAllArmed
            ? ghostButton('var(--error)', 'var(--error)')
            : ghostButton()
          }
        >{cancelAllArmed ? 'Click again to confirm' : 'Cancel All'}</button>
        <button
          type="button"
          disabled={summary.failed === 0}
          onClick={() => {
            const ids = queue.done
              .filter((i) => i.phase === 'failed')
              .map((i) => i.item_id);
            if (ids.length > 0) retryItems.mutate({ item_ids: ids });
          }}
          style={summary.failed === 0 ? ghostButtonDisabled() : ghostButton()}
        >Retry Failed</button>
        <button
          type="button"
          onClick={() => dismissDone.mutate()}
          style={ghostButton()}
        >Dismiss Done</button>
      </div>
```

At the bottom of the file (after `ghostButton`), add the disabled variant:

```tsx
function ghostButtonDisabled(): React.CSSProperties {
  return { ...ghostButton(), opacity: 0.5, cursor: 'not-allowed' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd frontend && npx vitest run src/capture/CaptureQueue.test.tsx
```

Expected: all PASS (including existing tests).

- [ ] **Step 5: Type-check the whole frontend**

```bash
cd frontend && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Run the full frontend test suite to catch any other fixture drift**

```bash
cd frontend && npx vitest run
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/capture/CaptureQueue.tsx frontend/src/capture/CaptureQueue.test.tsx
git commit -m "feat(frontend): Retry Failed bulk button + route ↻ through retryItems

Header button is disabled when failed=0; clicking it sends every failed
item_id to /api/captures/items/retry in one call. Single-row ↻ uses the
same mutation, replacing the previous addItems path."
```

---

## Task 10: Manual end-to-end smoke test

**Files:** (none changed — runtime verification only)

- [ ] **Step 1: Start both dev servers (backend hot-reload + frontend HMR)**

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

In a second terminal:

```bash
cd frontend && npm run dev
```

(See [CLAUDE.md](../../../CLAUDE.md) "Dev servers" section if the commands need adjustment.)

- [ ] **Step 2: Enqueue a small batch**

Open `http://localhost:5173/capture`. Enter a code (e.g. `005930`) and a date range with 3–5 dates. Click Start. Wait for the queue to settle.

- [ ] **Step 3: Force a failure**

Easiest path: stop the backend mid-capture (Ctrl-C, restart). Any active item will end up in `failed` (or `cancelled`). Alternatively, target a date you expect to fail (e.g. a code with no upstream data would show `skipped`, not `failed` — instead pick a real code with a known-bad date if available, or temporarily kill the backend mid-run).

Confirm at least one row shows phase `failed` with the ↻ icon.

- [ ] **Step 4: Single-row Retry**

Click ↻ on a failed row. Verify:
- The failed row disappears immediately (no flicker, no duplicate).
- A new row appears in the active/queued band at the top.
- The new row shows `×2` next to the symbol name.

- [ ] **Step 5: Bulk Retry Failed**

Force at least two failures (repeat step 3 with another date). Click `Retry Failed` in the header. Verify:
- The button shows `Retry Failed` with no number (per spec — count lives in the left summary).
- All failed rows disappear at once.
- All new attempts show `×N` badges with the incremented count.
- Header `N failed` counter drops to 0; button becomes disabled (dimmed).

- [ ] **Step 6: Retry after dismissDone**

While at least one failed row is visible, click `Dismiss Done`. Then click `Retry Failed`. Verify:
- The button was disabled the moment `Dismiss Done` completed (no failed rows left).
- No errors in browser console or backend log.

- [ ] **Step 7: Restart-resume preserves attempt**

Force a `×2` attempt to be in `queued` (enqueue 50 items, retry a few that failed, then kill the backend before they finish). Restart the backend. Verify in the UI that the retry-enqueued items come back with their `×N` badges intact (manifest round-trip).

- [ ] **Step 8: Commit the manual-smoke checklist outcomes (no code)**

If everything above passed, no commit needed. If you found a regression, fix it under whichever earlier Task owns the relevant code and add a regression test there.

---

## Self-Review

Run through the spec sections and confirm coverage:

| Spec section | Implementing task |
|---|---|
| New endpoint `POST /api/captures/items/retry` | Task 4 |
| `RetryRequest`, `RetryResponse`, `RetrySkippedRow` | Task 2 |
| Backend processing steps 1–5 (lookup, phase guard, dedupe, remove from `_done`, enqueue) | Task 3 |
| `CaptureDismissedEvent` SSE | Task 2 (model) + Task 3 (publish) + Task 7 (consume) |
| `QueueItem.attempt` field + `default=1` + manifest backward compat | Task 1 |
| Frontend types mirror | Task 5 |
| `retryItems` API client | Task 6 |
| `useCaptureQueue` mutation + SSE handler | Task 7 |
| `×N` attempt badge | Task 8 |
| Header `Retry Failed` button (disabled when 0) | Task 9 |
| Single-row ↻ routed through new endpoint | Task 9 |
| Cookie-expired-during-retry edge case | Covered by existing pause path; new items land in `_queue` and the existing pause UI handles resume |
| Double-click Retry Failed | Task 3 (second call sees `not_found`) |
| Retry after `dismissDone` | Task 10 step 6 (manual) — no code path needed; button disables automatically |
| `force_retry` preservation | Task 3 test `test_retry_items_preserves_force_retry_flag` |

No spec requirements left uncovered.

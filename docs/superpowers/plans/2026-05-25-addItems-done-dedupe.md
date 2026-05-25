# addItems Phase-Aware `_done` Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicate (code, date) rows when `addItems` collides with `_done` items. Failed/cancelled rows auto re-enqueue; done is always dedupe; skipped re-enqueues only with `force_retry=true`.

**Architecture:** Extend the dedupe loop in [enqueue_items](../../../hoga/api/captures.py#L951) with phase-aware `_done` handling (per ADR-0033). Reuses the `CaptureDismissedEvent` SSE channel introduced by ADR-0031. Wire contract grows by two `EnqueueDedupedRow.reason` Literal values.

**Tech Stack:** FastAPI + pydantic v2 (backend), TypeScript (frontend type mirror), pytest-asyncio (mode auto).

**References:** [spec](../specs/2026-05-25-addItems-done-dedupe-design.md), [ADR-0033](../../adr/0033-addItems-phase-aware-done-dedupe.md), [ADR-0031](../../adr/0031-capture-retry-endpoint-split.md), [ADR-0019](../../adr/0019-capture-queue-manifest-persistence.md), CONTEXT.md "Retry" term.

---

## Task 1: Extend `EnqueueDedupedRow.reason` Literal (wire model)

**Files:**
- Modify: `hoga/api/models.py:280-283` (EnqueueDedupedRow class)
- Test: `tests/test_models.py` (append two tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_models.py`:

```python
def test_enqueue_deduped_row_accepts_already_complete():
    from hoga.api.models import EnqueueDedupedRow
    row = EnqueueDedupedRow(code="005930", date="20260520", reason="already_complete")
    assert row.reason == "already_complete"


def test_enqueue_deduped_row_accepts_already_skipped():
    from hoga.api.models import EnqueueDedupedRow
    row = EnqueueDedupedRow(code="005930", date="20260520", reason="already_skipped")
    assert row.reason == "already_skipped"


def test_enqueue_deduped_row_rejects_unknown_reason():
    import pytest
    from pydantic import ValidationError
    from hoga.api.models import EnqueueDedupedRow
    with pytest.raises(ValidationError):
        EnqueueDedupedRow(code="005930", date="20260520", reason="bogus_reason")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_models.py::test_enqueue_deduped_row_accepts_already_complete \
  tests/test_models.py::test_enqueue_deduped_row_accepts_already_skipped \
  tests/test_models.py::test_enqueue_deduped_row_rejects_unknown_reason -v
```

Expected: 2 FAIL (ValidationError on the new Literal values), 1 PASS (rejection still works on something else).

- [ ] **Step 3: Extend the Literal**

In `hoga/api/models.py`, locate `EnqueueDedupedRow` (around line 280) and add two members:

```python
class EnqueueDedupedRow(BaseModel):
    code: str
    date: str
    reason: Literal[
        "already_in_queue",
        "already_running",
        "already_complete",  # ADR-0033 — addItems collided with _done(phase=done)
        "already_skipped",   # ADR-0033 — addItems collided with _done(phase=skipped, no force_retry)
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
uv run pytest tests/test_models.py -v -k "enqueue_deduped_row"
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_models.py
git commit -m "$(cat <<'EOF'
feat(captures): extend EnqueueDedupedRow.reason with already_complete / already_skipped

Wire contract additions for ADR-0033 addItems phase-aware _done dedupe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mirror new Literal values in frontend `types.ts`

**Files:**
- Modify: `frontend/src/api/types.ts:271-275` (EnqueueDedupedRow interface)

This is a pure types-mirror task. No tests of its own — TypeScript's compiler catches drift.

- [ ] **Step 1: Add the two new union members**

Locate `EnqueueDedupedRow` (around line 271):

```ts
export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: 'already_in_queue' | 'already_running';
}
```

Replace with:

```ts
export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: 'already_in_queue' | 'already_running' | 'already_complete' | 'already_skipped';
}
```

- [ ] **Step 2: Type-check the frontend (with project references!)**

```bash
cd frontend && npx tsc -b
```

Expected: zero new errors. (Pre-existing `lineStyle` errors in `chart/drawing/translate.test.ts` are unrelated and acceptable.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "$(cat <<'EOF'
feat(frontend): mirror EnqueueDedupedRow.reason expansion (ADR-0033)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Implement phase-aware `_done` dedupe in `enqueue_items`

**Files:**
- Modify: `hoga/api/captures.py:1002-1043` (the dedupe loop inside `enqueue_items` route handler)
- Test: `tests/test_api_captures_queue.py` (append HTTP-level tests using `_no_workers` pattern; also add a few unit-level tests that call the route via `TestClient`)

### Step 1: Write the failing tests (all 10 from the spec)

Append to `tests/test_api_captures_queue.py`:

```python
# --- ADR-0033: addItems phase-aware _done dedupe -----------------------------


def _post_items(c, code: str, dates: list[str], force_retry: bool = False):
    """Convenience: POST /api/captures/items with explicit dates list."""
    return c.post("/api/captures/items", json={
        "code": code, "dates": dates, "force_retry": force_retry,
    })


def _seed_done_item(*, item_id: str, code: str, date: str, phase: str,
                    attempt: int = 1, force_retry: bool = False,
                    pause_origin: bool = False):
    s = _make_item(item_id, code=code, date=date)
    s.phase = phase
    s.attempt = attempt
    s.force_retry = force_retry
    s.pause_origin = pause_origin
    captures._done.append(s)
    return s


def test_enqueue_dedupes_against_done_complete_with_force_false(monkeypatch, tmp_path):
    """done-phase _done item + force_retry=false → deduped as already_complete; _done untouched."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        old = _seed_done_item(item_id="old-d", code="005930", date="20260520", phase="done")

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"] == []
        assert body["deduped"] == [{
            "code": "005930", "date": "20260520", "reason": "already_complete",
        }]
        # _done untouched.
        assert any(s.item_id == "old-d" for s in captures._done)
        assert len(captures._queue) == 0


def test_enqueue_dedupes_against_done_complete_with_force_true(monkeypatch, tmp_path):
    """done-phase + force_retry=true STILL dedupes as already_complete (ADR-0033 invariant)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-d", code="005930", date="20260520", phase="done")

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"] == []
        assert body["deduped"][0]["reason"] == "already_complete"
        # _done untouched.
        assert any(s.item_id == "old-d" for s in captures._done)
        assert len(captures._queue) == 0


def test_enqueue_re_enqueues_failed_done_regardless_of_force_attempt_increments(
    monkeypatch, tmp_path,
):
    """failed-phase _done → auto re-enqueue with attempt+1 for both force_retry values."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-f", code="005930", date="20260520",
                        phase="failed", attempt=2)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 3
        assert body["enqueued"][0]["item_id"] != "old-f"
        assert body["deduped"] == []
        # Old failed row removed; new row in _queue.
        assert all(s.item_id != "old-f" for s in captures._done)
        assert len(captures._queue) == 1
        assert captures._queue[0].attempt == 3


def test_enqueue_re_enqueues_failed_done_with_force_true(monkeypatch, tmp_path):
    """failed + force_retry=true also auto re-enqueues (same rule)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-ff", code="005930", date="20260520",
                        phase="failed", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["enqueued"][0]["force_retry"] is True


def test_enqueue_re_enqueues_cancelled_done_regardless_of_force(monkeypatch, tmp_path):
    """cancelled-phase _done → auto re-enqueue regardless of force_retry."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-c", code="005930", date="20260520",
                        phase="cancelled", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["deduped"] == []
        assert all(s.item_id != "old-c" for s in captures._done)


def test_enqueue_dedupes_against_skipped_with_force_false(monkeypatch, tmp_path):
    """skipped + force_retry=false → already_skipped; _done untouched."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-s", code="005930", date="20260520",
                        phase="skipped", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"] == []
        assert body["deduped"][0]["reason"] == "already_skipped"
        assert any(s.item_id == "old-s" for s in captures._done)


def test_enqueue_re_enqueues_skipped_with_force_true(monkeypatch, tmp_path):
    """skipped + force_retry=true → auto re-enqueue (sentinel will be deleted by worker)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-sk", code="005930", date="20260520",
                        phase="skipped", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["enqueued"][0]["force_retry"] is True
        assert all(s.item_id != "old-sk" for s in captures._done)


def test_enqueue_publishes_capture_dismissed_event_for_auto_reenqueued_items(
    monkeypatch, tmp_path,
):
    """One CaptureDismissedEvent listing every old item_id, published before CaptureQueuedEvent."""
    from hoga.api.models import CaptureDismissedEvent, CaptureQueuedEvent
    _no_workers(monkeypatch)
    published: list = []
    monkeypatch.setattr(captures, "_publish_event", lambda e: published.append(e))

    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="f1", code="005930", date="20260520", phase="failed")
        _seed_done_item(item_id="c1", code="005930", date="20260521", phase="cancelled")

        r = _post_items(c, "005930", ["20260520", "20260521"], force_retry=False)
        assert r.status_code == 201, r.text

    dismissed = [e for e in published if isinstance(e, CaptureDismissedEvent)]
    queued = [e for e in published if isinstance(e, CaptureQueuedEvent)]
    assert len(dismissed) == 1
    assert sorted(dismissed[0].item_ids) == ["c1", "f1"]
    assert len(queued) == 1
    # Order: dismissed event must come before queued event in publish stream.
    dismissed_pos = published.index(dismissed[0])
    queued_pos = published.index(queued[0])
    assert dismissed_pos < queued_pos


def test_enqueue_re_enqueues_pause_origin_cancelled_via_cancelled_rule(
    monkeypatch, tmp_path,
):
    """pause_origin=True + phase=cancelled is just a cancelled item — auto re-enqueued like any other."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="po-1", code="005930", date="20260520",
                        phase="cancelled", pause_origin=True, attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        # New item starts with fresh pause_origin (default False) regardless of old.
        assert body["enqueued"][0]["pause_origin"] is False
        # Old pause_origin item removed from _done.
        assert all(s.item_id != "po-1" for s in captures._done)


def test_enqueue_uses_request_force_retry_not_old_item_force_retry(
    monkeypatch, tmp_path,
):
    """Old item had force_retry=True, request has force_retry=False → new force_retry == False."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-fr", code="005930", date="20260520",
                        phase="failed", force_retry=True, attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"][0]["force_retry"] is False  # request wins


def test_enqueue_response_includes_auto_reenqueued_items_in_enqueued_list(
    monkeypatch, tmp_path,
):
    """Response body's `enqueued` array contains BOTH fresh items (attempt=1) and auto-retried items (attempt>1)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="ret-1", code="005930", date="20260520",
                        phase="failed", attempt=1)
        # 20260521 is fresh (no _done entry)

        r = _post_items(c, "005930", ["20260520", "20260521"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 2
        by_date = {it["date"]: it for it in body["enqueued"]}
        assert by_date["20260520"]["attempt"] == 2  # auto-retried
        assert by_date["20260521"]["attempt"] == 1  # fresh
        assert body["deduped"] == []
```

### Step 2: Run the tests to verify they fail

```bash
uv run pytest tests/test_api_captures_queue.py -v -k "dedupes_against_done or re_enqueues or publishes_capture_dismissed_event_for_auto or pause_origin_cancelled_via or request_force_retry_not or response_includes_auto"
```

Expected: 11 FAIL (the dedupe loop doesn't yet inspect `_done`).

### Step 3: Implement the phase-aware `_done` dedupe in `enqueue_items`

In `hoga/api/captures.py`, locate the dedupe block at lines 1002-1034 (inside `enqueue_items`, the section starting `# 3. Q15 Layer 1 dedupe`).

Replace the entire dedupe block (lines 1002-1034) with the version below. Also add a new `done_dismissed_ids: list[str]` and modify the post-lock event publishing.

```python
        # 3. Q15 Layer 1 dedupe: against queue ∪ active ∪ inflight ∪ within-request,
        #    PLUS phase-aware dedupe against _done (ADR-0033).
        enqueued: list[QueueItemState] = []
        deduped_rows: list[EnqueueDedupedRow] = []
        done_dismissed_ids: list[str] = []
        enqueued_at_ms = int(time.time() * 1000)
        async with _lock:
            active_pairs = {(s.code, s.date) for s in _active.values()}
            queue_pairs = {(s.code, s.date) for s in _queue}
            existing_pairs = set(_inflight_paths) | queue_pairs | active_pairs
            # ADR-0033: phase-aware _done lookup.
            done_index: dict[tuple[str, str], tuple[int, QueueItemState]] = {
                (s.code, s.date): (i, s) for i, s in enumerate(_done)
            }
            done_indices_to_remove: set[int] = set()
            seen_in_request: set[tuple[str, str]] = set()

            for date in candidate_dates:
                pair = (req.code, date)
                # Step 3a: existing dedupe (queue/active/inflight + within-request).
                if pair in existing_pairs or pair in seen_in_request:
                    reason = (
                        "already_running" if pair in active_pairs
                        else "already_in_queue"
                    )
                    deduped_rows.append(EnqueueDedupedRow(
                        code=req.code, date=date, reason=reason,
                    ))
                    continue

                # Step 3b: ADR-0033 _done dedupe — branch by phase + force_retry.
                if pair in done_index:
                    idx, old = done_index[pair]
                    if (old.phase in ("failed", "cancelled")
                            or (old.phase == "skipped" and req.force_retry)):
                        # Auto re-enqueue: remove old, enqueue new with attempt+1.
                        done_indices_to_remove.add(idx)
                        done_dismissed_ids.append(old.item_id)
                        del done_index[pair]  # within-batch second hit will fall to fresh-enqueue or seen_in_request.
                        seen_in_request.add(pair)
                        new_state = QueueItemState(
                            item_id=_make_item_id(req.code, date),
                            code=req.code,
                            date=date,
                            force_retry=req.force_retry,
                            enqueued_at_ms=enqueued_at_ms,
                            attempt=old.attempt + 1,
                        )
                        _queue.append(new_state)
                        enqueued.append(new_state)
                        continue
                    # Dedupe as already_complete / already_skipped.
                    reason = (
                        "already_complete" if old.phase == "done"
                        else "already_skipped"  # phase == "skipped" and not force_retry
                    )
                    deduped_rows.append(EnqueueDedupedRow(
                        code=req.code, date=date, reason=reason,
                    ))
                    continue

                # Step 3c: fresh enqueue.
                seen_in_request.add(pair)
                state = QueueItemState(
                    item_id=_make_item_id(req.code, date),
                    code=req.code,
                    date=date,
                    force_retry=req.force_retry,
                    enqueued_at_ms=enqueued_at_ms,
                )
                _queue.append(state)
                enqueued.append(state)

            # Apply queued _done removals (reverse-sorted to preserve indices).
            for idx in sorted(done_indices_to_remove, reverse=True):
                del _done[idx]

            if enqueued and _wakeup is not None:
                _wakeup.set()
            _persist_queue_locked()  # ADR-0019 — still inside async with _lock

        # 4. Emit dismissed event FIRST (so frontend removes old rows before new rows appear),
        #    then queued event.
        if done_dismissed_ids:
            _publish_event(CaptureDismissedEvent(item_ids=done_dismissed_ids))
        if enqueued:
            _publish_event(CaptureQueuedEvent(items=[s.to_wire() for s in enqueued]))

        return EnqueueResponse(
            enqueued=[s.to_wire() for s in enqueued],
            deduped=deduped_rows,
        )
```

(`CaptureDismissedEvent` is already top-level imported in `hoga/api/captures.py` from the ADR-0031 work — no new import needed.)

### Step 4: Run the new tests to verify they pass

```bash
uv run pytest tests/test_api_captures_queue.py -v -k "dedupes_against_done or re_enqueues or publishes_capture_dismissed_event_for_auto or pause_origin_cancelled_via or request_force_retry_not or response_includes_auto"
```

Expected: 11 PASS.

### Step 5: Run the broader captures suite to confirm no regressions

```bash
uv run pytest tests/test_api_captures_queue.py tests/test_api_captures_persistence.py tests/test_api_captures_restore.py -v
```

Expected: all PASS.

### Step 6: Commit

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "$(cat <<'EOF'
feat(captures): addItems phase-aware _done dedupe (ADR-0033)

failed/cancelled _done rows are auto re-enqueued with attempt+1
regardless of force_retry. skipped re-enqueues only with force_retry=true.
done is always deduped as already_complete (decide_capture treats COMPLETE
as always-skip, so re-enqueueing would just produce SSE noise).

Publishes CaptureDismissedEvent before CaptureQueuedEvent so the frontend
SSE handler removes old rows before new rows land — single code path with
the explicit /items/retry flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual end-to-end smoke (optional)

**Files:** (runtime verification only — no source changes)

- [ ] **Step 1: Start dev servers**

Backend (with reload):

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

Frontend (separate terminal):

```bash
cd frontend && npm run dev
```

- [ ] **Step 2: Reproduce the scenario**

Open `http://localhost:5173/capture`. Enter `005930` with a small date range (e.g., 5 dates). Click Start. Wait for the queue to settle. Kill the backend mid-capture (Ctrl-C) to force at least one `failed` row. Restart backend.

- [ ] **Step 3: Re-submit the overlapping range**

Submit the same date range again (force_retry=false). Verify:
- The previously-failed row(s) disappear from the queue list (no duplicate rows).
- A new attempt appears at the top with `×2` badge.
- The previously-done row(s) are NOT re-enqueued — the response body's `deduped` array shows them with reason `already_complete`.

- [ ] **Step 4: Submit with force_retry=true on a skipped item**

If you have a `no_upstream_data` skipped item from prior testing, submit it again with `force_retry=true`. Verify: the skipped row disappears, a new attempt runs (which may produce skipped again with the same reason, but the row is fresh with `×2`).

- [ ] **Step 5: No commit needed**

Manual smoke produces no code. If issues are found, file them under the appropriate task above and add a regression test.

---

## Self-Review

Spec coverage check:

| Spec section | Implementing task |
|---|---|
| `EnqueueDedupedRow.reason` Literal extension | Task 1 |
| Frontend type mirror | Task 2 |
| Phase-aware `_done` dedupe in `enqueue_items` | Task 3 |
| Auto re-enqueue with `attempt+1` + request's `force_retry` | Task 3 (tests `_re_enqueues_failed`, `_uses_request_force_retry`) |
| `done` always-dedupe invariant | Task 3 (test `_dedupes_against_done_complete_with_force_true`) |
| `pause_origin` items auto re-enqueued via cancelled rule | Task 3 (test `_pause_origin_cancelled_via_cancelled_rule`) |
| `CaptureDismissedEvent` published before `CaptureQueuedEvent` | Task 3 (test `_publishes_capture_dismissed_event_for_auto_reenqueued_items`) |
| Response `enqueued` contains both fresh + retried items | Task 3 (test `_response_includes_auto_reenqueued_items_in_enqueued_list`) |
| `_done` mutation safety (reverse-sorted index deletion) | Task 3 (Step 3 implementation) |
| O(1) `_done` lookup via dict index | Task 3 (Step 3 implementation) |
| Manual scenario verification | Task 4 |

No spec requirements left uncovered. No placeholders.

---
scope: both
spec: docs/superpowers/specs/2026-05-28-capture-fail-streak-guard-design.md
adr: docs/adr/0042-capture-fail-streak-cap.md
---

# Capture Fail-Streak Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject `POST /api/captures/items` for any (Code, Stock-Date) with `fail_streak >= 5` (5 consecutive `failed`+`skipped` results since last success/unblock), persist the counter in `.queue.json`, expose `blocked` rows on the inventory API, and add a `잠금 해제` action that zeros the counter without auto-retrying.

**Architecture:** A per-(Code, Stock-Date) `fail_streaks: dict[str, int]` field is added to the `QueueManifest` Pydantic model and persisted via the existing atomic-write helper. Worker terminal phase writes (in `_finalize_item`) call `apply_terminal()` which mutates the dict. `enqueue_items_core` checks `is_blocked()` immediately after date expansion and before any dedupe logic (so ADR-0033 Implicit Retry never sees a blocked pair). A new `POST /api/captures/items/{code}/{date}/unblock` endpoint clears the counter. Inventory's `StockDate` model gains `fail_streak` + `blocked` fields, computed in one pass. Frontend adds `useInventoryUnblock` mirroring `useInventoryRecapture`, branches the inventory row UI on `blocked`, and surfaces `response.blocked[]` in `CaptureForm`.

**Tech Stack:** Python 3 / FastAPI / Pydantic v2 / pytest (backend); React 18 / TypeScript / TanStack Query v5 / Vitest / jsdom (frontend).

**Domain casing:** CONTEXT.md uses **Code**, **Stock-Date**, **Capture Queue**, **Retry**, **fail_streak**, **attempt_cap**. Use these in user-facing strings, comments, commit messages. Code identifiers stay `snake_case` / `camelCase` per language convention.

**Backwards-compat policy:**
- `.queue.json` written before this lands has no `fail_streaks` key. Pydantic `Field(default_factory=dict)` makes the loader treat missing as empty — no migration script.
- `EnqueueResponse.blocked` is a new field with default `[]`. Old typed Python clients re-pin schemas; old JS clients see an extra field and ignore it (Pydantic emits even when empty, so the field is always present in responses going forward).
- `StockDate.fail_streak` / `StockDate.blocked` similarly default. Old frontend builds ignore unknown fields.
- The new unblock endpoint is purely additive. No path collision (see Task 9 for the exact route registration check).

---

## Task 1: Extend `QueueManifest` with `fail_streaks` (Pydantic schema)

**Files:**
- Modify: `hoga/api/models.py` (around the `QueueManifest` definition, models.py:285-293)
- Test: `tests/test_api_captures_persistence.py` (existing file — append tests)

- [ ] **Step 1: Read the current QueueManifest definition**

Run: `grep -n "class QueueManifest" hoga/api/models.py`
Confirm the class spans roughly lines 285-293 with fields `schema_version`, `paused`, `items`.

- [ ] **Step 2: Write failing test — `fail_streaks` defaults to empty dict on old manifests**

Append to `tests/test_api_captures_persistence.py`:

```python
def test_load_manifest_without_fail_streaks_defaults_to_empty(tmp_path):
    """Old .queue.json files lack the fail_streaks key; loader must treat as empty dict."""
    from hoga.api.captures_persistence import load_manifest, manifest_path

    # Write a manifest in the OLD shape (no fail_streaks key).
    manifest_path(tmp_path).write_text(
        '{"schema_version": 1, "paused": false, "items": []}',
        encoding="utf-8",
    )

    loaded = load_manifest(tmp_path)
    assert loaded is not None
    assert loaded.fail_streaks == {}


def test_save_load_manifest_roundtrip_preserves_fail_streaks(tmp_path):
    from hoga.api.captures_persistence import load_manifest, save_manifest
    from hoga.api.models import QueueManifest

    saved = QueueManifest(
        paused=False,
        items=[],
        fail_streaks={"005930|20260520": 3, "003490|20260319": 5},
    )
    save_manifest(tmp_path, saved)

    loaded = load_manifest(tmp_path)
    assert loaded is not None
    assert loaded.fail_streaks == {"005930|20260520": 3, "003490|20260319": 5}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_captures_persistence.py -k fail_streaks -v`
Expected: FAIL with `AttributeError: 'QueueManifest' object has no attribute 'fail_streaks'` (or Pydantic validation error).

- [ ] **Step 4: Add the field to `QueueManifest`**

In `hoga/api/models.py`, modify `QueueManifest`:

```python
from pydantic import BaseModel, Field

class QueueManifest(BaseModel):
    schema_version: int = 1
    paused: bool
    items: list[QueueManifestItem]
    fail_streaks: dict[str, int] = Field(default_factory=dict)
    """Per-(Code, Stock-Date) consecutive failed+skipped counter.

    Key format: "{code}|{date}". Missing key means 0. Reset on
    `phase == done` or unblock. ADR-0042.
    """
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_captures_persistence.py -k fail_streaks -v`
Expected: 2 passed.

- [ ] **Step 6: Run the whole persistence test suite to confirm no regression**

Run: `uv run pytest tests/test_api_captures_persistence.py -v`
Expected: all green (existing tests still pass — `fail_streaks` has a default so existing fixtures don't need updates).

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py tests/test_api_captures_persistence.py
git commit -m "feat(captures): add fail_streaks dict to QueueManifest (ADR-0042)"
```

---

## Task 2: Add fail_streak helpers (read / is_blocked / key format)

**Files:**
- Create: `hoga/api/fail_streak.py` (small, focused module — easier to test in isolation than embedding in captures.py)
- Test: `tests/unit/live/test_fail_streak.py` (new file matching `tests/unit/live/` convention)

- [ ] **Step 1: Write failing tests for `streak_key`, `read_fail_streak`, `is_blocked`**

Create `tests/unit/live/test_fail_streak.py`:

```python
"""Unit tests for hoga.api.fail_streak (ADR-0042 read-side helpers)."""

from hoga.api.fail_streak import ATTEMPT_CAP, is_blocked, read_fail_streak, streak_key
from hoga.api.models import QueueManifest


def test_streak_key_format():
    assert streak_key("005930", "20260520") == "005930|20260520"


def test_read_fail_streak_missing_key_returns_zero():
    m = QueueManifest(paused=False, items=[])
    assert read_fail_streak(m, "005930", "20260520") == 0


def test_read_fail_streak_present_returns_value():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 3})
    assert read_fail_streak(m, "005930", "20260520") == 3


def test_attempt_cap_is_5():
    assert ATTEMPT_CAP == 5


def test_is_blocked_below_threshold():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    assert is_blocked(m, "005930", "20260520") is False


def test_is_blocked_at_threshold():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 5})
    assert is_blocked(m, "005930", "20260520") is True


def test_is_blocked_above_threshold():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 6})
    assert is_blocked(m, "005930", "20260520") is True


def test_is_blocked_missing_key_is_false():
    m = QueueManifest(paused=False, items=[])
    assert is_blocked(m, "005930", "20260520") is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_fail_streak.py -v`
Expected: collection error or import error — module doesn't exist yet.

- [ ] **Step 3: Create the module**

Create `hoga/api/fail_streak.py`:

```python
"""Per-(Code, Stock-Date) consecutive failed+skipped counter.

The counter lives in QueueManifest.fail_streaks (ADR-0042). This module
provides pure read-side helpers; write-side (apply_terminal, clear_for_unblock)
lives in captures.py because it must coordinate with the manifest lock.
"""

from hoga.api.models import QueueManifest

ATTEMPT_CAP = 5
"""Exclusive upper bound on fail_streak for enqueue acceptance.

`fail_streak >= ATTEMPT_CAP` ⇒ blocked. Concretely: 5 consecutive
failed+skipped results are allowed; the 6th enqueue is rejected.
ADR-0042 "When to revisit" — promoting to Settings is deferred.
"""


def streak_key(code: str, date: str) -> str:
    """Canonical key into QueueManifest.fail_streaks."""
    return f"{code}|{date}"


def read_fail_streak(manifest: QueueManifest, code: str, date: str) -> int:
    """Return current fail_streak for (code, date). Missing key → 0."""
    return manifest.fail_streaks.get(streak_key(code, date), 0)


def is_blocked(manifest: QueueManifest, code: str, date: str) -> bool:
    return read_fail_streak(manifest, code, date) >= ATTEMPT_CAP
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/unit/live/test_fail_streak.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/fail_streak.py tests/unit/live/test_fail_streak.py
git commit -m "feat(captures): fail_streak read helpers + ATTEMPT_CAP=5 (ADR-0042)"
```

---

## Task 3: Worker terminal hook — `apply_terminal()` mutates the counter

**Files:**
- Modify: `hoga/api/captures.py` (around `_finalize_item`, captures.py:745-755)
- Test: `tests/unit/live/test_fail_streak_terminal.py` (new — keeps fail_streak tests grouped)

**Background:** `_finalize_item` is the single place where the worker writes a terminal entry to `_done` (captures.py:752 `_done.append(state)`). The restore path at captures.py:386 also appends to `_done` but it is *re-loading* already-counted history — must NOT call `apply_terminal` there.

- [ ] **Step 1: Write failing tests for `apply_terminal`**

Create `tests/unit/live/test_fail_streak_terminal.py`:

```python
"""Unit tests for apply_terminal — worker terminal hook (ADR-0042)."""

import pytest

from hoga.api.captures import apply_terminal_to_manifest
from hoga.api.models import QueueManifest


def _empty() -> QueueManifest:
    return QueueManifest(paused=False, items=[], fail_streaks={})


def test_done_resets_counter_to_zero():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done")
    assert m.fail_streaks.get("005930|20260520", 0) == 0


def test_done_removes_zero_key_to_keep_manifest_tidy():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done")
    assert "005930|20260520" not in m.fail_streaks


def test_failed_increments_from_missing():
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    assert m.fail_streaks["005930|20260520"] == 1


def test_failed_increments_from_existing():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 3})
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    assert m.fail_streaks["005930|20260520"] == 4


def test_skipped_increments_alongside_failed():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 2})
    apply_terminal_to_manifest(m, "005930", "20260520", "skipped")
    assert m.fail_streaks["005930|20260520"] == 3


def test_cancelled_does_not_change_counter():
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 3})
    apply_terminal_to_manifest(m, "005930", "20260520", "cancelled")
    assert m.fail_streaks["005930|20260520"] == 3


def test_cancelled_does_not_create_key_when_absent():
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "cancelled")
    assert "005930|20260520" not in m.fail_streaks


def test_unknown_phase_raises():
    m = _empty()
    with pytest.raises(ValueError, match="unexpected terminal phase"):
        apply_terminal_to_manifest(m, "005930", "20260520", "queued")  # non-terminal


def test_each_code_date_pair_is_independent():
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    apply_terminal_to_manifest(m, "003490", "20260319", "failed")
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    assert m.fail_streaks["005930|20260520"] == 2
    assert m.fail_streaks["003490|20260319"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_fail_streak_terminal.py -v`
Expected: ImportError on `apply_terminal_to_manifest`.

- [ ] **Step 3: Add `apply_terminal_to_manifest` to captures.py**

In `hoga/api/captures.py`, add near the other manifest helpers (search for `save_manifest` import; place the function above `_finalize_item`):

```python
def apply_terminal_to_manifest(
    manifest: QueueManifest,
    code: str,
    date: str,
    phase: str,
) -> None:
    """Mutate manifest.fail_streaks according to a worker terminal phase.

    - phase == "done"             → counter reset to 0 (key removed for tidiness)
    - phase in {"failed", "skipped"} → counter += 1
    - phase == "cancelled"        → no change (user-initiated; external-call status unknown)
    - any other phase             → ValueError (programmer bug — phase enum is closed)

    ADR-0042. Caller is responsible for persisting the manifest after this call.
    """
    from hoga.api.fail_streak import streak_key

    key = streak_key(code, date)
    if phase == "done":
        manifest.fail_streaks.pop(key, None)
    elif phase in ("failed", "skipped"):
        manifest.fail_streaks[key] = manifest.fail_streaks.get(key, 0) + 1
    elif phase == "cancelled":
        pass
    else:
        raise ValueError(f"unexpected terminal phase: {phase!r}")
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `uv run pytest tests/unit/live/test_fail_streak_terminal.py -v`
Expected: 9 passed.

- [ ] **Step 5: Wire `apply_terminal_to_manifest` into `_finalize_item`**

Locate `_finalize_item` in `hoga/api/captures.py` (around line 745). Find the existing `_done.append(state)` line (~line 752). Immediately after the append, add:

```python
apply_terminal_to_manifest(_manifest_snapshot(), state.code, state.date, state.phase)
save_manifest(data_dir, _manifest_snapshot())
```

If `_manifest_snapshot()` is not the actual helper name in this codebase, use whatever helper currently materializes the in-memory manifest (search for `QueueManifest(` constructions in captures.py to find it). The existing code already calls `save_manifest` somewhere in `_finalize_item` or its caller — check whether your mutation can piggyback on that single write instead of doing two writes. **Read the surrounding code first**; only add a second `save_manifest` if no existing call covers the new mutation.

- [ ] **Step 6: Write an integration test that exercises the worker path**

Append to `tests/unit/live/test_fail_streak_terminal.py`:

```python
def test_finalize_item_failed_increments_persisted_counter(tmp_path, monkeypatch):
    """End-to-end: worker hits _finalize_item with a failed state →
    counter increments AND the new manifest is persisted to .queue.json."""
    from hoga.api.captures import _finalize_item  # noqa: PLC0415
    from hoga.api.captures_persistence import load_manifest

    # Set the data_dir and seed a manifest with the counter at 2.
    # (Use whatever fixture/helper the existing captures.py tests use to bootstrap
    # the module-level _data_dir / _manifest state. See
    # tests/unit/live/test_captures*.py for the pattern.)
    # ... (adapt to existing test bootstrap)

    # After _finalize_item runs on a failed state for (005930, 20260520),
    # the persisted manifest's counter for that key must equal 3.
    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert persisted.fail_streaks.get("005930|20260520") == 3
```

If wiring this integration test requires non-trivial bootstrap, leave a `pytest.mark.skip(reason="bootstrap helper TBD in Task 3 follow-up")` and open an inline TODO — **do not skip silently**.

- [ ] **Step 7: Run tests**

Run: `uv run pytest tests/unit/live/test_fail_streak_terminal.py tests/unit/live/test_fail_streak.py -v`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/captures.py tests/unit/live/test_fail_streak_terminal.py
git commit -m "feat(captures): apply_terminal hook on _finalize_item — increments fail_streak (ADR-0042)"
```

---

## Task 4: `BlockedItem` model + extend `EnqueueResponse.blocked`

**Files:**
- Modify: `hoga/api/models.py` (near `EnqueueDedupedRow`, models.py:307-320)
- Test: `tests/unit/live/test_models_blocked.py` (new — focused model tests)

- [ ] **Step 1: Write failing test for `BlockedItem` shape**

Create `tests/unit/live/test_models_blocked.py`:

```python
"""Tests for BlockedItem and EnqueueResponse.blocked (ADR-0042)."""

from hoga.api.models import BlockedItem, EnqueueResponse


def test_blocked_item_shape():
    b = BlockedItem(code="005930", date="20260520", fail_streak=5, reason="fail_streak_exceeded")
    assert b.code == "005930"
    assert b.date == "20260520"
    assert b.fail_streak == 5
    assert b.reason == "fail_streak_exceeded"


def test_enqueue_response_blocked_defaults_empty():
    """Old code paths that construct EnqueueResponse without blocked= still work."""
    r = EnqueueResponse(enqueued=[], deduped=[])
    assert r.blocked == []


def test_enqueue_response_with_blocked():
    r = EnqueueResponse(
        enqueued=[],
        deduped=[],
        blocked=[BlockedItem(code="003490", date="20260319", fail_streak=5, reason="fail_streak_exceeded")],
    )
    assert len(r.blocked) == 1
    assert r.blocked[0].fail_streak == 5
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_models_blocked.py -v`
Expected: ImportError on `BlockedItem`.

- [ ] **Step 3: Add `BlockedItem` and extend `EnqueueResponse`**

In `hoga/api/models.py`, just below `EnqueueDedupedRow` (around line 315) and before `EnqueueResponse` (line 318):

```python
class BlockedItem(BaseModel):
    """A (Code, Stock-Date) rejected by the fail_streak cap (ADR-0042)."""

    code: str
    date: str
    fail_streak: int
    reason: Literal["fail_streak_exceeded"]
```

Then modify `EnqueueResponse`:

```python
class EnqueueResponse(BaseModel):
    enqueued: list[QueueItem]
    deduped: list[EnqueueDedupedRow]
    blocked: list[BlockedItem] = Field(default_factory=list)
```

If `Literal` and `Field` are not already imported at the top of `models.py`, add them: `from typing import Literal` and `from pydantic import BaseModel, Field`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/unit/live/test_models_blocked.py -v`
Expected: 3 passed.

- [ ] **Step 5: Run all model tests to confirm no regression**

Run: `uv run pytest tests/ -k "models" -v`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py tests/unit/live/test_models_blocked.py
git commit -m "feat(api): BlockedItem model + EnqueueResponse.blocked field (ADR-0042)"
```

---

## Task 5: `enqueue_items_core` guard — reject blocked pairs BEFORE dedupe

**Files:**
- Modify: `hoga/api/captures.py` (`enqueue_items_core`, around captures.py:1144-1287)
- Test: `tests/unit/live/test_api.py` (existing file — append) or new `tests/unit/live/test_enqueue_blocked.py`

**Critical:** the new guard must run **after** date expansion (so we have concrete dates) but **before** ADR-0033 dedupe (so a blocked pair never reaches Implicit Retry). Concretely: insert between captures.py:1190 (end of date expansion) and captures.py:1208 (start of dedupe). Verify the exact line numbers before editing — the file may have shifted since the spec was written.

- [ ] **Step 1: Write failing tests for the guard**

Create `tests/unit/live/test_enqueue_blocked.py`:

```python
"""Tests for enqueue_items_core's fail_streak guard (ADR-0042).

The guard runs BEFORE ADR-0033 dedupe — a blocked (Code, Stock-Date)
must never reach the Implicit Retry table even with force_retry=true.
"""

import datetime as dt

import pytest

from hoga.api.captures import enqueue_items_core
from hoga.api.models import EnqueueRequest


# Each test seeds the module's manifest with fail_streaks={"005930|20260520": N}
# using whatever bootstrap the existing test_api.py tests use. The exact helper
# name lives in the existing tests — copy that pattern.

@pytest.mark.asyncio
async def test_pair_at_streak_4_is_accepted(tmp_path, seeded_manifest):
    seeded_manifest({"005930|20260520": 4})
    req = EnqueueRequest(code="005930", dates=["20260520"], force_retry=False)
    resp = await enqueue_items_core(req, data_dir=tmp_path, now=_now())
    assert len(resp.enqueued) == 1
    assert resp.blocked == []


@pytest.mark.asyncio
async def test_pair_at_streak_5_is_blocked(tmp_path, seeded_manifest):
    seeded_manifest({"005930|20260520": 5})
    req = EnqueueRequest(code="005930", dates=["20260520"], force_retry=False)
    resp = await enqueue_items_core(req, data_dir=tmp_path, now=_now())
    assert resp.enqueued == []
    assert len(resp.blocked) == 1
    assert resp.blocked[0].code == "005930"
    assert resp.blocked[0].date == "20260520"
    assert resp.blocked[0].fail_streak == 5
    assert resp.blocked[0].reason == "fail_streak_exceeded"


@pytest.mark.asyncio
async def test_force_retry_does_NOT_bypass_guard(tmp_path, seeded_manifest):
    """force_retry controls disk-cache bypass; it does NOT override the cap.
    This is the whole point of ADR-0042."""
    seeded_manifest({"005930|20260520": 5})
    req = EnqueueRequest(code="005930", dates=["20260520"], force_retry=True)
    resp = await enqueue_items_core(req, data_dir=tmp_path, now=_now())
    assert resp.enqueued == []
    assert len(resp.blocked) == 1


@pytest.mark.asyncio
async def test_mixed_request_some_accepted_some_blocked(tmp_path, seeded_manifest):
    """Partial-success pattern (ADR-0033) preserved — one request can produce
    enqueued + blocked + deduped simultaneously."""
    seeded_manifest({"005930|20260520": 5})
    req = EnqueueRequest(code="005930", dates=["20260520", "20260521"], force_retry=False)
    resp = await enqueue_items_core(req, data_dir=tmp_path, now=_now())
    assert len(resp.enqueued) == 1
    assert resp.enqueued[0].date == "20260521"
    assert len(resp.blocked) == 1
    assert resp.blocked[0].date == "20260520"


@pytest.mark.asyncio
async def test_guard_runs_before_done_dedupe(tmp_path, seeded_manifest, seeded_done):
    """If a (code, date) is BOTH blocked AND in _done with phase=failed
    (which ADR-0033 would normally auto-re-enqueue), the response must
    say BLOCKED, not deduped — the guard must run first."""
    seeded_manifest({"005930|20260520": 5})
    seeded_done(code="005930", date="20260520", phase="failed")
    req = EnqueueRequest(code="005930", dates=["20260520"], force_retry=False)
    resp = await enqueue_items_core(req, data_dir=tmp_path, now=_now())
    assert len(resp.blocked) == 1
    assert resp.enqueued == []
    assert resp.deduped == []


def _now() -> dt.datetime:
    return dt.datetime(2026, 5, 28, 12, 0, tzinfo=dt.timezone.utc)
```

If `seeded_manifest` / `seeded_done` fixtures don't already exist in `tests/unit/live/`, look at how `test_api.py` seeds module state and copy that pattern into `conftest.py` next to the new test file. **Do not** invent a brand-new bootstrap — match the existing style.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_enqueue_blocked.py -v`
Expected: fixture errors or assertion failures — guard not implemented.

- [ ] **Step 3: Read the actual current shape of `enqueue_items_core` once more**

Run: `awk 'NR>=1140 && NR<=1290' hoga/api/captures.py | head -160`

Find:
- the line where `candidate_dates` (or equivalent post-expansion list) is finalized
- the start of the dedupe loop (the place that iterates `_queue ∪ _active ∪ _inflight_paths`)

The new guard goes between those two.

- [ ] **Step 4: Insert the guard**

After date expansion and the Q14 guard (which already exists, ~captures.py:1197-1206), insert:

```python
# ADR-0042: reject (Code, Stock-Date) with fail_streak >= ATTEMPT_CAP
# BEFORE ADR-0033 dedupe — a blocked pair must never reach Implicit Retry.
from hoga.api.fail_streak import is_blocked, read_fail_streak  # noqa: PLC0415

blocked_items: list[BlockedItem] = []
remaining_pairs = []
manifest_snapshot = _manifest_snapshot()  # use existing helper
for code, date in candidate_pairs:  # match existing variable name
    if is_blocked(manifest_snapshot, code, date):
        blocked_items.append(
            BlockedItem(
                code=code,
                date=date,
                fail_streak=read_fail_streak(manifest_snapshot, code, date),
                reason="fail_streak_exceeded",
            )
        )
    else:
        remaining_pairs.append((code, date))

# Replace the iterable consumed by the dedupe loop with remaining_pairs.
```

Then extend the response build site:

```python
return EnqueueResponse(
    enqueued=enqueued,
    deduped=deduped,
    blocked=blocked_items,
)
```

Add `BlockedItem` to the top-of-file imports.

If the actual code uses `req.code + dates` rather than a `candidate_pairs` list, adapt the variable names — the semantic intent (filter before dedupe) is what matters.

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/unit/live/test_enqueue_blocked.py -v`
Expected: all 5 passed.

- [ ] **Step 6: Run the full captures test suite to catch regressions**

Run: `uv run pytest tests/unit/live/ tests/test_api_captures_persistence.py -v`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/captures.py tests/unit/live/test_enqueue_blocked.py
git commit -m "feat(captures): enqueue_items_core rejects blocked pairs before dedupe (ADR-0042)"
```

---

## Task 6: HTTP status code policy — 409 if all blocked, 201 otherwise

**Files:**
- Modify: `hoga/api/captures.py` (the FastAPI route that calls `enqueue_items_core` — search for `@router.post("/items"` or similar) — likely lives near captures.py:1321-1328 per the spec's reference.
- Test: `tests/unit/live/test_enqueue_blocked.py` (append HTTP-level tests using FastAPI TestClient — match pattern from `tests/unit/live/test_api.py`)

- [ ] **Step 1: Write failing HTTP-level tests**

Append to `tests/unit/live/test_enqueue_blocked.py`:

```python
def test_http_409_when_all_pairs_blocked(client, seeded_manifest):
    """If every requested (Code, Stock-Date) is blocked, the request itself
    was wholly rejected — return 409."""
    seeded_manifest({"005930|20260520": 5})
    r = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520"], "force_retry": False,
    })
    assert r.status_code == 409
    body = r.json()
    assert len(body["blocked"]) == 1
    assert body["enqueued"] == []


def test_http_201_when_partial_block(client, seeded_manifest):
    """Mixed request: some accepted, some blocked → 201 (partial-success per ADR-0033)."""
    seeded_manifest({"005930|20260520": 5})
    r = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520", "20260521"], "force_retry": False,
    })
    assert r.status_code == 201
    body = r.json()
    assert len(body["blocked"]) == 1
    assert len(body["enqueued"]) == 1
```

If `client` fixture doesn't exist, use the same FastAPI TestClient bootstrap as `tests/unit/live/test_api.py`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_enqueue_blocked.py -k http -v`
Expected: 409 test fails (route still returns 201 unconditionally).

- [ ] **Step 3: Add the status-code branch in the route handler**

Locate the route handler (search: `grep -n "enqueue_items_core" hoga/api/captures.py | head -5`). The handler is the FastAPI function that calls `enqueue_items_core` and returns a Response. Change its return so:

```python
from fastapi import Response

resp = await enqueue_items_core(req, data_dir=data_dir, now=now)
if resp.blocked and not resp.enqueued and not resp.deduped:
    return Response(
        content=resp.model_dump_json(),
        media_type="application/json",
        status_code=409,
    )
return resp  # default 201 from existing route declaration
```

If the route already uses `JSONResponse` or a different pattern, adapt — keep the semantic: all-blocked → 409, otherwise current behaviour.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/unit/live/test_enqueue_blocked.py -v`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/unit/live/test_enqueue_blocked.py
git commit -m "feat(api): 409 when all pairs blocked, 201 otherwise (ADR-0042)"
```

---

## Task 7: Unblock endpoint — `POST /api/captures/items/{code}/{date}/unblock`

**Files:**
- Modify: `hoga/api/captures.py` (add the new route + a `clear_for_unblock` helper next to `apply_terminal_to_manifest`)
- Test: `tests/unit/live/test_unblock_endpoint.py` (new)

- [ ] **Step 1: Write failing tests**

Create `tests/unit/live/test_unblock_endpoint.py`:

```python
"""Tests for POST /api/captures/items/{code}/{date}/unblock (ADR-0042)."""

import pytest


def test_unblock_clears_counter(client, seeded_manifest):
    seeded_manifest({"005930|20260520": 5})
    r = client.post("/api/captures/items/005930/20260520/unblock")
    assert r.status_code == 200
    body = r.json()
    assert body == {"code": "005930", "date": "20260520", "fail_streak": 0, "action": "unblocked"}


def test_unblock_already_zero_is_noop(client, seeded_manifest):
    seeded_manifest({})  # empty
    r = client.post("/api/captures/items/005930/20260520/unblock")
    assert r.status_code == 200
    assert r.json() == {"code": "005930", "date": "20260520", "fail_streak": 0, "action": "noop"}


def test_unblock_persists_to_manifest(client, seeded_manifest, tmp_path):
    from hoga.api.captures_persistence import load_manifest
    seeded_manifest({"005930|20260520": 4})
    client.post("/api/captures/items/005930/20260520/unblock")
    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert persisted.fail_streaks.get("005930|20260520", 0) == 0


def test_unblock_after_then_enqueue_succeeds(client, seeded_manifest):
    """Unblock followed by enqueue produces a successful enqueue (no 409)."""
    seeded_manifest({"005930|20260520": 5})
    client.post("/api/captures/items/005930/20260520/unblock")
    r = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520"], "force_retry": False,
    })
    assert r.status_code == 201
    assert len(r.json()["enqueued"]) == 1


def test_unblock_invalid_code_returns_400(client):
    r = client.post("/api/captures/items/INVALID/20260520/unblock")
    assert r.status_code == 422 or r.status_code == 400  # FastAPI validation


def test_unblock_does_not_touch_other_keys(client, seeded_manifest, tmp_path):
    from hoga.api.captures_persistence import load_manifest
    seeded_manifest({"005930|20260520": 5, "003490|20260319": 3})
    client.post("/api/captures/items/005930/20260520/unblock")
    persisted = load_manifest(tmp_path)
    assert persisted.fail_streaks.get("003490|20260319") == 3
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_unblock_endpoint.py -v`
Expected: 404 on the unblock route (not registered).

- [ ] **Step 3: Add `clear_for_unblock` helper**

In `hoga/api/captures.py`, next to `apply_terminal_to_manifest`:

```python
def clear_for_unblock(manifest: QueueManifest, code: str, date: str) -> bool:
    """Zero the fail_streak for (code, date). Returns True if a change was made,
    False if already zero (idempotent noop). Caller persists. ADR-0042."""
    from hoga.api.fail_streak import streak_key

    key = streak_key(code, date)
    if key in manifest.fail_streaks:
        del manifest.fail_streaks[key]
        return True
    return False
```

- [ ] **Step 4: Register the route**

In the same `captures.py` (near the other `@router.post` declarations for `/items`):

```python
from pydantic import BaseModel
from typing import Literal


class UnblockResponse(BaseModel):
    code: str
    date: str
    fail_streak: Literal[0] = 0
    action: Literal["unblocked", "noop"]


# Constrain code to 6 ASCII digits matching the EnqueueRequest pattern.
from fastapi import Path

@router.post("/items/{code}/{date}/unblock", response_model=UnblockResponse)
async def unblock_item(
    code: str = Path(pattern=r"^[0-9]{6}$"),
    date: str = Path(pattern=r"^[0-9]{8}$"),
) -> UnblockResponse:
    """ADR-0042: zero the fail_streak counter for (code, date). Idempotent."""
    async with _manifest_lock():  # use existing lock helper
        manifest = _manifest_snapshot()
        changed = clear_for_unblock(manifest, code, date)
        if changed:
            try:
                save_manifest(_data_dir(), manifest)
            except OSError as exc:
                raise HTTPException(status_code=500, detail={"error": "unblock_persistence_failed"}) from exc
    return UnblockResponse(code=code, date=date, action="unblocked" if changed else "noop")
```

If `_manifest_lock` / `_data_dir` are not the actual helpers in this codebase, find the equivalent by reading the existing `cancel-all` or `queue/resume` handlers — they perform the same shape of "mutate manifest + atomic write". Match that pattern.

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/unit/live/test_unblock_endpoint.py -v`
Expected: all green.

- [ ] **Step 6: Run full backend suite**

Run: `uv run pytest tests/ -v`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/captures.py tests/unit/live/test_unblock_endpoint.py
git commit -m "feat(api): POST /api/captures/items/{code}/{date}/unblock (ADR-0042)"
```

---

## Task 8: Inventory response — add `fail_streak` + `blocked` to `StockDate`

**Files:**
- Modify: `hoga/api/models.py` (`StockDate`, models.py:17-56)
- Modify: `hoga/api/routes.py` (`stock_dates()` handler at routes.py:53-55)
- Modify: `hoga/queries.py` (`QueryEngine.list_stock_dates` — the function that builds `StockDate` rows from disk)
- Test: `tests/test_queries.py` or appropriate existing file, plus a new HTTP-level test in `tests/unit/live/test_inventory_fields.py`

- [ ] **Step 1: Add fields to `StockDate` model**

In `hoga/api/models.py`, add to `StockDate`:

```python
class StockDate(BaseModel):
    # ... existing fields ...
    fail_streak: int = 0
    blocked: bool = False
```

Both default — old constructors and serializations stay valid.

- [ ] **Step 2: Write failing test for inventory annotation**

Create `tests/unit/live/test_inventory_fields.py`:

```python
"""Tests for inventory list endpoint annotating rows with fail_streak + blocked (ADR-0042)."""


def test_inventory_row_has_fail_streak_zero_by_default(client, seeded_manifest, seeded_inventory):
    seeded_inventory(code="005930", date="20260520")
    seeded_manifest({})
    r = client.get("/api/stock-dates")
    assert r.status_code == 200
    row = next(x for x in r.json() if x["code"] == "005930" and x["date"] == "20260520")
    assert row["fail_streak"] == 0
    assert row["blocked"] is False


def test_inventory_row_reflects_manifest_counter(client, seeded_manifest, seeded_inventory):
    seeded_inventory(code="005930", date="20260520")
    seeded_manifest({"005930|20260520": 3})
    r = client.get("/api/stock-dates")
    row = next(x for x in r.json() if x["code"] == "005930" and x["date"] == "20260520")
    assert row["fail_streak"] == 3
    assert row["blocked"] is False


def test_inventory_row_blocked_at_threshold(client, seeded_manifest, seeded_inventory):
    seeded_inventory(code="005930", date="20260520")
    seeded_manifest({"005930|20260520": 5})
    r = client.get("/api/stock-dates")
    row = next(x for x in r.json() if x["code"] == "005930" and x["date"] == "20260520")
    assert row["fail_streak"] == 5
    assert row["blocked"] is True
```

`seeded_inventory` fixture creates a fake parquet/meta for one row so the existing query engine returns it — match the pattern from existing `tests/test_queries.py`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/unit/live/test_inventory_fields.py -v`
Expected: fail_streak is 0 even when manifest has a counter (annotation not wired).

- [ ] **Step 4: Annotate rows in the handler**

In `hoga/api/routes.py`'s `stock_dates()` (or in `QueryEngine.list_stock_dates` — whichever currently builds the list), add a single pass that joins manifest's `fail_streaks` dict:

```python
from hoga.api.captures_persistence import load_manifest
from hoga.api.fail_streak import ATTEMPT_CAP, streak_key

rows = query_engine.list_stock_dates()
manifest = load_manifest(data_dir)
fail_streaks = manifest.fail_streaks if manifest else {}
for row in rows:
    row.fail_streak = fail_streaks.get(streak_key(row.code, row.date), 0)
    row.blocked = row.fail_streak >= ATTEMPT_CAP
return rows
```

If `load_manifest` is heavy or the route is hot, cache the manifest read for the request scope. Don't over-engineer — a single per-request `load_manifest` call is fine because the file is tiny.

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/unit/live/test_inventory_fields.py -v`
Expected: all green.

- [ ] **Step 6: Run full suite**

Run: `uv run pytest tests/ -v`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py hoga/api/routes.py hoga/queries.py tests/unit/live/test_inventory_fields.py
git commit -m "feat(inventory): annotate rows with fail_streak + blocked (ADR-0042)"
```

---

## Task 9: Backend integration check — full pytest + manual unblock smoke

**Files:** None modified. This is a verification gate before flipping to frontend.

- [ ] **Step 1: Run the full backend test suite**

Run: `uv run pytest -v`
Expected: all green.

- [ ] **Step 2: Boot the dev server and smoke-test the unblock route**

Start the backend per CLAUDE.md:

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga &
sleep 3
```

Then:

```bash
# Try unblock on an arbitrary (code, date) that has never been touched.
curl -s -X POST http://127.0.0.1:8000/api/captures/items/005930/20260520/unblock | jq
# Expected: {"code":"005930","date":"20260520","fail_streak":0,"action":"noop"}

# Hit inventory and confirm the new fields are present (pick any row).
curl -s http://127.0.0.1:8000/api/stock-dates | jq '.[0] | {code, date, fail_streak, blocked}'
# Expected: row has fail_streak (int) and blocked (bool) fields.

# Stop the dev server.
kill %1 2>/dev/null || true
```

If any of these don't return the expected shape, stop and investigate before proceeding to frontend.

- [ ] **Step 3: Commit (only if checkpoint commit desired)**

No file changes — skip if nothing to commit.

---

## Task 10: Frontend `useInventoryUnblock` hook

**Files:**
- Create: `frontend/src/inventory/useInventoryUnblock.ts`
- Test: `frontend/src/inventory/useInventoryUnblock.test.ts`

- [ ] **Step 1: Read the existing mirror**

Run: `cat frontend/src/inventory/useInventoryRecapture.ts`
Confirm the TanStack Query mutation + invalidation pattern.

- [ ] **Step 2: Locate the inventory query key**

Run: `grep -rn "stock-dates\|stockDates" frontend/src/inventory/ | head`
Find the `useQuery({queryKey: [...]})` that drives the inventory list (likely `useStockDates`). Record the exact key — `useInventoryUnblock` must invalidate it.

- [ ] **Step 3: Write failing test**

Create `frontend/src/inventory/useInventoryUnblock.test.ts`:

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInventoryUnblock } from './useInventoryUnblock';

describe('useInventoryUnblock', () => {
  it('POSTs to the unblock endpoint and invalidates the inventory query', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        code: '005930', date: '20260520', fail_streak: 0, action: 'unblocked',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInventoryUnblock(), { wrapper });

    await result.current.unblock.mutateAsync({ code: '005930', date: '20260520' });

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/captures/items/005930/20260520/unblock',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: /* paste the inventory query key found in Step 2 */ ['stock-dates'],
      });
    });
  });

  it('treats action=noop the same as action=unblocked', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        code: '005930', date: '20260520', fail_streak: 0, action: 'noop',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInventoryUnblock(), { wrapper });
    await result.current.unblock.mutateAsync({ code: '005930', date: '20260520' });
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd frontend && npx vitest run src/inventory/useInventoryUnblock.test.ts`
Expected: module not found.

- [ ] **Step 5: Implement the hook**

Create `frontend/src/inventory/useInventoryUnblock.ts`:

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';

type UnblockArgs = { code: string; date: string };
type UnblockResponse = {
  code: string;
  date: string;
  fail_streak: 0;
  action: 'unblocked' | 'noop';
};

async function postUnblock({ code, date }: UnblockArgs): Promise<UnblockResponse> {
  const res = await fetch(`/api/captures/items/${code}/${date}/unblock`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`unblock failed: ${res.status}`);
  }
  return res.json();
}

export function useInventoryUnblock() {
  const qc = useQueryClient();
  const unblock = useMutation({
    mutationFn: postUnblock,
    onSuccess: () => {
      // Invalidate the inventory list — keep this key in sync with useStockDates.
      qc.invalidateQueries({ queryKey: ['stock-dates'] /* paste actual key */ });
    },
  });
  return { unblock };
}
```

Replace `['stock-dates']` with the actual key recorded in Step 2.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/inventory/useInventoryUnblock.test.ts`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/inventory/useInventoryUnblock.ts frontend/src/inventory/useInventoryUnblock.test.ts
git commit -m "feat(inventory): useInventoryUnblock hook (ADR-0042)"
```

---

## Task 11: Inventory row UI — blocked badge + 잠금 해제 button

**Files:**
- Modify: the inventory row component (locate via `grep -rn "useInventoryRecapture\|Re-capture\|재캡처" frontend/src/inventory/` to find the file)
- Modify: `DESIGN.md` may be consulted but **not** modified by this task
- Test: append to the row's existing `*.test.tsx`, or create `<RowComponent>.fail-streak.test.tsx`

- [ ] **Step 1: Open `DESIGN.md` and pick tokens**

Run: `grep -nE "warning|danger|blocked|배지|badge" DESIGN.md | head -30`

Pick:
- A warning/danger tint for the blocked row background or border.
- A neutral subdued tint for the `재시도 N/5` indicator (or **skip the indicator** if no suitable token exists).
- Existing button styling for the `잠금 해제` button (reuse the Re-capture button's class or component).

Record the chosen tokens at the top of the test file as a comment for traceability.

- [ ] **Step 2: Write failing render tests**

Append a new test file (e.g. `frontend/src/inventory/<RowComponent>.fail-streak.test.tsx`):

```typescript
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InventoryRow } from './<RowComponent>';  // adjust import

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient();
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
};

const baseRow = {
  code: '005930',
  date: '20260520',
  // ...minimum fields the component needs (copy from existing tests if any)
};

describe('InventoryRow fail-streak surfacing', () => {
  it('renders the default Re-capture button when fail_streak == 0', () => {
    render(wrap(<InventoryRow row={{ ...baseRow, fail_streak: 0, blocked: false }} />));
    expect(screen.getByRole('button', { name: /재캡처|Re-?capture/i })).toBeInTheDocument();
    expect(screen.queryByText(/차단됨/)).toBeNull();
  });

  it('renders 차단됨 (5/5) badge and 잠금 해제 button when blocked', () => {
    render(wrap(<InventoryRow row={{ ...baseRow, fail_streak: 5, blocked: true }} />));
    expect(screen.getByText('차단됨 (5/5)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '잠금 해제' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /재캡처|Re-?capture/i })).toBeNull();
  });

  it('shows 재시도 N/5 indicator when 0 < fail_streak < 5 (if design token present)', () => {
    render(wrap(<InventoryRow row={{ ...baseRow, fail_streak: 3, blocked: false }} />));
    // If the indicator is skipped per DESIGN.md, replace this assertion with the explicit
    // expectation that no indicator is rendered.
    const indicator = screen.queryByText('재시도 3/5');
    // If the chosen design omits the indicator, change to: expect(indicator).toBeNull();
    expect(indicator).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/inventory/<RowComponent>.fail-streak.test.tsx`
Expected: all 3 fail.

- [ ] **Step 4: Implement the branch in the row component**

Edit the row component:

```tsx
import { useInventoryUnblock } from './useInventoryUnblock';

// ...inside the component:
if (row.blocked) {
  const { unblock } = useInventoryUnblock();
  return (
    <div className={/* DESIGN.md warning tint class */}>
      {/* ...other row cells... */}
      <span className={/* badge class */}>차단됨 (5/5)</span>
      <button onClick={() => unblock.mutate({ code: row.code, date: row.date })}>
        잠금 해제
      </button>
    </div>
  );
}

// Optional indicator slot for 0 < fail_streak < 5 — include only if the design system
// provides a suitable subdued token.
return (
  <div>
    {/* ...existing row... */}
    {row.fail_streak > 0 && (
      <span className={/* subdued class */}>재시도 {row.fail_streak}/5</span>
    )}
    {/* existing Re-capture button */}
  </div>
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/inventory/`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/inventory/
git commit -m "feat(inventory): row UI shows 차단됨/잠금 해제 + 재시도 N/5 (ADR-0042)"
```

---

## Task 12: `CaptureForm` — surface `response.blocked[]`

**Files:**
- Modify: `frontend/src/capture/CaptureForm.tsx` (CaptureForm.tsx:31-52)
- Modify: `frontend/src/capture/useCaptureQueue.ts` if needed to surface the response back to the form (current `addItems.mutate` is fire-and-forget; we need to read `data` after success)
- Test: `frontend/src/capture/CaptureForm.blocked.test.tsx`

- [ ] **Step 1: Read current CaptureForm submit handler**

Run: `sed -n '20,80p' frontend/src/capture/CaptureForm.tsx`

Identify how the form responds to mutation success. If the current code discards the success body, switch to `mutateAsync` so the form can inspect `response.blocked`.

- [ ] **Step 2: Write failing test**

Create `frontend/src/capture/CaptureForm.blocked.test.tsx`:

```typescript
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { CaptureForm } from './CaptureForm';

describe('CaptureForm blocked surfacing', () => {
  it('shows the Korean blocked message when response.blocked is non-empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        enqueued: [],
        deduped: [],
        blocked: [{
          code: '005930', date: '20260520', fail_streak: 5, reason: 'fail_streak_exceeded',
        }],
      }), { status: 409, headers: { 'content-type': 'application/json' } })
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CaptureForm />
      </QueryClientProvider>
    );

    // Fill the form with the minimum fields it needs and submit.
    // (Adapt selectors to the actual form — copy from existing CaptureForm tests if any.)
    await userEvent.type(screen.getByLabelText(/code|종목/i), '005930');
    await userEvent.type(screen.getByLabelText(/start|시작/i), '20260520');
    await userEvent.type(screen.getByLabelText(/end|종료/i), '20260520');
    await userEvent.click(screen.getByRole('button', { name: /capture|캡처|등록/i }));

    await waitFor(() => {
      expect(screen.getByText(/5회 연속 실패로 차단/)).toBeInTheDocument();
      expect(screen.getByText(/005930.*20260520/)).toBeInTheDocument();
    });
  });

  it('does not hide enqueued/deduped summaries when only some pairs are blocked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        enqueued: [{ code: '005930', date: '20260521' /* minimal QueueItem shape */ }],
        deduped: [],
        blocked: [{
          code: '005930', date: '20260520', fail_streak: 5, reason: 'fail_streak_exceeded',
        }],
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    );

    // ...same render + submit as above...
    // Assert both "1 enqueued" AND the blocked message are visible.
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/capture/CaptureForm.blocked.test.tsx`
Expected: 2 failures (message text not rendered).

- [ ] **Step 4: Wire `response.blocked` into the form**

Modify `CaptureForm.tsx` to switch to `mutateAsync` and surface `response.blocked`:

```tsx
const handleSubmit = async (e: FormEvent) => {
  e.preventDefault();
  try {
    const response = await addItems.mutateAsync({ code, start_date, end_date, force_retry });
    if (response.blocked && response.blocked.length > 0) {
      const pairs = response.blocked
        .map((b) => `${b.code}/${b.date}`)
        .join(', ');
      setBlockedMessage(
        `다음 항목은 5회 연속 실패로 차단되었습니다. 인벤토리에서 잠금을 해제하세요: ${pairs}`,
      );
    } else {
      setBlockedMessage(null);
    }
    // ...existing post-success handling (enqueued summary, etc.) unchanged
  } catch (err) {
    // ...existing onError translation logic — but note that a 409 with a JSON body
    // arrives here as a thrown error; ensure the catch path parses the body and
    // surfaces blocked the same way. Mirror what useInventoryRecapture does for
    // partial responses.
  }
};
```

Render `blockedMessage` inline with the existing inline-error slot, using DESIGN.md warning tokens.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/capture/CaptureForm.blocked.test.tsx`
Expected: all green.

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npm run test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureForm.blocked.test.tsx
git commit -m "feat(capture): surface response.blocked[] inline (ADR-0042)"
```

---

## Task 13: Final verification — full test suites + production build

**Files:** None.

- [ ] **Step 1: Backend full suite**

Run: `uv run pytest -v`
Expected: all green.

- [ ] **Step 2: Frontend full suite**

Run: `cd frontend && npm run test`
Expected: all green.

- [ ] **Step 3: Frontend production build**

Run: `cd frontend && npm run build`
Expected: success, no type errors, no warnings beyond pre-existing baseline.

- [ ] **Step 4: Manual E2E smoke via `/browse` (optional but recommended)**

Boot backend + frontend per CLAUDE.md, then use the `/browse` skill:

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/inventory
$B text  # confirm inventory loads
$B network  # confirm /api/stock-dates response includes fail_streak field
```

If you have a (Code, Stock-Date) that's failing repeatedly in dev data, click Re-capture 6 times and confirm the 6th click results in inline blocked feedback in `/capture` and a `차단됨` badge appearing in `/inventory`. Then click `잠금 해제` and confirm Re-capture returns. Document any UI rough edges as follow-up tasks.

- [ ] **Step 5: Final commit (only if the smoke test exposed touch-ups)**

If no changes were needed, this is just a checkpoint announcement: "All gates green, ready for grill-with-docs and code review."

---

## Cross-task notes (read once before starting)

- **Two backend writes per worker terminal.** Task 3 wires `apply_terminal_to_manifest` into `_finalize_item`. If the existing `_finalize_item` already calls `save_manifest`, piggyback on it — don't double-write.

- **`async with _manifest_lock()` is the existing concurrency boundary.** Both `apply_terminal_to_manifest` (Task 3) and `clear_for_unblock` (Task 7) must be called inside that lock so concurrent unblocks and worker terminations serialize cleanly. The exact lock helper name lives in captures.py — match it.

- **Frontend TanStack Query key:** Tasks 10/11/12 all need the inventory query key. Find it once in Task 10 Step 2 and reuse the exact value — don't paraphrase.

- **`force_retry=true` is not an escape hatch.** Task 5's test `test_force_retry_does_NOT_bypass_guard` is non-negotiable; if it fails, the design intent is broken.

- **No fall-back behaviour that swallows errors.** If `clear_for_unblock` or `apply_terminal_to_manifest` raises, let it propagate. The existing top-level FastAPI handler converts it to a 500; no try/except around manifest writes except the explicit `OSError → 500` in Task 7.

- **No commenting out tests.** If a test in Task 3 Step 6 can't run because the bootstrap helper isn't ready, use `pytest.mark.skip(reason="bootstrap helper TBD")` with a follow-up note — never delete or comment out.

## Spec coverage check (filled out after writing the plan)

| Spec section | Task(s) |
|---|---|
| Goal: fail_streak definition | Task 1, 2, 3 |
| Goal: reject at >= 5 | Task 5, 6 |
| Goal: persist in .queue.json | Task 1, 3 |
| Goal: inventory surfacing | Task 8 |
| Goal: 차단됨 badge + 잠금 해제 | Task 11 |
| Non-Goal: time-based unblock | (intentionally absent) |
| Non-Goal: bulk unblock | (intentionally absent) |
| Non-Goal: configurable cap | Task 2 (ATTEMPT_CAP = 5 constant) |
| Domain term: fail_streak | Task 2 (helper name + comment) |
| Domain term: attempt_cap | Task 2 (constant name) |
| Domain term: blocked | Task 4, 8, 11 |
| Domain term: unblock | Task 7, 10, 11 |
| Backend architecture | Task 1-9 |
| Frontend architecture | Task 10-12 |
| Manifest schema extension | Task 1 |
| Helpers | Task 2, 3, 7 |
| Worker terminal hook | Task 3 |
| `enqueue_items_core` guard placement | Task 5 |
| HTTP 409 / 201 policy | Task 6 |
| Unblock endpoint | Task 7 |
| Inventory list annotation | Task 8 |
| `useInventoryUnblock` | Task 10 |
| Inventory row branch (blocked / N/5 / default) | Task 11 |
| `CaptureForm` blocked message | Task 12 |
| Error handling: unknown phase raises | Task 3 |
| Error handling: unblock 400 / 500 | Task 7 |
| Tests: apply_terminal | Task 3 |
| Tests: read_fail_streak / is_blocked | Task 2 |
| Tests: enqueue guard | Task 5, 6 |
| Tests: unblock endpoint | Task 7 |
| Tests: forward-compat manifest | Task 1 |
| Tests: inventory annotation | Task 8 |
| Tests: useInventoryUnblock | Task 10 |
| Tests: row rendering | Task 11 |
| Tests: CaptureForm blocked | Task 12 |
| E2E smoke | Task 13 |
| Migration / no script needed | Task 1 (default_factory) |
| Backwards-compat: optional response fields | Task 4, 8 (defaults), Task 13 (build proof) |

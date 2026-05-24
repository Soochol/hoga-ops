# Capture Queue Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the in-memory Capture Queue (`_queue` + `_active` + `_queue_paused`) to `<data_dir>/.queue.json` so server restart auto-resumes the in-flight queue.

**Architecture:** A new shared atomic-write helper (`_atomic_write.py`) is extracted first per ADR-0015's footer. A new persistence module (`captures_persistence.py`) handles save/load/quarantine of `QueueManifest`. `captures.py` calls `_persist_queue_locked()` from every mutation site (all already under `_lock`). The app lifespan loads the manifest into `_queue` BEFORE `start_workers()`, so workers naturally pick restored items up. Frontend SSE disconnect handler is extended to invalidate the queue + calendar query keys so the browser refreshes after backend reconnect.

**Tech Stack:** Python 3.12+ · pydantic · FastAPI · asyncio · pytest · pytest-asyncio · React Query · TypeScript

**Spec:** [docs/superpowers/specs/2026-05-24-capture-queue-persistence-design.md](../specs/2026-05-24-capture-queue-persistence-design.md)
**ADR:** [docs/adr/0019-capture-queue-manifest-persistence.md](../../adr/0019-capture-queue-manifest-persistence.md)

---

## Task 1: Extract shared `atomic_write_json` helper

Pure refactor — extract the tempfile + flush + fsync + os.replace pattern from `symbols.py:253-282` into a shared helper. ADR-0015 footer anticipated this; queue persistence is the second consumer. No semantic change.

**Files:**
- Create: `hoga/api/_atomic_write.py`
- Modify: `hoga/api/symbols.py:253-282`
- Test: `tests/test_api_atomic_write.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_api_atomic_write.py
"""Tests for the shared atomic JSON write helper extracted per ADR-0015 + ADR-0019."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api._atomic_write import atomic_write_json


def test_writes_json_to_path(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_json(target, {"hello": "world"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"hello": "world"}


def test_creates_parent_dir(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "deep" / "out.json"
    atomic_write_json(target, [1, 2, 3])
    assert target.exists()
    assert json.loads(target.read_text(encoding="utf-8")) == [1, 2, 3]


def test_overwrites_existing_atomically(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    target.write_text('{"old": true}', encoding="utf-8")
    atomic_write_json(target, {"new": True})
    assert json.loads(target.read_text(encoding="utf-8")) == {"new": True}


def test_no_tmp_files_left_on_success(tmp_path: Path) -> None:
    target = tmp_path / "out.json"
    atomic_write_json(target, {"a": 1})
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_korean_utf8_preserved(tmp_path: Path) -> None:
    """Ensure ensure_ascii=False behavior carries over (symbols.py relies on it)."""
    target = tmp_path / "out.json"
    atomic_write_json(target, {"name": "삼성전자"})
    raw = target.read_text(encoding="utf-8")
    assert "삼성전자" in raw  # not escaped as \uXXXX
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/test_api_atomic_write.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.api._atomic_write'`

- [ ] **Step 3: Create `_atomic_write.py`**

```python
# hoga/api/_atomic_write.py
"""Atomic JSON write helper. Extracted per ADR-0015 footer + ADR-0019.

Used by:
- hoga/api/symbols.py (Symbol Master disk cache)
- hoga/api/captures_persistence.py (Capture Queue manifest)
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    """Write ``payload`` as JSON to ``path`` atomically.

    Pattern: tempfile in target's parent dir → flush + fsync → os.replace.
    The parent dir is created if missing. Korean text is preserved
    (ensure_ascii=False).

    Raises:
        OSError: if disk write fails. Callers decide whether to propagate.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        json.dump(payload, tmp, ensure_ascii=False, indent=indent)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    os.replace(tmp_path, path)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
uv run pytest tests/test_api_atomic_write.py -v
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Migrate `symbols.py::_write_to_disk` to use the helper**

Edit `hoga/api/symbols.py:253-282`:

```python
def _write_to_disk(path: Path, entries: list[SymbolHit], fetched_at_ms: int) -> None:
    """Atomically persist the catalog. Creates parent dir if needed.

    Delegates to hoga.api._atomic_write.atomic_write_json (extracted per
    ADR-0015 footer + ADR-0019). captured_breakdown fields are stripped —
    disk file holds KRX-side data only (breakdown is a runtime view of
    data_dir).
    """
    payload = {
        "schema_version": SCHEMA_VERSION,
        "fetched_at_ms": fetched_at_ms,
        "source": "pykrx",
        "entries": [
            {"code": e.code, "name": e.name, "market": e.market}
            for e in entries
        ],
    }
    atomic_write_json(path, payload)
```

Also add the import at the top of `symbols.py` (near other `hoga.api` imports):

```python
from hoga.api._atomic_write import atomic_write_json
```

Remove now-unused imports if any (`tempfile`, `os.fsync` — but `os` is likely used elsewhere; leave it).

- [ ] **Step 6: Run existing symbol tests to verify regression-free**

```bash
uv run pytest tests/test_api_symbols.py -v
```

Expected: all existing tests PASS unchanged.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/_atomic_write.py tests/test_api_atomic_write.py hoga/api/symbols.py
git commit -m "$(cat <<'EOF'
refactor(api): extract atomic_write_json helper per ADR-0015 footer

Shared helper extracted now that a second persistence target
(capture queue manifest, ADR-0019) is landing. symbols.py
migrates to it; behavior unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `QueueManifest` wire models

Add the pydantic models that represent the on-disk schema. Pure additions to `models.py`.

**Files:**
- Modify: `hoga/api/models.py` (append after `QueueSnapshot`, around line 232)
- Test: `tests/test_api_models_capture_queue.py` (extend existing)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_api_models_capture_queue.py`:

```python
def test_queue_manifest_item_roundtrip():
    from hoga.api.models import QueueManifestItem
    item = QueueManifestItem(
        item_id="20260524T100000000-005930-20260520",
        code="005930",
        date="20260520",
        force_retry=False,
        enqueued_at_ms=1700000000000,
        pause_origin=False,
    )
    raw = item.model_dump_json()
    back = QueueManifestItem.model_validate_json(raw)
    assert back == item


def test_queue_manifest_defaults_schema_version_to_1():
    from hoga.api.models import QueueManifest
    m = QueueManifest(paused=False, items=[])
    assert m.schema_version == 1
    assert m.paused is False
    assert m.items == []


def test_queue_manifest_rejects_extra_fields():
    """Schema is strict — typos in field names should fail validation."""
    from hoga.api.models import QueueManifest
    with pytest.raises(Exception):
        QueueManifest.model_validate_json(
            '{"schema_version": 1, "paused": false, "items": [], "typo": true}'
        )
```

Note: the third test will only catch typos if we add `model_config = ConfigDict(extra="forbid")`. Decide based on existing model conventions — search models.py for `extra=`:

```bash
grep -n "extra=" hoga/api/models.py || echo "no extra= config — drop the third test"
```

If existing models DON'T set `extra="forbid"`, drop the third test (don't add a one-off discipline).

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/test_api_models_capture_queue.py::test_queue_manifest_item_roundtrip tests/test_api_models_capture_queue.py::test_queue_manifest_defaults_schema_version_to_1 -v
```

Expected: FAIL — `ImportError: cannot import name 'QueueManifestItem'`.

- [ ] **Step 3: Add the models**

Insert into `hoga/api/models.py` immediately after the `QueueSnapshot` class (around line 236):

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


class QueueManifest(BaseModel):
    """On-disk capture-queue manifest. Written to ``<data_dir>/.queue.json``
    on every queue mutation. Loaded once at lifespan startup to restore the
    queue (ADR-0019).
    """

    schema_version: int = 1
    paused: bool
    items: list[QueueManifestItem]
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_models_capture_queue.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/test_api_models_capture_queue.py
git commit -m "$(cat <<'EOF'
feat(models): add QueueManifest wire models for queue persistence

On-disk schema for <data_dir>/.queue.json. schema_version follows the
ADR-0015 convention. Phase is intentionally not stored — restore
always re-queues with phase='queued' (decide_capture handles
resume/skip/fresh routing per spec §4.2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `captures_persistence.py` — save/load/quarantine

The persistence module. Pure I/O against a `data_dir` Path; no global state, no asyncio.

**Files:**
- Create: `hoga/api/captures_persistence.py`
- Test: `tests/test_api_captures_persistence.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_api_captures_persistence.py`:

```python
"""Tests for captures_persistence module — save/load/quarantine the queue manifest."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api.captures_persistence import (
    MANIFEST_FILENAME,
    load_manifest,
    manifest_path,
    save_manifest,
)
from hoga.api.models import QueueManifest, QueueManifestItem


def _make_item(item_id: str = "20260524T100000000-005930-20260520") -> QueueManifestItem:
    return QueueManifestItem(
        item_id=item_id,
        code="005930",
        date="20260520",
        force_retry=False,
        enqueued_at_ms=1700000000000,
        pause_origin=False,
    )


def test_manifest_path_returns_dotfile_in_data_dir(tmp_path: Path) -> None:
    assert manifest_path(tmp_path) == tmp_path / MANIFEST_FILENAME
    assert MANIFEST_FILENAME == ".queue.json"


def test_save_then_load_roundtrip(tmp_path: Path) -> None:
    manifest = QueueManifest(paused=False, items=[_make_item(), _make_item("id2")])
    save_manifest(tmp_path, manifest)
    back = load_manifest(tmp_path)
    assert back == manifest


def test_save_writes_atomically_no_tmp_left(tmp_path: Path) -> None:
    save_manifest(tmp_path, QueueManifest(paused=False, items=[_make_item()]))
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_save_preserves_paused_flag(tmp_path: Path) -> None:
    save_manifest(tmp_path, QueueManifest(paused=True, items=[]))
    back = load_manifest(tmp_path)
    assert back is not None and back.paused is True


def test_load_returns_none_when_file_missing(tmp_path: Path) -> None:
    assert load_manifest(tmp_path) is None


def test_load_quarantines_invalid_json(tmp_path: Path) -> None:
    (tmp_path / ".queue.json").write_text("not json", encoding="utf-8")
    assert load_manifest(tmp_path) is None
    # Original file is gone, quarantine file exists
    assert not (tmp_path / ".queue.json").exists()
    quarantined = list(tmp_path.glob(".queue.json.corrupt-*"))
    assert len(quarantined) == 1
    assert "parse_error" in quarantined[0].name


def test_load_quarantines_schema_mismatch(tmp_path: Path) -> None:
    (tmp_path / ".queue.json").write_text(
        json.dumps({"schema_version": 99, "paused": False, "items": []}),
        encoding="utf-8",
    )
    assert load_manifest(tmp_path) is None
    quarantined = list(tmp_path.glob(".queue.json.corrupt-*"))
    assert len(quarantined) == 1
    assert "version_mismatch_99" in quarantined[0].name


def test_load_quarantines_missing_required_field(tmp_path: Path) -> None:
    """e.g. items field absent — pydantic validation fails."""
    (tmp_path / ".queue.json").write_text(
        json.dumps({"schema_version": 1, "paused": False}),
        encoding="utf-8",
    )
    assert load_manifest(tmp_path) is None
    quarantined = list(tmp_path.glob(".queue.json.corrupt-*"))
    assert len(quarantined) == 1


def test_save_swallows_oserror_via_unwritable_parent(tmp_path: Path, monkeypatch, caplog) -> None:
    """save_manifest must NOT propagate OSError — in-memory state is the
    runtime source of truth; disk failure is best-effort only."""
    bad_dir = tmp_path / "readonly"
    bad_dir.mkdir()
    bad_dir.chmod(0o500)  # read+execute, no write
    try:
        # Should not raise. Should log a warning.
        with caplog.at_level("WARNING", logger="hoga.api.captures_persistence"):
            save_manifest(bad_dir, QueueManifest(paused=False, items=[_make_item()]))
        assert any("manifest write failed" in r.message for r in caplog.records)
    finally:
        bad_dir.chmod(0o700)  # restore for cleanup
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_captures_persistence.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.api.captures_persistence'`.

- [ ] **Step 3: Create the module**

Create `hoga/api/captures_persistence.py`:

```python
"""Capture Queue manifest persistence.

Writes ``<data_dir>/.queue.json`` on every queue mutation; reads once at
lifespan startup to restore the queue. See ADR-0019 for design rationale.
"""
from __future__ import annotations

import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import QueueManifest
from hoga.collector.orchestrator import now_kst

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = ".queue.json"
_SCHEMA_VERSION = 1


def manifest_path(data_dir: Path) -> Path:
    return data_dir / MANIFEST_FILENAME


def save_manifest(data_dir: Path, manifest: QueueManifest) -> None:
    """Atomic write. OSError is caught + logged so disk failure does NOT
    break in-memory queue operations. Caller holds any relevant locks.
    """
    try:
        atomic_write_json(manifest_path(data_dir), manifest.model_dump(mode="json"))
    except OSError as e:
        logger.warning(
            "queue manifest write failed (%s); in-memory queue continues, "
            "restart recovery may lose state",
            e,
        )


def load_manifest(data_dir: Path) -> QueueManifest | None:
    """Return the manifest, or None if missing / corrupt / version-mismatched.
    Corrupt files are quarantined to ``.queue.json.corrupt-<ts>-<reason>``
    for forensic inspection.
    """
    target = manifest_path(data_dir)
    if not target.exists():
        return None
    try:
        raw = target.read_text(encoding="utf-8")
        manifest = QueueManifest.model_validate_json(raw)
    except (OSError, ValueError, ValidationError) as e:
        _quarantine(target, reason=f"parse_error_{type(e).__name__}")
        return None
    if manifest.schema_version != _SCHEMA_VERSION:
        _quarantine(target, reason=f"version_mismatch_{manifest.schema_version}")
        return None
    return manifest


def _quarantine(path: Path, *, reason: str) -> None:
    ts = now_kst().strftime("%Y%m%dT%H%M%S")
    backup = path.with_name(f"{path.name}.corrupt-{ts}-{reason}")
    try:
        path.rename(backup)
        logger.warning("queue manifest quarantined: %s → %s", path, backup.name)
    except OSError as e:
        logger.warning("queue manifest quarantine rename failed: %s", e)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_captures_persistence.py -v
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures_persistence.py tests/test_api_captures_persistence.py
git commit -m "$(cat <<'EOF'
feat(api): add captures_persistence module — save/load/quarantine queue

Atomic JSON manifest written to <data_dir>/.queue.json on every queue
mutation. OSError is absorbed (logged WARN) so disk failures don't
break in-memory queue operations. Corrupt/version-mismatched files
are quarantined to .queue.json.corrupt-<ts>-<reason> for forensics.

See ADR-0019.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `_persist_queue_locked()` helper + write hook insertions in `captures.py`

Add the persistence callout at every mutation site. All sites already run inside `_lock`, so we just need to call the helper.

**Files:**
- Modify: `hoga/api/captures.py` (add helper, 7 call sites, extend `reset_state_for_tests`)
- Test: `tests/test_api_captures_queue.py` (extend with persistence assertions)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api_captures_queue.py`:

```python
# -----------------------------------------------------------------------------
# Queue manifest persistence — Task 4
# -----------------------------------------------------------------------------
import json

from hoga.api.captures_persistence import manifest_path
from hoga.api.captures_fake import FakeHogaplayClient


def _read_manifest_json(data_dir):
    p = manifest_path(data_dir)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def test_enqueue_writes_manifest(monkeypatch, tmp_path):
    """Enqueueing items via the route should persist them to .queue.json."""
    from fastapi.testclient import TestClient
    from fastapi import FastAPI

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    app = FastAPI()
    app.include_router(captures.build_router(
        data_dir=tmp_path, client_factory=FakeHogaplayClient,
    ))
    client = TestClient(app)
    resp = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520"], "force_retry": False,
    })
    assert resp.status_code == 201
    data = _read_manifest_json(tmp_path)
    assert data is not None
    assert data["schema_version"] == 1
    assert data["paused"] is False
    assert len(data["items"]) == 1
    assert data["items"][0]["code"] == "005930"
    assert data["items"][0]["date"] == "20260520"


def test_cancel_queued_item_updates_manifest(monkeypatch, tmp_path):
    """Cancelling a queued item should remove it from the manifest."""
    from fastapi.testclient import TestClient
    from fastapi import FastAPI

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    app = FastAPI()
    app.include_router(captures.build_router(
        data_dir=tmp_path, client_factory=FakeHogaplayClient,
    ))
    client = TestClient(app)
    resp = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520"], "force_retry": False,
    })
    item_id = resp.json()["enqueued"][0]["item_id"]
    client.post(f"/api/captures/items/{item_id}/cancel")
    data = _read_manifest_json(tmp_path)
    assert data is not None
    assert data["items"] == []  # cancelled item went to _done, which is not persisted


def test_cancel_all_clears_manifest(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from fastapi import FastAPI

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    app = FastAPI()
    app.include_router(captures.build_router(
        data_dir=tmp_path, client_factory=FakeHogaplayClient,
    ))
    client = TestClient(app)
    client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520", "20260519"], "force_retry": False,
    })
    client.post("/api/captures/cancel-all")
    data = _read_manifest_json(tmp_path)
    assert data is not None
    assert data["items"] == []


def test_persist_no_op_when_data_dir_unset(monkeypatch, tmp_path):
    """When _data_dir is None (test mode without router build), the helper
    must not crash."""
    monkeypatch.setattr(captures, "_data_dir", None)
    # Direct invocation — must not raise even though _data_dir is None.
    captures._persist_queue_locked()  # type: ignore[attr-defined]


def test_reset_state_for_tests_deletes_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    (tmp_path / ".queue.json").write_text(
        '{"schema_version": 1, "paused": false, "items": []}',
        encoding="utf-8",
    )
    captures.reset_state_for_tests()
    assert not (tmp_path / ".queue.json").exists()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_captures_queue.py -k "manifest or persist or reset_state_for_tests_deletes" -v
```

Expected: FAIL — `AttributeError: module 'hoga.api.captures' has no attribute '_persist_queue_locked'` (or manifest file isn't written).

- [ ] **Step 3: Add `_persist_queue_locked` helper to captures.py**

Insert into `hoga/api/captures.py` right above the `set_bus()` function (around line 207, before the `_bus` block):

```python
# --- Queue manifest persistence (ADR-0019) --------------------------------

def _persist_queue_locked() -> None:
    """Snapshot _active + _queue + _queue_paused to the on-disk manifest.

    INVARIANT: caller holds ``_lock``. Called from every mutation site that
    touches _queue or _active. _done is intentionally excluded (volatile —
    cleared by DELETE /done; see ADR-0019).

    Active-before-queued ordering matters: items that were running in the
    previous session get restored first into _queue, so workers pick them
    up before strictly-queued items. This preserves the "resume in-flight
    first" UX (see spec §4.5 Ordering invariant).
    """
    if _data_dir is None:
        return  # test fixture without data_dir wired
    from hoga.api.captures_persistence import save_manifest
    from hoga.api.models import QueueManifest, QueueManifestItem
    items = [
        QueueManifestItem(
            item_id=s.item_id,
            code=s.code,
            date=s.date,
            force_retry=s.force_retry,
            enqueued_at_ms=s.enqueued_at_ms,
            pause_origin=s.pause_origin,
        )
        for s in (*_active.values(), *_queue)
    ]
    save_manifest(_data_dir, QueueManifest(paused=_queue_paused, items=items))
```

- [ ] **Step 4: Wire the helper into every mutation site**

**Site 1 — `enqueue_items` route** ([captures.py:760-761](hoga/api/captures.py#L760-L761)). After `if enqueued and _wakeup is not None: _wakeup.set()`:

```python
            if enqueued and _wakeup is not None:
                _wakeup.set()
            _persist_queue_locked()  # ADD THIS LINE — still inside async with _lock
```

**Site 2 — `_worker_loop` after popleft + assign to _active** ([captures.py:568-571](hoga/api/captures.py#L568-L571)). Inside the `else:` branch where `_active[state.item_id] = state`:

```python
                else:
                    _inflight_paths.add((state.code, state.date))
                    state.phase = "deciding"
                    _active[state.item_id] = state
                    _persist_queue_locked()  # ADD — queued→active transition
                    wait = None
```

**Site 3 — `_finalize_item`** ([captures.py:436-453](hoga/api/captures.py#L436-L453)). After `_done.append(state)` and before computing `drained_event`:

```python
    async with _lock:
        _active.pop(state.item_id, None)
        _inflight_paths.discard((state.code, state.date))
        _done.append(state)
        _persist_queue_locked()  # ADD — item left _active
        # Drain detection ...
```

**Site 4 — `_handle_cookie_expired`** ([captures.py:471-485](hoga/api/captures.py#L471-L485)). After the for-loop that sets `pause_origin`:

```python
    async with _lock:
        if _queue_paused:
            return
        _queue_paused = True
        for other in _active.values():
            if other.item_id == state.item_id:
                continue
            other.pause_origin = True
            if other.cancel_token is not None:
                other.cancel_token.cancel()
        _persist_queue_locked()  # ADD — paused flag flipped
```

**Site 5 — `resume_queue`** ([captures.py:488-505](hoga/api/captures.py#L488-L505)). After re-enqueue loop, before the wakeup signal:

```python
    async with _lock:
        _queue_paused = False
        to_reenqueue = [s for s in _done if s.pause_origin and s.phase == "cancelled"]
        for s in reversed(to_reenqueue):
            s.phase = "queued"
            s.pause_origin = False
            _queue.appendleft(s)
        _done[:] = [s for s in _done if s not in to_reenqueue]
        _persist_queue_locked()  # ADD — queue + paused both changed
        if _wakeup is not None and _queue:
            _wakeup.set()
```

**Site 6 — `cancel_all`** ([captures.py:508-545](hoga/api/captures.py#L508-L545)). After the cancel-token loop and pause-origin clearing, before the wakeup signal:

```python
    async with _lock:
        was_paused = _queue_paused
        while _queue:
            s = _queue.popleft()
            s.phase = "cancelled"
            _done.append(s)
            drained.append(s)
        for s in list(_active.values()):
            if s.cancel_token is not None:
                s.cancel_token.cancel()
        if was_paused:
            for s in _done:
                if s.pause_origin:
                    s.pause_origin = False
            _queue_paused = False
        _persist_queue_locked()  # ADD
        if _wakeup is not None:
            _wakeup.set()
```

**Site 7 — `cancel_item` queued case** ([captures.py:776-789](hoga/api/captures.py#L776-L789)). Inside the for-loop that removes from `_queue`, after `_done.append(s)`:

```python
        for i, s in enumerate(_queue):
            if s.item_id == item_id:
                del _queue[i]
                s.phase = "cancelled"
                _done.append(s)
                _persist_queue_locked()  # ADD
                if _wakeup is not None:
                    _wakeup.set()
                _publish_event(...)
                return {"status": "cancelled", "item_id": item_id}
```

**Note:** `cancel_item` active case (cancel_token signal) does NOT need a persist call — the worker's `_finalize_item` will persist when it observes the cancel.

- [ ] **Step 5: Extend `reset_state_for_tests`**

Edit `hoga/api/captures.py:173-185`:

```python
def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears all module singletons + the
    on-disk manifest (so per-test state never leaks)."""
    global _queue_paused, _wakeup  # noqa: PLW0603 — intentional test-only reset of module singletons
    _queue.clear()
    _active.clear()
    _done.clear()
    _inflight_paths.clear()
    _queue_paused = False
    _wakeup = None
    if _data_dir is not None:
        from hoga.api.captures_persistence import manifest_path
        manifest_path(_data_dir).unlink(missing_ok=True)
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_captures_queue.py -v
```

Expected: all existing tests still pass AND the 5 new persistence tests pass.

If existing tests fail because of unexpected manifest files, check that `reset_state_for_tests` is properly called in the autouse `_reset` fixture (line 13 of test file) AND that `_data_dir` monkeypatching happens before fixture teardown.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "$(cat <<'EOF'
feat(api): persist capture queue to .queue.json on every mutation

_persist_queue_locked() is called at all 7 mutation sites under _lock:
enqueue, worker pickup, finalize, cookie-expired pause, resume,
cancel-all, cancel-queued. _done is intentionally not persisted.
reset_state_for_tests also clears the manifest file to prevent
test leakage.

See ADR-0019.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `_restore_queue_from_manifest` helper

Reads the manifest at startup and populates `_queue` + `_queue_paused`. Single function; tested in isolation before lifespan integration.

**Files:**
- Modify: `hoga/api/captures.py` (add function)
- Test: `tests/test_api_captures_restore.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_api_captures_restore.py`:

```python
"""Tests for _restore_queue_from_manifest — Task 5."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api import captures


@pytest.fixture(autouse=True)
def _reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


def _write_manifest(data_dir: Path, payload: dict) -> None:
    (data_dir / ".queue.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


def test_restore_no_manifest_leaves_queue_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    assert snap.active == []
    assert snap.paused is False


def test_restore_populates_queue_in_manifest_order(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": False,
        "items": [
            {"item_id": "id1", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False},
            {"item_id": "id2", "code": "005930", "date": "20260519",
             "force_retry": True, "enqueued_at_ms": 2, "pause_origin": False},
        ],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert [i.item_id for i in snap.queued] == ["id1", "id2"]
    assert snap.queued[0].phase == "queued"  # always reset to queued
    assert snap.queued[1].force_retry is True


def test_restore_preserves_paused_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1, "paused": True, "items": [],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.paused is True


def test_restore_preserves_pause_origin(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": True,
        "items": [{"item_id": "id1", "code": "005930", "date": "20260520",
                   "force_retry": False, "enqueued_at_ms": 1, "pause_origin": True}],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued[0].pause_origin is True


def test_restore_quarantines_corrupt_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    (tmp_path / ".queue.json").write_text("not json", encoding="utf-8")
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    # Quarantine file present
    assert list(tmp_path.glob(".queue.json.corrupt-*"))


def test_restore_resets_phase_to_queued_even_if_manifest_says_otherwise(monkeypatch, tmp_path):
    """Defense in depth: even if a future schema version persisted phase,
    on restore we ALWAYS reset to queued so decide_capture re-routes."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": False,
        "items": [{"item_id": "id1", "code": "005930", "date": "20260520",
                   "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False}],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued[0].phase == "queued"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
uv run pytest tests/test_api_captures_restore.py -v
```

Expected: FAIL — `AttributeError: module 'hoga.api.captures' has no attribute '_restore_queue_from_manifest'`.

- [ ] **Step 3: Add the restore function**

Insert into `hoga/api/captures.py` after `_persist_queue_locked` (which you added in Task 4):

```python
def _restore_queue_from_manifest(data_dir: Path) -> None:
    """Read ``<data_dir>/.queue.json`` and push items into ``_queue``.

    Called once at lifespan startup BEFORE ``start_workers()``. All restored
    items get ``phase="queued"`` regardless of what the manifest says — the
    worker's deciding step then routes via ``decide_capture`` based on disk
    state (CLIENT_INCOMPLETE → resume=True, NONE → fresh, COMPLETE → skipped).

    Active-before-queued ordering is preserved by ``_persist_queue_locked``
    (active items are written first); restoring in document order means
    previously-in-flight items get picked up before strictly-queued ones.
    """
    global _queue_paused  # noqa: PLW0603 — startup-only module write
    from hoga.api.captures_persistence import load_manifest
    manifest = load_manifest(data_dir)
    if manifest is None:
        return
    _queue_paused = manifest.paused
    for item in manifest.items:
        state = QueueItemState(
            item_id=item.item_id,
            code=item.code,
            date=item.date,
            force_retry=item.force_retry,
            enqueued_at_ms=item.enqueued_at_ms,
            pause_origin=item.pause_origin,
            phase="queued",
        )
        _queue.append(state)
    import logging
    logging.getLogger(__name__).info(
        "restored queue manifest: %d items, paused=%s",
        len(manifest.items), manifest.paused,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
uv run pytest tests/test_api_captures_restore.py -v
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_restore.py
git commit -m "$(cat <<'EOF'
feat(api): add _restore_queue_from_manifest for startup recovery

Reads <data_dir>/.queue.json and populates _queue with restored
items in document order (active-first ordering preserved by the
write path). All items get phase='queued' so decide_capture
re-routes via disk state on the worker's first deciding step.

See ADR-0019.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire restore into `app.py` lifespan + integration test

Add the call BEFORE `start_workers()` in the FastAPI lifespan. Verify end-to-end: enqueue → simulated restart → workers process restored items.

**Files:**
- Modify: `hoga/api/app.py` (lifespan)
- Test: `tests/test_api_captures_restore_integration.py` (new)

- [ ] **Step 1: Write the failing integration test**

Create `tests/test_api_captures_restore_integration.py`:

```python
"""End-to-end: enqueue → kill workers → restore → workers drain. Task 6."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from hoga.api import captures
from hoga.api.captures_fake import FakeHogaplayClient


@pytest.fixture(autouse=True)
def _reset(tmp_path):
    captures._data_dir = tmp_path
    captures._client_factory = FakeHogaplayClient
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


async def test_restore_after_simulated_restart_drains_queue(tmp_path: Path):
    """1. Enqueue 2 items.
    2. Stop workers (simulates server shutdown leaving manifest behind).
    3. Reset in-memory state but keep manifest on disk.
    4. Restore from manifest.
    5. Start workers — they should drain the restored queue.
    """
    # 1. Enqueue via direct state manipulation (bypassing the route to keep
    # the test focused on the persistence pipeline).
    workers = captures.start_workers(n=2)
    try:
        # Use the route helper to get realistic item_id stamps.
        captures._queue.append(captures.QueueItemState(
            item_id="restore-test-1", code="005930", date="20260520",
            force_retry=False, enqueued_at_ms=1700000000000,
        ))
        captures._queue.append(captures.QueueItemState(
            item_id="restore-test-2", code="005930", date="20260519",
            force_retry=False, enqueued_at_ms=1700000000001,
        ))
        async with captures._lock:
            captures._persist_queue_locked()
    finally:
        await captures.stop_workers(workers)

    # 2. Confirm manifest exists on disk
    manifest_data = json.loads((tmp_path / ".queue.json").read_text(encoding="utf-8"))
    assert len(manifest_data["items"]) == 2

    # 3. Clear in-memory state but DON'T delete the manifest
    captures._queue.clear()
    captures._active.clear()
    captures._done.clear()
    captures._inflight_paths.clear()
    captures._queue_paused = False

    # 4. Restore
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert [i.item_id for i in snap.queued] == ["restore-test-1", "restore-test-2"]

    # 5. Start workers — they should drain via fake client. Use a stub _run_item
    # so we don't hit the full collector path (which needs network/disk setup).
    async def _stub_run_item(state):
        state.phase = "done"
    captures._run_item = _stub_run_item  # type: ignore[assignment]

    workers = captures.start_workers(n=2)
    try:
        await asyncio.wait_for(captures.wait_drained(), timeout=5.0)
    finally:
        await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    assert snap.active == []
    assert len(snap.done) == 2
```

- [ ] **Step 2: Run test to verify it fails**

```bash
uv run pytest tests/test_api_captures_restore_integration.py -v
```

Expected: PASS actually — this test doesn't require lifespan wiring; it calls `_restore_queue_from_manifest` directly. The test verifies the pipeline works end-to-end.

If it FAILS, the issue is in Tasks 4/5 — fix before proceeding.

- [ ] **Step 3: Wire restore into app.py lifespan**

Edit `hoga/api/app.py` — modify the lifespan function (around line 49-71). Add the restore call BEFORE `start_workers`:

```python
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        observer.start()
        set_captures_bus(bus, asyncio.get_running_loop())
        # Restore the persisted queue manifest BEFORE starting workers, so
        # workers pick restored items up on their first pass (ADR-0019).
        _captures_module._restore_queue_from_manifest(data_dir)
        _captures_module._workers = _captures_module.start_workers()
        _symbols_module.load_disk_state(
            path=resolve_symbol_master_path(), data_dir=data_dir
        )
        try:
            yield
        finally:
            await _captures_module.stop_workers(_captures_module._workers)
            _captures_module._workers = []
            cancel_all_on_shutdown()
            observer.stop()
            observer.join()
            engine.close()
            set_captures_bus(None, None)
```

- [ ] **Step 4: Add a lifespan-level smoke test**

Append to `tests/test_api_captures_restore_integration.py`:

```python
def test_lifespan_restores_manifest_at_startup(tmp_path, monkeypatch):
    """Create a FastAPI app with a pre-seeded manifest, start the lifespan,
    and confirm the queue is populated before any HTTP request fires."""
    from fastapi.testclient import TestClient
    from hoga.api.app import create_app

    # Pre-seed manifest
    (tmp_path / ".queue.json").write_text(json.dumps({
        "schema_version": 1,
        "paused": False,
        "items": [
            {"item_id": "lifespan-test-1", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1700000000000,
             "pause_origin": False},
        ],
    }), encoding="utf-8")

    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    app = create_app(tmp_path)
    with TestClient(app) as client:
        # Snapshot immediately after lifespan startup
        resp = client.get("/api/captures/queue")
        assert resp.status_code == 200
        snap = resp.json()
        # The item is either still queued, in active, or already moved to done
        # (workers race the request). Either way, the manifest was loaded.
        all_items = snap["queued"] + snap["active"] + snap["done"]
        assert any(i["item_id"] == "lifespan-test-1" for i in all_items)
```

- [ ] **Step 5: Run tests**

```bash
uv run pytest tests/test_api_captures_restore_integration.py -v
```

Expected: both tests PASS.

- [ ] **Step 6: Run full backend test suite for regressions**

```bash
uv run pytest tests/ -x --timeout=60
```

Expected: ALL tests PASS. If anything fails, especially in `test_api_captures_queue.py` or `test_api_symbols.py`, fix before commit.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/app.py tests/test_api_captures_restore_integration.py
git commit -m "$(cat <<'EOF'
feat(api): wire queue manifest restore into FastAPI lifespan

_restore_queue_from_manifest runs before start_workers, so workers
pick restored items up on their first pass. Lifespan-level smoke
test seeds the manifest before app boot and asserts the queue
contains the restored item via the public route.

See ADR-0019.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend SSE disconnect handler extension

After a server restart, the browser's EventSource auto-reconnects. The existing `disconnected` handler invalidates only `STOCK_DATES_QUERY_KEY` — we also need to invalidate `CAPTURE_QUEUE_QUERY_KEY` and `CALENDAR_QUERY_KEY` so the queue UI auto-refreshes to show restored items.

**Files:**
- Modify: `frontend/src/api/sse.ts:73-89`
- Test: `frontend/src/api/sse.test.ts` (new — or extend if it exists)

- [ ] **Step 1: Check if `frontend/src/api/sse.test.ts` exists**

```bash
ls frontend/src/api/sse.test.ts 2>/dev/null || echo "MISSING — will create"
```

- [ ] **Step 2: Write the failing test**

Create or extend `frontend/src/api/sse.test.ts`:

```typescript
// frontend/src/api/sse.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// We test the handler logic by mocking EventSource and observing
// queryClient.invalidateQueries calls.

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  listeners: Record<string, ((e: Event) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type: string, event: Event) {
    (this.listeners[type] || []).forEach((fn) => fn(event));
  }
  close() {}
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEventStream disconnect handler', () => {
  it('invalidates stock-dates, capture-queue, and calendar query keys on disconnect', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);

    const { useEventStream } = await import('./sse');
    renderHook(() => useEventStream(), { wrapper });

    // Allow any pending microtasks (open() is async)
    await new Promise((r) => setTimeout(r, 0));

    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();

    // Trigger the error → 'disconnected' synthetic event
    es.dispatch('error', new Event('error'));

    // Allow handlers to settle
    await new Promise((r) => setTimeout(r, 0));

    const keys = spy.mock.calls.map((c) => (c[0] as any).queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['stockDates'],         // existing
        ['capture', 'queue'],   // new
        // calendar key uses a function — check at least one calendar invalidation occurred
      ]),
    );
    // Calendar key is dynamic — check the predicate-based invalidation
    const hasCalendarInvalidation = spy.mock.calls.some((c) => {
      const arg = c[0] as any;
      return arg.predicate || (Array.isArray(arg.queryKey) && arg.queryKey[0] === 'calendar');
    });
    expect(hasCalendarInvalidation).toBe(true);
  });
});
```

Note: the exact `STOCK_DATES_QUERY_KEY` value is `['stockDates']` — confirm by:

```bash
grep -n "STOCK_DATES_QUERY_KEY" frontend/src/api/sse.ts
```

Adjust the expected array if it's different.

- [ ] **Step 3: Run test to verify it fails**

```bash
cd frontend && npm test -- sse.test.ts --run
```

Expected: FAIL — current handler only invalidates `STOCK_DATES_QUERY_KEY`.

- [ ] **Step 4: Extend the disconnect handler**

Edit `frontend/src/api/sse.ts:73-89`. Replace the `useEventStream` function:

```typescript
export function useEventStream() {
  const qc = useQueryClient();
  useEffect(() => {
    void open();
    const handler = (e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      } else if (e.type === 'disconnected') {
        // Server restart recovery: the backend restores the queue from
        // <data_dir>/.queue.json on lifespan startup (ADR-0019). When SSE
        // reconnects, refetch the queue + calendar + stock dates so the
        // UI reflects whatever the restored server is now doing.
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'queue'] });
        // Calendar keys are dynamic (code/year/month). Invalidate any query
        // whose key starts with 'calendar'.
        qc.invalidateQueries({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'calendar',
        });
      }
    };
    _subscribers.add(handler);
    return () => {
      _subscribers.delete(handler);
    };
  }, [qc]);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd frontend && npm test -- sse.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Run full frontend test suite**

```bash
cd frontend && npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 7: Run frontend type check**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/sse.ts frontend/src/api/sse.test.ts
git commit -m "$(cat <<'EOF'
feat(frontend): invalidate queue + calendar on SSE disconnect

After a server restart the backend now restores the queue from
.queue.json (ADR-0019), but the browser was only invalidating
stock-dates. Extend the disconnect handler to also refetch the
capture queue snapshot and any calendar queries so the UI
reflects the restored state without a manual page refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Adversarial manual verification + final polish

End-to-end manual test against running servers + final sweep.

**Files:**
- No code changes (verification only)

- [ ] **Step 1: Start backend with reload**

```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

- [ ] **Step 2: Start frontend**

In another terminal:

```bash
cd frontend && npm run dev
```

- [ ] **Step 3: Open `http://localhost:5173/capture` and enqueue items**

Use the UI to enqueue 005930 for a small date range (2-3 trading dates). Confirm the queue shows items.

- [ ] **Step 4: Confirm manifest exists on disk**

```bash
cat $(uv run python -c "from hoga.config import resolve_data_dir; print(resolve_data_dir())")/.queue.json
```

Should show JSON with `schema_version: 1`, `items: [...]`.

- [ ] **Step 5: Kill -9 the uvicorn process mid-capture**

Find the PID and:

```bash
kill -9 <uvicorn-pid>
```

- [ ] **Step 6: Restart uvicorn (same command as Step 1)**

Wait for it to come up.

- [ ] **Step 7: Verify the browser UI auto-recovers**

Without refreshing the page, observe the SSE auto-reconnect handler firing (Network tab in DevTools shows `/api/sse` reconnect, followed by `/api/captures/queue` re-fetch). The queue list should re-appear with the restored items, and any item that was mid-capture should resume from its `last_time_ms` cursor (visible in the phase pill + progress bar).

- [ ] **Step 8: Verify corrupt manifest does not break boot**

Stop uvicorn. Corrupt the manifest:

```bash
echo "garbage" > $(uv run python -c "from hoga.config import resolve_data_dir; print(resolve_data_dir())")/.queue.json
```

Restart uvicorn. Confirm:
- Server boots successfully (no crash)
- The original `.queue.json` is renamed to `.queue.json.corrupt-<ts>-parse_error_...`
- The UI shows an empty queue (the user re-enqueues manually)

```bash
ls $(uv run python -c "from hoga.config import resolve_data_dir; print(resolve_data_dir())")/.queue.json*
```

- [ ] **Step 9: Run the full test suite one more time**

```bash
uv run pytest tests/ -x --timeout=60
cd frontend && npm test -- --run && npm run typecheck
```

Expected: all green.

- [ ] **Step 10: Clean up the corruption test artifact**

```bash
rm $(uv run python -c "from hoga.config import resolve_data_dir; print(resolve_data_dir())")/.queue.json.corrupt-*
```

- [ ] **Step 11: Commit any cleanup**

If there are no code changes, skip the commit. Otherwise:

```bash
git add -A && git commit -m "chore: post-verification cleanup"
```

---

## Self-Review

Spec coverage check:
- [§3 합의된 결정](../specs/2026-05-24-capture-queue-persistence-design.md#3-합의된-결정) — JSON format (Task 2), atomic write (Task 1), schema_version (Task 2), write inside lock (Task 4), OSError absorption (Task 3), restore phase=queued (Task 5), auto-resume (Task 6), no done persistence (Task 4 — `_done` excluded), quarantine (Task 3), SSE disconnect (Task 7), ADR (already written).
- [§4 아키텍처](../specs/2026-05-24-capture-queue-persistence-design.md#4-아키텍처) — `_atomic_write.py` (Task 1), `captures_persistence.py` (Task 3), `captures.py` integration (Task 4), `app.py` lifespan (Task 6).
- [§6 엣지케이스](../specs/2026-05-24-capture-queue-persistence-design.md#6-손상엣지케이스) — Tasks 3, 5, 8 cover: missing file, parse failure, version mismatch, atomic-write durability, paused-state restore, today-too-early collector handling, raw-folder deletion (decide_capture → NONE).
- [§8 테스트](../specs/2026-05-24-capture-queue-persistence-design.md#8-테스트-전략) — Persistence tests (Task 3), captures queue tests extended (Task 4), restore tests (Task 5), integration (Task 6), frontend (Task 7), manual adversarial (Task 8).

All spec requirements have a task.

No placeholders found in the plan body — every step has either a code block or a runnable command.

Type consistency check:
- `QueueManifest` / `QueueManifestItem` — same casing throughout Tasks 2, 3, 4, 5.
- `_persist_queue_locked` — same name across Tasks 4, 5.
- `_restore_queue_from_manifest` — same name in Tasks 5, 6.
- `MANIFEST_FILENAME = ".queue.json"` — referenced consistently.
- Test file paths use `_` not `-` per existing convention (`test_api_captures_persistence.py`, etc.).

Plan ready for execution.

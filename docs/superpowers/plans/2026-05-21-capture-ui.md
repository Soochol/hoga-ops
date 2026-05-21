# Capture UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-app `/capture` page replacing the CLI-only placeholder — users start a hogaplay capture from the browser, see live progress (with a global LeftNav pill across all pages), and land on Inventory/Replay when it finishes.

**Architecture:** A new `hoga/api/captures.py` router exposes `POST /api/captures` + `GET/POST/DELETE /api/captures/latest`, runs `collect_stock_date` as an `asyncio` background task with a `CancelToken`, and publishes `capture_progress` / `capture_finished` events through the existing SSE bus. The frontend mounts a `useCaptureJob` hook that reads `/latest` and patches React Query cache on SSE events; `pages/Capture.tsx` renders a split form/progress view, and a `CaptureStatusPill` lives in `LeftNav` for cross-page visibility.

**Tech Stack:** FastAPI + asyncio (backend), React + TypeScript + Vite + React Query (frontend), pytest + Playwright (tests). No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-21-capture-ui-design.md`](../specs/2026-05-21-capture-ui-design.md)

---

## File Structure

### Backend (`hoga/`)

| File | Change | Responsibility |
|---|---|---|
| `hoga/collector/orchestrator.py` | Modify | Add `on_progress` callback + `CancelToken` parameters (non-breaking). Rename `_REGULAR_SESSION_CLOSE_HOUR` → `_DATA_WINDOW_CLOSE_HOUR`. Raise `CaptureCancelled` when token set. |
| `hoga/api/models.py` | Modify | Add `CaptureJob`, `CaptureProgress`, `CaptureResult`, `CaptureError` pydantic models (Wire Models). |
| `hoga/api/captures.py` | Create | Router + module-level `_latest` singleton + `asyncio.Lock` + background task wrapper + error mapping + multi-worker assertion. |
| `hoga/api/captures_fake.py` | Create | `FakeHogaplayClient` implementing `HogaplayClientProto` for E2E. |
| `hoga/api/app.py` | Modify | Register captures router; gate fake client on `HOGA_ENABLE_TEST_ENDPOINTS=1`. |

### Frontend (`frontend/src/`)

| File | Change | Responsibility |
|---|---|---|
| `frontend/src/api/types.ts` | Modify | Extend `SSEEvent` union with `capture_progress` / `capture_finished`; add `CaptureJob` mirror type. |
| `frontend/src/api/captures.ts` | Create | Typed wrappers: `getLatestCapture`, `startCapture`, `cancelLatest`, `dismissLatest`. |
| `frontend/src/api/sse.ts` | Modify | Add `capture_*` event listeners + new `subscribeToCaptureEvents` export; invalidate `['capture', 'latest']` on disconnect. |
| `frontend/src/util/time.ts` | Modify (or create) | Add `unixMsToKSTClock(ms: number): string` helper returning `HH:MM:SS`. |
| `frontend/src/capture/useCaptureJob.ts` | Create | Hook exposing `{ job, start, cancel, dismiss }` per spec §5.2. |
| `frontend/src/capture/CaptureForm.tsx` | Create | Form with validation + partial-capture preview. |
| `frontend/src/capture/CaptureProgress.tsx` | Create | Three big numbers + bar + cancel. |
| `frontend/src/capture/CaptureLog.tsx` | Create | Buffered last-10 log lines. |
| `frontend/src/capture/CaptureResult.tsx` | Create | Done / failed / cancelled summary + CTAs. |
| `frontend/src/pages/Capture.tsx` | Replace | Layout binding all of the above. |
| `frontend/src/nav/CaptureStatusPill.tsx` | Create | Global pill component. |
| `frontend/src/nav/LeftNav.tsx` | Modify | Insert pill between `flex-1` spacer and System Section. |
| `frontend/src/styles/global.css` | Modify | Add `@keyframes capture-pulse`. |

### Tests

| File | Change | Responsibility |
|---|---|---|
| `tests/test_collector_progress_callback.py` | Create | `on_progress` + cancel + CLI-behavior-unchanged. |
| `tests/test_api_captures.py` | Create | POST/GET/cancel/dismiss + 409s + error mapping. |
| `tests/test_api_sse_capture.py` | Create | SSE `capture_*` events 1:1 delivery + ordering. |
| `frontend/src/capture/useCaptureJob.test.tsx` | Create | Hook behavior under SSE + mutations. |
| `frontend/src/capture/CaptureForm.test.tsx` | Create | Validation + partial preview. |
| `frontend/src/nav/CaptureStatusPill.test.tsx` | Create | Render states. |
| `frontend/tests/e2e/capture-flow.spec.ts` | Create | End-to-end happy path with `FakeHogaplayClient`. |

---

## Phase 1 — Collector callback + cancel + rename

### Task 1: Add `ProgressEvent` dataclass + `on_progress` callback to collector

**Files:**
- Modify: `hoga/collector/orchestrator.py`
- Create: `tests/test_collector_progress_callback.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_collector_progress_callback.py
"""on_progress callback fires once per Page, carrying the same fields _progress.json holds."""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.collector.orchestrator import (
    ProgressEvent,
    collect_stock_date,
)


class _FakeClient:
    """Returns 3 tiny Pages then an empty Page, so the controller terminates."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        return "info_field\tvalue\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        # 5 fields: section, type, ?, global_seq, event_time
        seq_base = self.first_calls * 1000
        t_base = 90000000 + (self.first_calls - 1) * 60000  # 09:00:00 + N min
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i}\t000\t1000" for i in range(5)
        ) + "\n"

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        return ""


def test_on_progress_called_per_page(tmp_path: Path) -> None:
    events: list[ProgressEvent] = []
    client = _FakeClient()

    collect_stock_date(
        client=client,
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        allow_partial=True,
        on_progress=events.append,
    )

    assert len(events) >= 3, f"expected ≥3 progress events, got {len(events)}"
    for e in events:
        assert e.code == "005930"
        assert e.date == "20260520"
        assert e.pages_done >= 1
        assert e.events_seen >= 0
        assert e.frontier_hhmmss >= 84000000  # >= DATA_WINDOW_START_MS


def test_no_callback_keeps_cli_behavior(tmp_path: Path) -> None:
    """on_progress=None must not change collector output or raise."""
    client = _FakeClient()
    result = collect_stock_date(
        client=client,
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        allow_partial=True,
        on_progress=None,
    )
    assert result.pages_written >= 1
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pytest tests/test_collector_progress_callback.py -v
```

Expected: ImportError on `ProgressEvent` or TypeError on `on_progress` kwarg.

- [ ] **Step 3: Add `ProgressEvent` dataclass + `on_progress` parameter**

Edit `hoga/collector/orchestrator.py`:

Add near the top, after the existing dataclass:

```python
@dataclass(frozen=True)
class ProgressEvent:
    """Snapshot of capture progress, emitted after each Page write.

    `frontier_hhmmss` is the raw HHMMSSmmm value (collector encoding); the
    API layer converts to Unix-ms before publishing to clients (see
    CONTEXT.md `Capture Frontier`).
    """
    code: str
    date: str
    pages_done: int
    events_seen: int
    frontier_hhmmss: int
```

Modify `_page_step_loop` signature to accept `on_progress` and `code` (the loop already gets `code` — verify; if not, thread it through). After the existing `_write_progress(...)` call, emit:

```python
if on_progress is not None:
    on_progress(ProgressEvent(
        code=code, date=date,
        pages_done=page_idx,
        events_seen=len(seen_seqs),
        frontier_hhmmss=decision.progress_t,
    ))
```

Modify `collect_stock_date` signature:

```python
def collect_stock_date(
    *,
    client: HogaplayClientProto,
    code: str,
    date: str,
    data_dir: Path,
    rate_limit_s: float = 0.2,
    allow_partial: bool = False,
    resume: bool = False,
    on_progress: Callable[[ProgressEvent], None] | None = None,  # NEW
) -> CollectResult:
```

Thread `on_progress` into `_page_step_loop`.

Add import at top of file: `from collections.abc import Callable`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pytest tests/test_collector_progress_callback.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Run full collector suite to confirm CLI is unchanged**

```bash
pytest tests/test_collector_orchestrator.py tests/test_page_step.py -v
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_progress_callback.py
git commit -m "feat(collector): on_progress callback for live capture telemetry"
```

---

### Task 2: Add `CancelToken` + cooperative cancellation

**Files:**
- Modify: `hoga/collector/orchestrator.py`
- Modify: `tests/test_collector_progress_callback.py`

- [ ] **Step 1: Add failing test for cancellation**

Append to `tests/test_collector_progress_callback.py`:

```python
def test_cancel_token_stops_loop(tmp_path: Path) -> None:
    from hoga.collector.orchestrator import CancelToken, CaptureCancelled

    token = CancelToken()
    seen: list[ProgressEvent] = []

    def on_progress(e: ProgressEvent) -> None:
        seen.append(e)
        if len(seen) == 2:
            token.cancel()

    client = _FakeClient()
    with pytest.raises(CaptureCancelled):
        collect_stock_date(
            client=client,
            code="005930",
            date="20260520",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            allow_partial=True,
            on_progress=on_progress,
            cancel_token=token,
        )

    # Raw pages written before cancel are preserved.
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    written = sorted(raw_dir.glob("first_*.tsv"))
    assert len(written) >= 1
```

- [ ] **Step 2: Run to verify it fails**

```bash
pytest tests/test_collector_progress_callback.py::test_cancel_token_stops_loop -v
```

Expected: ImportError on `CancelToken` / `CaptureCancelled`.

- [ ] **Step 3: Implement `CancelToken` + cancellation**

In `hoga/collector/orchestrator.py`:

```python
import asyncio


class CaptureCancelled(RuntimeError):
    """Raised by collect_stock_date when its CancelToken is set."""


class CancelToken:
    """Thin asyncio.Event wrapper for cooperative cancellation.

    The API layer creates one token per job, passes it to collect_stock_date,
    and calls .cancel() on POST /api/captures/latest/cancel.
    """
    def __init__(self) -> None:
        self._event = asyncio.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()
```

Modify `collect_stock_date` signature to add `cancel_token: CancelToken | None = None`.

In `_page_step_loop`, at the top of the `while True` loop, check the token:

```python
while True:
    if cancel_token is not None and cancel_token.cancelled:
        raise CaptureCancelled(f"capture cancelled at page {page_idx}")
    body, page_idx, new_seqs = _fetch_and_store_page(...)
```

Also check immediately before the `chart.php` fetch in `collect_stock_date`:

```python
if cancel_token is not None and cancel_token.cancelled:
    raise CaptureCancelled(f"capture cancelled before chart fetch")
chart_body = client.fetch_chart(...)
```

Thread `cancel_token` into `_page_step_loop`.

- [ ] **Step 4: Run test to verify it passes**

```bash
pytest tests/test_collector_progress_callback.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Confirm CLI suite still green**

```bash
pytest tests/test_collector_orchestrator.py -v
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_progress_callback.py
git commit -m "feat(collector): CancelToken for cooperative capture cancellation"
```

---

### Task 3: Rename `_REGULAR_SESSION_CLOSE_HOUR` → `_DATA_WINDOW_CLOSE_HOUR`

**Files:**
- Modify: `hoga/collector/orchestrator.py`

- [ ] **Step 1: Rename and update comment + error message**

In `hoga/collector/orchestrator.py`:

```python
# Data Window closes at 16:00 KST (Regular Session close 15:30 +
# Auction Cross + After-Hours Trading 15:30–16:00). Captures before
# 16:00 on a today-date are partial — see CONTEXT.md.
_DATA_WINDOW_CLOSE_HOUR = 16
```

Update the only caller:

```python
def _is_partial_capture(date: str, now: dt.datetime) -> bool:
    ...
    return now.hour < _DATA_WINDOW_CLOSE_HOUR
```

Update `PartialCaptureRefused` message:

```python
raise PartialCaptureRefused(
    f"date={date} is today (KST) and the Data Window has not closed "
    f"(closes at {_DATA_WINDOW_CLOSE_HOUR}:00 KST). "
    "Pass --allow-partial to capture anyway."
)
```

- [ ] **Step 2: Run collector tests**

```bash
pytest tests/test_collector_orchestrator.py -v
```

Expected: all passing (rename is mechanical, behavior unchanged).

- [ ] **Step 3: Verify no stale references**

```bash
grep -rn "_REGULAR_SESSION_CLOSE_HOUR" hoga/ tests/
```

Expected: empty output.

- [ ] **Step 4: Commit**

```bash
git add hoga/collector/orchestrator.py
git commit -m "refactor(collector): rename _REGULAR_SESSION_CLOSE_HOUR → _DATA_WINDOW_CLOSE_HOUR

16:00 KST is the Data Window / After-Hours Trading close, not the
Regular Session close (15:30 per CONTEXT.md). Behavior unchanged."
```

---

## Phase 2 — Backend API: Wire Models + captures module

### Task 4: Add Wire Models for capture state

**Files:**
- Modify: `hoga/api/models.py`

- [ ] **Step 1: Append models**

Append to `hoga/api/models.py`:

```python
from typing import Literal


CapturePhase = Literal["capturing", "parsing", "done", "failed", "cancelled"]


class CaptureProgress(BaseModel):
    pages_done: int
    events_seen: int
    frontier_ms: int  # Unix epoch ms per ADR-0003 (converted from HHMMSSmmm)
    estimate_pct: int  # 0..98 — backend-computed (see spec §5.5)
    elapsed_ms: int


class CaptureResult(BaseModel):
    """Mirrors hoga.collector.orchestrator.CollectResult, plus parse outcome."""
    pages_written: int
    unique_events: int
    raw_dir: str  # absolute path as string
    parsed: bool  # True when capture_only=false and parse succeeded


class CaptureError(BaseModel):
    code: str  # see spec §4.1 error mapping table
    message: str
    at_page: int | None = None


class CaptureJob(BaseModel):
    job_id: str
    code: str
    date: str
    phase: CapturePhase
    options: dict  # {allow_partial, resume, capture_only}
    started_at_ms: int  # Unix ms, set just before collect_stock_date call
    progress: CaptureProgress | None = None
    result: CaptureResult | None = None
    error: CaptureError | None = None
```

- [ ] **Step 2: Verify import is clean**

```bash
python -c "from hoga.api.models import CaptureJob, CaptureProgress, CaptureResult, CaptureError; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add hoga/api/models.py
git commit -m "feat(api): Wire Models for capture state (CaptureJob and friends)"
```

---

### Task 5: Add error-mapping helper

**Files:**
- Create: `hoga/api/captures.py` (stub — full file in Task 6)
- Create: `tests/test_api_captures.py`

- [ ] **Step 1: Write failing test for error mapping**

```python
# tests/test_api_captures.py
"""Unit tests for hoga.api.captures._exception_to_error_code (spec §4.1 table)."""
from __future__ import annotations

from hoga.api.captures import _exception_to_error_code
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import CaptureCancelled, PartialCaptureRefused


def test_maps_partial_refused() -> None:
    assert _exception_to_error_code(PartialCaptureRefused("x")) == "partial_refused"


def test_maps_cookie_expired() -> None:
    assert _exception_to_error_code(CookieExpiredError("x")) == "cookie_expired"


def test_maps_hogaplay_http_error() -> None:
    assert _exception_to_error_code(HogaplayHTTPError("x")) == "hogaplay_http_error"


def test_capture_cancelled_returns_none() -> None:
    # CaptureCancelled is not an "error" — phase transitions to `cancelled`, not `failed`.
    assert _exception_to_error_code(CaptureCancelled("x")) is None


def test_maps_any_other_to_internal_error() -> None:
    assert _exception_to_error_code(RuntimeError("boom")) == "internal_error"
    assert _exception_to_error_code(ValueError("nope")) == "internal_error"
```

- [ ] **Step 2: Run to verify fail**

```bash
pytest tests/test_api_captures.py -v
```

Expected: ImportError on `hoga.api.captures`.

- [ ] **Step 3: Create minimal `hoga/api/captures.py`**

```python
"""Capture orchestration: route handlers + background asyncio task + singleton state.

See docs/superpowers/specs/2026-05-21-capture-ui-design.md §4.
"""
from __future__ import annotations

import os

from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import CaptureCancelled, PartialCaptureRefused

# Fail fast if someone runs uvicorn multi-worker — see spec §4.4.
if int(os.environ.get("WEB_CONCURRENCY", "1")) > 1:
    raise RuntimeError(
        "hoga-ops captures require a single uvicorn worker. "
        "Found WEB_CONCURRENCY > 1. Use `hoga serve` or pass --workers 1."
    )


def _exception_to_error_code(exc: BaseException) -> str | None:
    """Map a Python exception class to the API `code` field.

    Returns None for CaptureCancelled — that produces a `cancelled` phase,
    not a `failed` one.
    """
    if isinstance(exc, PartialCaptureRefused):
        return "partial_refused"
    if isinstance(exc, CookieExpiredError):
        return "cookie_expired"
    if isinstance(exc, HogaplayHTTPError):
        return "hogaplay_http_error"
    if isinstance(exc, CaptureCancelled):
        return None
    return "internal_error"
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pytest tests/test_api_captures.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures.py
git commit -m "feat(api): captures module stub + error code mapping"
```

---

### Task 6: Singleton state + asyncio Lock + start helper

**Files:**
- Modify: `hoga/api/captures.py`
- Modify: `tests/test_api_captures.py`

- [ ] **Step 1: Append failing tests for state lifecycle**

Append to `tests/test_api_captures.py`:

```python
import asyncio
import pytest

from hoga.api.captures import (
    CaptureJobState,
    get_latest,
    reset_state_for_tests,
)


@pytest.fixture(autouse=True)
def _reset_state() -> None:
    """Clear module-level singleton between tests."""
    reset_state_for_tests()


def test_get_latest_is_none_initially() -> None:
    assert get_latest() is None


def test_capture_job_state_initial_phase() -> None:
    state = CaptureJobState(
        job_id="20260521T100000-005930-20260520",
        code="005930",
        date="20260520",
        options={"allow_partial": False, "resume": False, "capture_only": False},
    )
    assert state.to_wire().phase == "capturing"
    assert state.to_wire().progress is None
    assert state.to_wire().error is None


@pytest.mark.asyncio
async def test_lock_acquire_release_roundtrip() -> None:
    from hoga.api.captures import _lock
    async with _lock:
        pass  # smoke test: lock is an asyncio.Lock, usable in async ctx
```

- [ ] **Step 2: Run to verify fail**

```bash
pytest tests/test_api_captures.py -v
```

Expected: ImportError on `CaptureJobState` / `get_latest` / `reset_state_for_tests`.

- [ ] **Step 3: Implement state + helpers**

Append to `hoga/api/captures.py`:

```python
import asyncio
from dataclasses import dataclass, field
from typing import Any

from hoga.api.models import (
    CaptureError,
    CaptureJob,
    CaptureProgress,
    CaptureResult,
)


@dataclass
class CaptureJobState:
    """Mutable server-side state for the current/last job. Not a Wire Model."""
    job_id: str
    code: str
    date: str
    options: dict[str, Any]
    phase: str = "capturing"
    started_at_ms: int = 0
    pages_done: int = 0
    events_seen: int = 0
    frontier_hhmmss: int = 0  # raw collector encoding
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    cancel_token: Any = None  # CancelToken; typed loosely to avoid circular import
    task: asyncio.Task | None = None

    def to_wire(self) -> CaptureJob:
        progress = None
        if self.pages_done > 0 or self.phase in ("capturing", "parsing"):
            progress = CaptureProgress(
                pages_done=self.pages_done,
                events_seen=self.events_seen,
                frontier_ms=0,  # filled by the route layer after timeenc conversion
                estimate_pct=self.estimate_pct,
                elapsed_ms=self.elapsed_ms,
            )
        return CaptureJob(
            job_id=self.job_id,
            code=self.code,
            date=self.date,
            phase=self.phase,  # type: ignore[arg-type]
            options=self.options,
            started_at_ms=self.started_at_ms,
            progress=progress,
            result=self.result,
            error=self.error,
        )

    @property
    def is_terminal(self) -> bool:
        return self.phase in ("done", "failed", "cancelled")


_lock = asyncio.Lock()
_latest: CaptureJobState | None = None


def get_latest() -> CaptureJobState | None:
    return _latest


def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears the module singleton."""
    global _latest
    _latest = None


def cancel_latest_on_shutdown() -> None:
    """Best-effort cancel called from app lifespan teardown. Raw pages on disk
    are preserved for the user to Resume; the asyncio task is abandoned (the
    server is going down anyway). See spec §9 'server restart loses state'.
    """
    if _latest is not None and not _latest.is_terminal and _latest.cancel_token is not None:
        _latest.cancel_token.cancel()
```

- [ ] **Step 4: Run to verify pass**

```bash
pytest tests/test_api_captures.py -v
```

Expected: all passing (8 total).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures.py
git commit -m "feat(api): captures singleton state + asyncio Lock"
```

---

### Task 7: Background task wrapper + progress conversion

**Files:**
- Modify: `hoga/api/captures.py`
- Modify: `tests/test_api_captures.py`

- [ ] **Step 1: Write failing integration test**

Append to `tests/test_api_captures.py`:

```python
from pathlib import Path

from hoga.api.captures import _run_capture_job


class _FakeFastClient:
    """3 pages then empty, no rate limit."""
    def __init__(self) -> None:
        self.first_calls = 0
    def fetch_info(self, code: str, date: str) -> str:
        return "k\tv\n"
    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        base = self.first_calls * 1000
        t = 90000000 + (self.first_calls - 1) * 60000
        return "\n".join(f"1\t1\t0\t{base+i}\t{t+i}\t0\t100" for i in range(3)) + "\n"
    def fetch_chart(self, code: str, date: str, time_ms: int, **_) -> str:
        return ""


@pytest.mark.asyncio
async def test_run_capture_job_reaches_done(tmp_path: Path) -> None:
    reset_state_for_tests()
    state = CaptureJobState(
        job_id="job-1",
        code="005930",
        date="20260520",
        options={"allow_partial": True, "resume": False, "capture_only": True},
    )
    # Register the state into module singleton manually for the helper.
    from hoga.api import captures as cap_mod
    cap_mod._latest = state

    await _run_capture_job(
        state=state,
        client=_FakeFastClient(),
        data_dir=tmp_path,
    )

    assert state.phase == "done"
    assert state.result is not None
    assert state.result.pages_written >= 1
    assert state.started_at_ms > 0
    assert state.pages_done >= 1
```

- [ ] **Step 2: Run to verify fail**

```bash
pytest tests/test_api_captures.py::test_run_capture_job_reaches_done -v
```

Expected: ImportError on `_run_capture_job`.

- [ ] **Step 3: Implement `_run_capture_job` + Unix-ms conversion**

Append to `hoga/api/captures.py`:

```python
import time
from pathlib import Path

from hoga.api.timeenc import hhmmssms_to_unix_ms  # existing helper per ADR-0003
from hoga.collector.orchestrator import (
    CancelToken,
    CaptureCancelled,
    ProgressEvent,
    collect_stock_date,
    DATA_WINDOW_START_MS,
    CHART_FINAL_TIME_MS,
)


# Bus injection point: the captures router holds a reference to the SSE _Bus
# AND the event loop, because the collector runs in a thread executor and its
# on_progress callback fires from the worker thread, NOT the event loop.
# asyncio.Queue.put_nowait is not loop-safe across threads — same reason the
# existing watchdog handler in sse.py:57 uses loop.call_soon_threadsafe.
_bus = None
_loop: asyncio.AbstractEventLoop | None = None


def set_bus(bus, loop: asyncio.AbstractEventLoop | None = None) -> None:
    """Wired from app.py during startup; see Task 10.

    `loop` is required for thread-safe publishes from the executor thread.
    Passing None turns _publish into a no-op (test mode).
    """
    global _bus, _loop
    _bus = bus
    _loop = loop


def _publish(evt: dict) -> None:
    """Thread-safe publish. Called from the executor thread for capture_*
    progress events; the call_soon_threadsafe hop ensures the SSE bus's
    asyncio.Queue.put_nowait runs on the event loop where the queue lives.
    """
    if _bus is None or _loop is None:
        return
    _loop.call_soon_threadsafe(_bus.publish, evt)


def _make_progress_callback(state: CaptureJobState):
    """Closure that updates `state` and emits an SSE event per ProgressEvent.

    Conversion seam (spec §4.3): HHMMSSmmm → Unix-ms happens HERE, not in collector.
    """
    def _on_progress(evt: ProgressEvent) -> None:
        state.pages_done = evt.pages_done
        state.events_seen = evt.events_seen
        state.frontier_hhmmss = evt.frontier_hhmmss
        state.elapsed_ms = int(time.time() * 1000) - state.started_at_ms
        # Estimate: % of Data Window covered (raw HHMMSSmmm math; see spec §5.5).
        span = CHART_FINAL_TIME_MS - DATA_WINDOW_START_MS
        offset = max(0, evt.frontier_hhmmss - DATA_WINDOW_START_MS)
        state.estimate_pct = min(98, max(0, int(100 * offset / span)))
        # SSE payload uses Unix-ms.
        frontier_unix = hhmmssms_to_unix_ms(evt.date, evt.frontier_hhmmss)
        _publish({
            "type": "capture_progress",
            "job_id": state.job_id,
            "code": state.code,
            "date": state.date,
            "phase": state.phase,
            "pages_done": state.pages_done,
            "events_seen": state.events_seen,
            "frontier_ms": frontier_unix,
            "estimate_pct": state.estimate_pct,
            "elapsed_ms": state.elapsed_ms,
        })
    return _on_progress


async def _run_capture_job(
    *,
    state: CaptureJobState,
    client,
    data_dir: Path,
) -> None:
    """Runs collector (+ optional parse) on the asyncio event loop.

    Sets state.started_at_ms just before the collector entry per spec §4.1
    'started_at_ms definition'. collect_stock_date is sync; we run it in a
    thread executor so the event loop stays free for SSE / other requests.
    """
    state.cancel_token = CancelToken()
    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    _publish({
        "type": "capture_phase",
        "job_id": state.job_id, "code": state.code, "date": state.date,
        "phase": state.phase,
    })

    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            None,
            lambda: collect_stock_date(
                client=client,
                code=state.code,
                date=state.date,
                data_dir=data_dir,
                rate_limit_s=0.0 if state.options.get("_fast_test", False) else 0.2,
                allow_partial=bool(state.options.get("allow_partial", False)),
                resume=bool(state.options.get("resume", False)),
                on_progress=_make_progress_callback(state),
                cancel_token=state.cancel_token,
            ),
        )
        parsed = False
        if not state.options.get("capture_only", False):
            state.phase = "parsing"
            _publish({
                "type": "capture_phase",
                "job_id": state.job_id, "code": state.code, "date": state.date,
                "phase": state.phase,
            })
            from hoga.parser import parse_stock_date
            await loop.run_in_executor(
                None,
                lambda: parse_stock_date(
                    code=state.code,
                    date=state.date,
                    data_dir=data_dir,
                    lenient=False,
                ),
            )
            parsed = True

        state.result = CaptureResult(
            pages_written=result.pages_written,
            unique_events=result.unique_events,
            raw_dir=str(result.raw_dir),
            parsed=parsed,
        )
        state.phase = "done"
    except CaptureCancelled:
        state.phase = "cancelled"
    except BaseException as exc:  # noqa: BLE001 — terminal failure path
        code = _exception_to_error_code(exc)
        state.error = CaptureError(
            code=code or "internal_error",
            message=str(exc),
            at_page=state.pages_done or None,
        )
        state.phase = "failed"

    _publish({
        "type": "capture_finished",
        "job_id": state.job_id, "code": state.code, "date": state.date,
        "phase": state.phase,
        "result": state.result.model_dump() if state.result else None,
        "error": state.error.model_dump() if state.error else None,
    })
```

Also enable the fast-test rate limit. Update the test in Step 1 to include `"_fast_test": True` in `options` if needed (already correct since allow_partial test path is what matters).

Actually — looking at the test, we should set `_fast_test=True` to skip the rate_limit_s sleep in tests. Update the test:

```python
state = CaptureJobState(
    job_id="job-1",
    code="005930",
    date="20260520",
    options={"allow_partial": True, "resume": False, "capture_only": True, "_fast_test": True},
)
```

- [ ] **Step 4: Run test to verify pass**

```bash
pytest tests/test_api_captures.py::test_run_capture_job_reaches_done -v
```

Expected: passing.

- [ ] **Step 5: Run all captures tests**

```bash
pytest tests/test_api_captures.py -v
```

Expected: all passing (9 total).

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures.py
git commit -m "feat(api): background capture task + Unix-ms conversion seam"
```

---

### Task 8: HTTP routes — POST /api/captures + 409 + partial_refused

**Files:**
- Modify: `hoga/api/captures.py`
- Modify: `tests/test_api_captures.py`

- [ ] **Step 1: Write failing route tests**

Append to `tests/test_api_captures.py`:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.captures import build_router


def _make_app(tmp_path: Path, fake_client_factory) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(
        data_dir=tmp_path,
        client_factory=fake_client_factory,
    ))
    return TestClient(app)


def test_post_captures_returns_201(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, lambda: _FakeFastClient())
    r = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["code"] == "005930"
    assert body["date"] == "20260520"
    assert body["phase"] == "capturing"
    assert body["options"]["allow_partial"] is True


def test_post_captures_400_partial_refused(tmp_path: Path, monkeypatch) -> None:
    """Today's KST date with allow_partial=false → 400 partial_refused.

    Mocks the KST clock used by _is_partial_capture by patching `datetime.now`
    inside hoga.collector.orchestrator so the route's guard sees 'today'.
    """
    import datetime as _dt
    from hoga.collector import orchestrator as orch

    # Pretend today is 2026-05-20 at 10:00 KST (before 16:00 Data Window close).
    fixed_now = _dt.datetime(2026, 5, 20, 10, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))

    class _FixedDateTime(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed_now

    monkeypatch.setattr(orch.dt, "datetime", _FixedDateTime)
    # Also patch the captures router's datetime if it imports its own.
    from hoga.api import captures as cap_mod
    monkeypatch.setattr(cap_mod, "datetime", _FixedDateTime, raising=False)

    reset_state_for_tests()
    client = _make_app(tmp_path, lambda: _FakeFastClient())
    r = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",  # matches fixed_now date
        "allow_partial": False, "resume": False, "capture_only": True,
    })
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "partial_refused"


def test_post_captures_409_when_running(tmp_path: Path) -> None:
    reset_state_for_tests()
    # Fake client that blocks forever on fetch_first so the first job stays running.
    class _BlockingClient:
        def fetch_info(self, *_, **__): return "k\tv\n"
        def fetch_first(self, *_, **__):
            import time; time.sleep(10); return ""
        def fetch_chart(self, *_, **__): return ""
    client = _make_app(tmp_path, lambda: _BlockingClient())
    r1 = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    assert r1.status_code == 201
    r2 = client.post("/api/captures", json={
        "code": "000660", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    assert r2.status_code == 409
    assert r2.json()["detail"]["latest"]["code"] == "005930"
```

- [ ] **Step 2: Run to verify fail**

```bash
pytest tests/test_api_captures.py::test_post_captures_returns_201 -v
```

Expected: ImportError on `build_router`.

- [ ] **Step 3: Implement `build_router` + POST handler**

Append to `hoga/api/captures.py`:

```python
from collections.abc import Callable
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


KST = timezone(timedelta(hours=9))


class StartCaptureRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    date: str = Field(pattern=r"^\d{8}$")
    allow_partial: bool = False
    resume: bool = False
    capture_only: bool = False


def _make_job_id(code: str, date: str) -> str:
    now = datetime.now(tz=KST).strftime("%Y%m%dT%H%M%S")
    return f"{now}-{code}-{date}"


def _state_to_wire(state: CaptureJobState) -> CaptureJob:
    """Wrap to_wire() with the timeenc conversion for frontier_ms."""
    wire = state.to_wire()
    if wire.progress is not None and state.frontier_hhmmss:
        # Mutate progress with converted frontier
        wire = wire.model_copy(update={
            "progress": wire.progress.model_copy(update={
                "frontier_ms": hhmmssms_to_unix_ms(state.date, state.frontier_hhmmss),
            }),
        })
    return wire


def build_router(
    *,
    data_dir: Path,
    client_factory: Callable[[], object],
) -> APIRouter:
    """Build the captures router.

    `client_factory()` returns a fresh HogaplayClientProto. In production this
    yields a real HogaplayClient; tests inject a fake.
    """
    router = APIRouter(prefix="/api/captures", tags=["captures"])

    @router.post("", status_code=201)
    async def start_capture(req: StartCaptureRequest) -> CaptureJob:
        global _latest
        async with _lock:
            if _latest is not None and not _latest.is_terminal:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "already_running", "latest": _state_to_wire(_latest).model_dump()},
                )
            # Backend re-validation of partial capture (defense in depth).
            from hoga.collector.orchestrator import _is_partial_capture
            now_kst = datetime.now(tz=KST)
            if not req.allow_partial and _is_partial_capture(req.date, now_kst):
                raise HTTPException(
                    status_code=400,
                    detail={"code": "partial_refused",
                            "message": f"date={req.date} is today (KST) before Data Window close."},
                )

            state = CaptureJobState(
                job_id=_make_job_id(req.code, req.date),
                code=req.code,
                date=req.date,
                options={
                    "allow_partial": req.allow_partial,
                    "resume": req.resume,
                    "capture_only": req.capture_only,
                },
            )
            _latest = state
            client = client_factory()
            state.task = asyncio.create_task(
                _run_capture_job(state=state, client=client, data_dir=data_dir)
            )
            return _state_to_wire(state)

    return router
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pytest tests/test_api_captures.py -v
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures.py
git commit -m "feat(api): POST /api/captures with 409 + partial_refused guards"
```

---

### Task 9: GET /latest + POST /latest/cancel + DELETE /latest

**Files:**
- Modify: `hoga/api/captures.py`
- Modify: `tests/test_api_captures.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
def test_get_latest_null_when_idle(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, lambda: _FakeFastClient())
    r = client.get("/api/captures/latest")
    assert r.status_code == 200
    assert r.json() is None


def test_cancel_when_idle_409(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, lambda: _FakeFastClient())
    r = client.post("/api/captures/latest/cancel")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "not_running"


def test_dismiss_when_idle_204(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, lambda: _FakeFastClient())
    r = client.delete("/api/captures/latest")
    assert r.status_code == 204


def test_cancel_happy_path_202(tmp_path: Path) -> None:
    """POST /latest/cancel on a running job returns 202; job ends as cancelled."""
    reset_state_for_tests()
    class _SlowClient:
        def __init__(self): self.calls = 0
        def fetch_info(self, *_, **__): return "k\tv\n"
        def fetch_first(self, *_, **__):
            import time; time.sleep(0.5); self.calls += 1
            if self.calls > 100: return ""
            return "1\t1\t0\t1\t90000000\t0\t100\n"
        def fetch_chart(self, *_, **__): return ""
    client = _make_app(tmp_path, lambda: _SlowClient())
    client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    r = client.post("/api/captures/latest/cancel")
    assert r.status_code == 202
    # Poll until terminal
    import time
    for _ in range(50):
        time.sleep(0.1)
        latest = client.get("/api/captures/latest").json()
        if latest and latest["phase"] == "cancelled":
            break
    assert latest["phase"] == "cancelled"


@pytest.mark.asyncio
async def test_run_capture_job_failed_branch(tmp_path: Path) -> None:
    """Collector raises a non-cancellation exception → phase=failed, error populated."""
    from hoga.collector.client import CookieExpiredError
    reset_state_for_tests()
    state = CaptureJobState(
        job_id="job-f",
        code="005930",
        date="20260520",
        options={"allow_partial": True, "resume": False, "capture_only": True, "_fast_test": True},
    )
    from hoga.api import captures as cap_mod
    cap_mod._latest = state

    class _BadClient:
        def fetch_info(self, *_, **__): raise CookieExpiredError("401 from /info.php")
        def fetch_first(self, *_, **__): return ""
        def fetch_chart(self, *_, **__): return ""

    await _run_capture_job(state=state, client=_BadClient(), data_dir=tmp_path)
    assert state.phase == "failed"
    assert state.error is not None
    assert state.error.code == "cookie_expired"


@pytest.mark.asyncio
async def test_run_capture_job_cancelled_branch(tmp_path: Path) -> None:
    """cancel_token set mid-flight → phase=cancelled, no error, raw preserved."""
    reset_state_for_tests()
    state = CaptureJobState(
        job_id="job-c",
        code="005930",
        date="20260520",
        options={"allow_partial": True, "resume": False, "capture_only": True, "_fast_test": True},
    )
    from hoga.api import captures as cap_mod
    cap_mod._latest = state

    class _SlowClient:
        def __init__(self): self.calls = 0
        def fetch_info(self, *_, **__): return "k\tv\n"
        def fetch_first(self, *_, **__):
            import time; time.sleep(0.05); self.calls += 1
            if self.calls > 50: return ""
            return f"1\t1\t0\t{self.calls}\t{90000000 + self.calls * 60000}\t0\t100\n"
        def fetch_chart(self, *_, **__): return ""

    async def cancel_soon():
        await asyncio.sleep(0.2)
        if state.cancel_token is not None:
            state.cancel_token.cancel()

    cancel_task = asyncio.create_task(cancel_soon())
    await _run_capture_job(state=state, client=_SlowClient(), data_dir=tmp_path)
    await cancel_task
    assert state.phase == "cancelled"
    assert state.error is None
    # Raw files preserved
    raw_dir = tmp_path / "raw" / "20260520" / "005930"
    assert len(list(raw_dir.glob("first_*.tsv"))) >= 1


def test_dismiss_when_running_409(tmp_path: Path) -> None:
    reset_state_for_tests()
    class _BlockingClient:
        def fetch_info(self, *_, **__): return "k\tv\n"
        def fetch_first(self, *_, **__):
            import time; time.sleep(10); return ""
        def fetch_chart(self, *_, **__): return ""
    client = _make_app(tmp_path, lambda: _BlockingClient())
    client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    r = client.delete("/api/captures/latest")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "still_running"
```

- [ ] **Step 2: Run to verify fail**

```bash
pytest tests/test_api_captures.py::test_get_latest_null_when_idle -v
```

Expected: 404 (route not defined yet).

- [ ] **Step 3: Implement the three endpoints**

Inside `build_router`, after the POST handler, add:

```python
    @router.get("/latest")
    async def get_latest_route() -> CaptureJob | None:
        if _latest is None:
            return None
        return _state_to_wire(_latest)

    @router.post("/latest/cancel", status_code=202)
    async def cancel_latest() -> dict:
        global _latest
        if _latest is None or _latest.is_terminal:
            raise HTTPException(
                status_code=409,
                detail={"code": "not_running",
                        "message": "no running capture to cancel"},
            )
        if _latest.cancel_token is not None:
            _latest.cancel_token.cancel()
        return {"status": "cancel_signal_delivered", "job_id": _latest.job_id}

    @router.delete("/latest", status_code=204)
    async def dismiss_latest() -> None:
        global _latest
        if _latest is not None and not _latest.is_terminal:
            raise HTTPException(
                status_code=409,
                detail={"code": "still_running",
                        "message": "cancel the running capture before dismissing"},
            )
        _latest = None
        # FastAPI infers 204 from the decorator; returning None is correct.
```

- [ ] **Step 4: Run tests**

```bash
pytest tests/test_api_captures.py -v
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures.py
git commit -m "feat(api): GET /latest + POST /latest/cancel + DELETE /latest"
```

---

### Task 10: Wire SSE bus into captures + capture_finished after collector

**Files:**
- Modify: `hoga/api/captures.py`
- Modify: `hoga/api/app.py`
- Create: `tests/test_api_sse_capture.py`

- [ ] **Step 1: Write failing SSE test**

```python
# tests/test_api_sse_capture.py
"""SSE bus delivers capture_* events 1:1 (no throttling in v1+1)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
import uvicorn

from hoga.api.app import create_app


async def _wait_started(server: uvicorn.Server, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not server.started:
        if asyncio.get_running_loop().time() > deadline:
            raise RuntimeError("server did not start")
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_sse_capture_finished_after_progress(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    app = create_app(data_dir)

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        await _wait_started(server)
        port = server.servers[0].sockets[0].getsockname()[1]
        base = f"http://127.0.0.1:{port}"

        # Subscribe to SSE first
        sse_events: list[dict] = []
        async def collect_events():
            async with httpx.AsyncClient(timeout=10) as client, \
                       client.stream("GET", f"{base}/api/events") as r:
                buf = ""
                async for chunk in r.aiter_text():
                    buf += chunk
                    while "\n\n" in buf:
                        block, buf = buf.split("\n\n", 1)
                        evt_type = ""
                        evt_data = ""
                        for line in block.splitlines():
                            if line.startswith("event:"):
                                evt_type = line.split(":", 1)[1].strip()
                            elif line.startswith("data:"):
                                evt_data = line.split(":", 1)[1].strip()
                        if evt_type.startswith("capture_"):
                            sse_events.append({"type": evt_type,
                                               "data": json.loads(evt_data) if evt_data else {}})
                        if evt_type == "capture_finished":
                            return

        collect_task = asyncio.create_task(collect_events())
        await asyncio.sleep(0.1)  # let SSE subscribe

        # Start a fake capture
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.post(f"{base}/api/captures", json={
                "code": "005930", "date": "20260520",
                "allow_partial": True, "resume": False, "capture_only": True,
            })
            assert r.status_code == 201

        await asyncio.wait_for(collect_task, timeout=15)

        # At least one progress + one terminal finished, in order
        terminal_idx = next(i for i, e in enumerate(sse_events)
                            if e["type"] == "capture_finished")
        progress_count = sum(1 for e in sse_events[:terminal_idx]
                             if e["type"] == "capture_progress")
        assert progress_count >= 1, sse_events
        assert sse_events[terminal_idx]["data"]["phase"] in {"done", "failed"}
    finally:
        server.should_exit = True
        await task
```

This test depends on the fake client being wired in `app.py` under the test env flag — which is Task 13. Mark this test with `pytest.mark.skip` for now and re-enable after Task 13:

```python
@pytest.mark.skip(reason="enable after Task 13 wires FakeHogaplayClient")
@pytest.mark.asyncio
async def test_sse_capture_finished_after_progress(...):
    ...
```

- [ ] **Step 2: Wire bus into captures router in `app.py`**

Edit `hoga/api/app.py`:

```python
from hoga.api.captures import build_router as build_captures_router
from hoga.api.captures import set_bus as set_captures_bus
from hoga.api.captures import cancel_latest_on_shutdown
from hoga.collector.client import HogaplayClient
from hoga.config import Config


def create_app(data_dir: Path) -> FastAPI:
    engine = QueryEngine(data_dir)
    sse_router, bus, observer = build_sse(data_dir / "parquet")

    # Default client factory: a fresh real client per capture (reads .cookie).
    def _real_client_factory():
        cfg = Config.from_cwd()
        cookie = cfg.cookie()
        return HogaplayClient(cookie=cookie)

    client_factory = _real_client_factory

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        observer.start()
        set_captures_bus(bus, asyncio.get_running_loop())  # bus + loop for thread-safe publishes
        try:
            yield
        finally:
            observer.stop()
            observer.join()
            engine.close()
            # Best-effort cancel of an in-flight job at shutdown — raw files
            # are preserved on disk for Resume. Spec §9 documents this behavior.
            cancel_latest_on_shutdown()
            set_captures_bus(None, None)

    app = FastAPI(title="hoga-ops API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    app.include_router(build_router(engine))
    app.include_router(sse_router)
    app.include_router(build_captures_router(data_dir=data_dir, client_factory=client_factory))
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        app.include_router(build_test_router(data_dir))
    app.state.engine = engine
    return app
```

- [ ] **Step 3: Verify existing route tests still pass**

```bash
pytest tests/test_api.py tests/test_api_session.py tests/test_api_sse.py -v
```

Expected: all passing.

- [ ] **Step 4: Add the SSE event type to `/api/events` stream**

The existing `hoga/api/sse.py` already publishes any `evt["type"]` as the event name. No code change needed — confirm by reading the file:

```bash
grep -n 'yield {"event"' hoga/api/sse.py
```

Expected: `yield {"event": evt["type"], "data": json.dumps(evt)}` — already correct.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures.py hoga/api/app.py tests/test_api_sse_capture.py
git commit -m "feat(api): wire SSE bus into captures + register router in app"
```

---

## Phase 3 — Fake hogaplay client for E2E

### Task 11: `FakeHogaplayClient` + DI wiring

**Files:**
- Create: `hoga/api/captures_fake.py`
- Modify: `hoga/api/app.py`
- Modify: `tests/test_api_sse_capture.py` (un-skip)

- [ ] **Step 1: Implement the fake client**

```python
# hoga/api/captures_fake.py
"""FakeHogaplayClient — used only when HOGA_ENABLE_TEST_ENDPOINTS=1.

Implements HogaplayClientProto with deterministic in-memory data.
Each fetch_first call returns a small Page; the loop terminates after 5 Pages.
Used by Playwright capture-flow.spec.ts and the SSE integration test.
"""
from __future__ import annotations

import time


class FakeHogaplayClient:
    """In-memory hogaplay stub. Single-instance reuse fine."""

    def __init__(self) -> None:
        self._first_call = 0

    def fetch_info(self, code: str, date: str) -> str:
        return (
            f"code\t{code}\nname\tFakeCorp\n"
            "session_open\t90000000\nsession_close\t153000000\n"
        )

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        self._first_call += 1
        # 150ms throttle so the collector emits ~5 progress events over ~750ms.
        time.sleep(0.15)
        if self._first_call > 5:
            return ""
        seq_base = self._first_call * 100
        t_base = 90000000 + (self._first_call - 1) * 60000  # 09:00 + N min
        rows = [
            f"1\t1\t0\t{seq_base + i}\t{t_base + i * 100}\t000\t1000"
            for i in range(20)
        ]
        return "\n".join(rows) + "\n"

    def fetch_chart(self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000) -> str:
        return f"chart\t{code}\t{date}\n"
```

- [ ] **Step 2: Wire DI in `app.py`**

Edit `create_app`:

```python
    # Choose client factory: fake when the test env flag is set.
    if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
        from hoga.api.captures_fake import FakeHogaplayClient
        client_factory = lambda: FakeHogaplayClient()  # noqa: E731
    else:
        client_factory = _real_client_factory
```

- [ ] **Step 3: Un-skip the SSE test**

In `tests/test_api_sse_capture.py`, remove the `@pytest.mark.skip(...)` decorator.

- [ ] **Step 4: Run**

```bash
pytest tests/test_api_sse_capture.py -v
```

Expected: passing (may take ~10s due to 5×150ms collector pacing).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/captures_fake.py hoga/api/app.py tests/test_api_sse_capture.py
git commit -m "feat(api): FakeHogaplayClient with DI for E2E tests"
```

---

## Phase 4 — Frontend types, API client, hook

### Task 12: TypeScript types for capture state + SSE events

**Files:**
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Extend types**

Read the current file first:

```bash
cat frontend/src/api/types.ts
```

Append (or merge appropriately):

```typescript
export type CapturePhase = 'capturing' | 'parsing' | 'done' | 'failed' | 'cancelled';

export interface CaptureProgress {
  pages_done: number;
  events_seen: number;
  frontier_ms: number; // Unix epoch ms per ADR-0003
  estimate_pct: number;
  elapsed_ms: number;
}

export interface CaptureResult {
  pages_written: number;
  unique_events: number;
  raw_dir: string;
  parsed: boolean;
}

export interface CaptureError {
  code: string;
  message: string;
  at_page?: number | null;
}

export interface CaptureJob {
  job_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
  options: { allow_partial: boolean; resume: boolean; capture_only: boolean };
  started_at_ms: number;
  progress: CaptureProgress | null;
  result: CaptureResult | null;
  error: CaptureError | null;
}
```

Extend the existing `SSEEvent` union:

```typescript
export type SSEEvent =
  | { type: 'inventory_added'; code: string; date: string }
  | { type: 'inventory_removed'; code: string; date: string }
  | { type: 'capture_progress'; job_id: string; code: string; date: string;
      phase: CapturePhase; pages_done: number; events_seen: number;
      frontier_ms: number; estimate_pct: number; elapsed_ms: number }
  | { type: 'capture_phase'; job_id: string; code: string; date: string; phase: CapturePhase }
  | { type: 'capture_finished'; job_id: string; code: string; date: string;
      phase: CapturePhase; result: CaptureResult | null; error: CaptureError | null }
  | { type: 'heartbeat' }
  | { type: 'disconnected' };
```

- [ ] **Step 2: Run typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: passing.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend): TypeScript mirrors of Capture Wire Models + SSE events"
```

---

### Task 13: API client wrappers

**Files:**
- Create: `frontend/src/api/captures.ts`

- [ ] **Step 1: Implement client**

```typescript
// frontend/src/api/captures.ts
import { apiUrl } from './client';
import type { CaptureJob } from './types';

export interface StartCaptureArgs {
  code: string;
  date: string;
  allow_partial: boolean;
  resume: boolean;
  capture_only: boolean;
}

export async function getLatestCapture(): Promise<CaptureJob | null> {
  const url = await apiUrl('/api/captures/latest');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/captures/latest failed: ${r.status}`);
  return r.json();
}

export async function startCapture(args: StartCaptureArgs): Promise<CaptureJob> {
  const url = await apiUrl('/api/captures');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const detail = body?.detail;
    const err = new Error(detail?.message ?? `POST /api/captures ${r.status}`);
    (err as { code?: string; status?: number }).code = detail?.code;
    (err as { code?: string; status?: number }).status = r.status;
    throw err;
  }
  return r.json();
}

export async function cancelLatest(): Promise<void> {
  const url = await apiUrl('/api/captures/latest/cancel');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok && r.status !== 409) throw new Error(`cancel failed: ${r.status}`);
}

export async function dismissLatest(): Promise<void> {
  const url = await apiUrl('/api/captures/latest');
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok && r.status !== 409) throw new Error(`dismiss failed: ${r.status}`);
}
```

- [ ] **Step 2: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: passing.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/captures.ts
git commit -m "feat(frontend): API client for /api/captures"
```

---

### Task 14: Extend SSE plumbing with `capture_*` events

**Files:**
- Modify: `frontend/src/api/sse.ts`

- [ ] **Step 1: Add listeners + export subscriber**

Edit `frontend/src/api/sse.ts`. In the `open()` function, after the existing `inventory_*` listeners, add:

```typescript
    src.addEventListener('capture_progress', (e: MessageEvent) =>
      emit({ type: 'capture_progress', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_phase', (e: MessageEvent) =>
      emit({ type: 'capture_phase', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_finished', (e: MessageEvent) =>
      emit({ type: 'capture_finished', ...JSON.parse(e.data) }),
    );
```

Add a focused subscriber export at the bottom of the file (alongside `useEventStream`):

```typescript
export function subscribeToCaptureEvents(handler: (e: SSEEvent) => void): () => void {
  const wrapped = (e: SSEEvent) => {
    if (
      e.type === 'capture_progress' ||
      e.type === 'capture_phase' ||
      e.type === 'capture_finished'
    ) {
      handler(e);
    }
  };
  _subscribers.add(wrapped);
  return () => {
    _subscribers.delete(wrapped);
  };
}
```

Extend the existing `useEventStream` handler so SSE disconnect also invalidates capture state (spec §10 follow-up):

```typescript
    const handler = (e: SSEEvent) => {
      if (e.type === 'inventory_added' || e.type === 'inventory_removed') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
      } else if (e.type === 'disconnected') {
        qc.invalidateQueries({ queryKey: STOCK_DATES_QUERY_KEY });
        qc.invalidateQueries({ queryKey: ['capture', 'latest'] });
      }
    };
```

Make sure `open()` calls `void open()` even when capture-only subscribers are registered. Confirm by reading: `useEventStream` already calls `void open()` on mount — adding a separate subscriber via `subscribeToCaptureEvents` doesn't open the EventSource. **Fix this** by also calling `void open()` in `subscribeToCaptureEvents`:

```typescript
export function subscribeToCaptureEvents(handler: (e: SSEEvent) => void): () => void {
  void open();
  ...
}
```

- [ ] **Step 2: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: passing.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/sse.ts
git commit -m "feat(frontend): SSE listeners + subscribeToCaptureEvents export"
```

---

### Task 15: `useCaptureJob` hook + tests

**Files:**
- Create: `frontend/src/capture/useCaptureJob.ts`
- Create: `frontend/src/capture/useCaptureJob.test.tsx`

- [ ] **Step 1: Implement the hook**

```typescript
// frontend/src/capture/useCaptureJob.ts
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelLatest,
  dismissLatest,
  getLatestCapture,
  startCapture,
} from '../api/captures';
import { subscribeToCaptureEvents } from '../api/sse';
import type { CaptureJob } from '../api/types';

const KEY = ['capture', 'latest'] as const;

export function useCaptureJob() {
  const qc = useQueryClient();

  const job = useQuery<CaptureJob | null>({
    queryKey: KEY,
    queryFn: getLatestCapture,
    staleTime: 0,
  });

  useEffect(() => {
    const off = subscribeToCaptureEvents((e) => {
      if (e.type === 'capture_progress') {
        qc.setQueryData<CaptureJob | null>(KEY, (prev) =>
          prev && prev.job_id === e.job_id
            ? {
                ...prev,
                phase: e.phase,
                progress: {
                  pages_done: e.pages_done,
                  events_seen: e.events_seen,
                  frontier_ms: e.frontier_ms,
                  estimate_pct: e.estimate_pct,
                  elapsed_ms: e.elapsed_ms,
                },
              }
            : prev,
        );
      } else if (e.type === 'capture_phase') {
        qc.setQueryData<CaptureJob | null>(KEY, (prev) =>
          prev && prev.job_id === e.job_id ? { ...prev, phase: e.phase } : prev,
        );
      } else if (e.type === 'capture_finished') {
        qc.invalidateQueries({ queryKey: KEY });
      }
    });
    return off;
  }, [qc]);

  const start = useMutation({
    mutationFn: startCapture,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const cancel = useMutation({
    mutationFn: cancelLatest,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const dismiss = useMutation({
    mutationFn: dismissLatest,
    onSuccess: () => qc.setQueryData(KEY, null),
  });

  return {
    job: job.data ?? null,
    isLoading: job.isLoading,
    start,
    cancel,
    dismiss,
  };
}
```

- [ ] **Step 2: Add hook test**

```tsx
// frontend/src/capture/useCaptureJob.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCaptureJob } from './useCaptureJob';

vi.mock('../api/captures', () => ({
  getLatestCapture: vi.fn().mockResolvedValue(null),
  startCapture: vi.fn().mockResolvedValue({
    job_id: 'j1', code: '005930', date: '20260520', phase: 'capturing',
    options: { allow_partial: false, resume: false, capture_only: false },
    started_at_ms: 0, progress: null, result: null, error: null,
  }),
  cancelLatest: vi.fn(),
  dismissLatest: vi.fn(),
}));

vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: vi.fn().mockReturnValue(() => {}),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useCaptureJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null job initially', async () => {
    const { result } = renderHook(() => useCaptureJob(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.job).toBeNull();
  });
});
```

- [ ] **Step 3: Run frontend tests**

```bash
cd frontend && npm test -- useCaptureJob
```

Expected: passing.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/capture/useCaptureJob.ts frontend/src/capture/useCaptureJob.test.tsx
git commit -m "feat(frontend): useCaptureJob hook with SSE patching + mutations"
```

---

## Phase 5 — Frontend UI components

### Task 16: Time helper for Capture Frontier display

**Files:**
- Modify (or create): `frontend/src/util/time.ts`

- [ ] **Step 1: Add `unixMsToKSTClock` helper**

Append to `frontend/src/util/time.ts` (create if missing):

```typescript
/** Format a Unix-ms timestamp as HH:MM:SS in KST (UTC+9). */
export function unixMsToKSTClock(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // shift to KST
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Format milliseconds as M:SS or H:MM:SS. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Add a tiny test**

Create `frontend/src/util/time.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { unixMsToKSTClock, formatElapsed } from './time';

describe('unixMsToKSTClock', () => {
  it('formats midnight KST as 00:00:00', () => {
    // 2026-05-20 00:00:00 KST == 2026-05-19 15:00:00 UTC
    const unixMs = Date.UTC(2026, 4, 19, 15, 0, 0);
    expect(unixMsToKSTClock(unixMs)).toBe('00:00:00');
  });
  it('formats 13:24:00 KST', () => {
    const unixMs = Date.UTC(2026, 4, 20, 4, 24, 0); // 04:24 UTC = 13:24 KST
    expect(unixMsToKSTClock(unixMs)).toBe('13:24:00');
  });
});

describe('formatElapsed', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatElapsed(134_000)).toBe('2:14');
  });
  it('formats over an hour as H:MM:SS', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd frontend && npm test -- time
```

Expected: passing.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/util/time.ts frontend/src/util/time.test.ts
git commit -m "feat(frontend): unixMsToKSTClock + formatElapsed helpers"
```

---

### Task 17: `CaptureForm` component

**Files:**
- Create: `frontend/src/capture/CaptureForm.tsx`
- Create: `frontend/src/capture/CaptureForm.test.tsx`

- [ ] **Step 1: Implement form**

```tsx
// frontend/src/capture/CaptureForm.tsx
import { useState } from 'react';
import type { StartCaptureArgs } from '../api/captures';

const CODE_REGEX = /^\d{6}$/;
const DATE_REGEX = /^\d{8}$/;

function isTodayKSTBeforeClose(date: string): boolean {
  if (!DATE_REGEX.test(date)) return false;
  const now = new Date();
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + kstOffsetMs);
  const yyyy = kstNow.getUTCFullYear();
  const mm = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kstNow.getUTCDate()).padStart(2, '0');
  const todayKst = `${yyyy}${mm}${dd}`;
  return date === todayKst && kstNow.getUTCHours() < 16;
}

interface Props {
  initialCode?: string;
  initialDate?: string;
  disabled?: boolean;
  onStart: (args: StartCaptureArgs) => void;
}

export function CaptureForm({ initialCode = '', initialDate = '', disabled, onStart }: Props) {
  const [code, setCode] = useState(initialCode);
  const [date, setDate] = useState(initialDate);
  const [allowPartial, setAllowPartial] = useState(false);
  const [resume, setResume] = useState(false);
  const [captureOnly, setCaptureOnly] = useState(false);

  const partial = isTodayKSTBeforeClose(date);
  const codeValid = CODE_REGEX.test(code);
  const dateValid = DATE_REGEX.test(date);
  const canStart = codeValid && dateValid && !disabled;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canStart) return;
    onStart({
      code,
      date,
      allow_partial: partial ? true : allowPartial,
      resume,
      capture_only: captureOnly,
    });
  }

  return (
    <form className="bg-bg-card border rounded p-3.5 space-y-2.5" onSubmit={submit}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-dimmer">
        New Capture
      </div>

      {partial && (
        <div className="bg-[rgba(245,158,11,0.08)] border border-[rgba(245,158,11,0.3)] rounded p-2.5">
          <div className="text-[11px] font-semibold text-[--warn] mb-1">
            Today's date — Data Window not yet complete (closes 16:00 KST)
          </div>
          <div className="text-[11px] text-fg-dim leading-relaxed">
            hogaplay collects through 16:00 (After-Hours Trading close), so captures
            before then are partial. Enable <code className="font-mono text-fg">allow partial</code>{' '}
            to capture what's available so far; re-run with <code className="font-mono text-fg">resume</code>{' '}
            after 16:00 to fill in the rest.
          </div>
        </div>
      )}

      <Field label="Code">
        <input
          className="bg-bg-input border rounded font-mono text-[13px] px-2.5 py-1.5 w-full focus:border-accent outline-none"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="005930"
          data-testid="capture-code"
        />
      </Field>
      <Field label="Date">
        <input
          className="bg-bg-input border rounded font-mono text-[13px] px-2.5 py-1.5 w-full focus:border-accent outline-none"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          placeholder="20260520"
          data-testid="capture-date"
        />
      </Field>

      <details open={partial} className="text-[11px] text-fg-dim">
        <summary className="cursor-pointer">▾ Advanced</summary>
        <div className="space-y-1 pt-1.5">
          <Check label="allow partial" value={allowPartial} onChange={setAllowPartial} highlight={partial} />
          <Check label="resume" value={resume} onChange={setResume} />
          <Check label="capture only (skip parse)" value={captureOnly} onChange={setCaptureOnly} />
        </div>
      </details>

      <button
        type="submit"
        disabled={!canStart}
        data-testid="capture-start"
        className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded w-full disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Start Capture
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-fg-dim mb-1">{label}</div>
      {children}
    </div>
  );
}

function Check({
  label, value, onChange, highlight,
}: { label: string; value: boolean; onChange: (v: boolean) => void; highlight?: boolean }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className={`w-3 h-3 ${highlight ? 'accent-[--warn]' : 'accent-[--accent]'}`}
      />
      <span className="text-fg">{label}</span>
    </label>
  );
}
```

- [ ] **Step 2: Add form test**

```tsx
// frontend/src/capture/CaptureForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureForm } from './CaptureForm';

describe('CaptureForm', () => {
  it('disables Start when fields are invalid', () => {
    render(<CaptureForm onStart={vi.fn()} />);
    const btn = screen.getByTestId('capture-start') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables Start with valid 6-digit code and 8-digit date', () => {
    render(<CaptureForm onStart={vi.fn()} />);
    fireEvent.change(screen.getByTestId('capture-code'), { target: { value: '005930' } });
    fireEvent.change(screen.getByTestId('capture-date'), { target: { value: '20100101' } });
    expect((screen.getByTestId('capture-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('calls onStart with form values', () => {
    const onStart = vi.fn();
    render(<CaptureForm onStart={onStart} />);
    fireEvent.change(screen.getByTestId('capture-code'), { target: { value: '005930' } });
    fireEvent.change(screen.getByTestId('capture-date'), { target: { value: '20100101' } });
    fireEvent.click(screen.getByTestId('capture-start'));
    expect(onStart).toHaveBeenCalledWith({
      code: '005930', date: '20100101',
      allow_partial: false, resume: false, capture_only: false,
    });
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd frontend && npm test -- CaptureForm
```

Expected: passing.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureForm.test.tsx
git commit -m "feat(frontend): CaptureForm with validation + partial-capture preview"
```

---

### Task 18: `CaptureProgress` + `CaptureLog` + `CaptureResult` components

**Files:**
- Create: `frontend/src/capture/CaptureProgress.tsx`
- Create: `frontend/src/capture/CaptureLog.tsx`
- Create: `frontend/src/capture/CaptureResult.tsx`

- [ ] **Step 1: CaptureLog**

```tsx
// frontend/src/capture/CaptureLog.tsx
export interface LogLine {
  page: number;
  frontier_ms: number;
  events_added: number;
}

import { unixMsToKSTClock } from '../util/time';

export function CaptureLog({ lines }: { lines: LogLine[] }) {
  return (
    <div className="bg-bg-subtle border rounded px-2 py-1.5 max-h-[120px] overflow-hidden">
      {lines.length === 0 && (
        <div className="text-[11px] text-fg-dimmer font-mono">waiting for first page…</div>
      )}
      {lines.map((l, i) => (
        <div key={i} className="font-mono text-[11px] text-fg-dim py-0.5">
          <span className="text-fg">page {l.page}</span>
          {' · '}t={unixMsToKSTClock(l.frontier_ms)}
          {' · '}+{l.events_added.toLocaleString()} events
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: CaptureProgress**

```tsx
// frontend/src/capture/CaptureProgress.tsx
import { useEffect, useRef, useState } from 'react';
import type { CaptureJob } from '../api/types';
import { formatElapsed, unixMsToKSTClock } from '../util/time';
import { CaptureLog, type LogLine } from './CaptureLog';

interface Props {
  job: CaptureJob;
  onCancel: () => void;
}

export function CaptureProgress({ job, onCancel }: Props) {
  const [confirming, setConfirming] = useState(false);
  const logRef = useRef<LogLine[]>([]);
  const lastPageRef = useRef(0);
  const lastEventsSeenRef = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    if (!job.progress) return;
    if (job.progress.pages_done !== lastPageRef.current) {
      // events_added = delta of cumulative events_seen across pages.
      // Bug guard: events_seen is cumulative; the previous line's count is
      // stored in lastEventsSeenRef, not events_added (which is itself a delta).
      const added = Math.max(0, job.progress.events_seen - lastEventsSeenRef.current);
      logRef.current = [
        { page: job.progress.pages_done, frontier_ms: job.progress.frontier_ms,
          events_added: added },
        ...logRef.current,
      ].slice(0, 10);
      lastPageRef.current = job.progress.pages_done;
      lastEventsSeenRef.current = job.progress.events_seen;
      force((n) => n + 1);
    }
  }, [job.progress]);

  const p = job.progress;
  const phasePill = job.phase === 'capturing' ? 'CAPTURING' : 'PARSING';

  return (
    <div className="bg-bg-card border rounded p-3.5">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[13px] text-fg">{job.code} / {job.date}</span>
          <span className="bg-[rgba(20,184,166,0.12)] text-accent text-[10.5px] font-semibold
                          uppercase tracking-wider px-2 py-0.5 rounded"
                data-testid="capture-phase">{phasePill}</span>
        </div>
        <span className="font-mono text-[11px] text-fg-dim">
          {p ? formatElapsed(p.elapsed_ms) : '0:00'} elapsed
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3.5">
        <Stat label="Pages" value={p ? p.pages_done.toString() : '0'} />
        <Stat label="Events" value={p ? p.events_seen.toLocaleString() : '0'} />
        <Stat label="Frontier" value={p ? unixMsToKSTClock(p.frontier_ms) : '—'} />
      </div>

      <div className="flex justify-between text-[10px] uppercase tracking-wider
                      text-fg-dimmer font-semibold mb-1.5">
        <span>progress (est.)</span>
        <span className="font-mono text-[11px] text-fg-dim normal-case tracking-normal">
          ~{p?.estimate_pct ?? 0}%
        </span>
      </div>
      <div className="h-1 bg-bg-input rounded overflow-hidden mb-3.5">
        <div className="h-full bg-accent transition-[width] duration-300"
             style={{ width: `${p?.estimate_pct ?? 0}%` }} />
      </div>

      <div className="text-[10px] uppercase tracking-wider text-fg-dimmer font-semibold mb-1.5">
        Live log
      </div>
      <CaptureLog lines={logRef.current} />

      <div className="mt-3 text-right">
        {confirming ? (
          <span className="text-[12px] text-fg-dim">
            Sure? <button onClick={onCancel} className="text-[--down] hover:underline">Cancel capture</button>
            {' · '}
            <button onClick={() => setConfirming(false)} className="text-fg-dim hover:underline">Keep going</button>
          </span>
        ) : (
          <button onClick={() => setConfirming(true)}
                  className="text-[12px] text-fg-dim hover:text-fg">Cancel</button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-fg-dim mb-1">{label}</div>
      <div className="font-mono text-[22px] font-medium text-fg tabular-nums">{value}</div>
    </div>
  );
}
```

- [ ] **Step 3: CaptureResult**

```tsx
// frontend/src/capture/CaptureResult.tsx
import { useNavigate } from 'react-router';
import type { CaptureJob } from '../api/types';
import { formatElapsed } from '../util/time';

interface Props {
  job: CaptureJob;
  onDismiss: () => void;
  onResume: (job: CaptureJob) => void;
}

export function CaptureResult({ job, onDismiss, onResume }: Props) {
  const navigate = useNavigate();
  const elapsed = job.progress ? formatElapsed(job.progress.elapsed_ms) : '?';

  if (job.phase === 'done' && job.result) {
    return (
      <div className="bg-bg-card border rounded p-3.5">
        <Header job={job} elapsed={elapsed} kind="done" />
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Stat label="Pages" value={job.result.pages_written.toString()} />
          <Stat label="Events" value={job.result.unique_events.toLocaleString()} />
          <Stat label="Parsed" value={job.result.parsed ? 'Y' : 'N'} highlight={job.result.parsed ? 'up' : undefined} />
          <Stat label="Raw" value="✓" />
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate(`/replay?code=${job.code}&date=${job.date}`)}
                  className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded">
            Open in Replay →
          </button>
          <button onClick={() => navigate('/inventory')}
                  className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
            View in Inventory
          </button>
          <div className="flex-1" />
          <button onClick={onDismiss}
                  className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (job.phase === 'failed' && job.error) {
    return (
      <div className="bg-bg-card border rounded p-3.5">
        <Header job={job} elapsed={elapsed} kind="failed" />
        <div className="bg-[rgba(244,63,94,0.08)] border border-[rgba(244,63,94,0.3)] rounded p-3 mb-3">
          <div className="text-[12px] font-semibold text-[--down] mb-1.5 font-mono">
            {job.error.code}
          </div>
          <div className="text-[11.5px] text-fg-dim leading-relaxed">{job.error.message}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onResume(job)}
                  className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded">
            Retry with Resume
          </button>
          <div className="flex-1" />
          <button onClick={onDismiss}
                  className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // cancelled
  return (
    <div className="bg-bg-card border rounded p-3.5">
      <Header job={job} elapsed={elapsed} kind="cancelled" />
      <div className="text-[12px] text-fg-dim mb-3">
        Cancelled at page {job.progress?.pages_done ?? '?'}. Raw pages preserved on disk; click Resume to continue.
      </div>
      <div className="flex gap-2">
        <button onClick={() => onResume(job)}
                className="bg-accent text-bg font-semibold text-[13px] px-3.5 py-2 rounded">
          Resume from page {job.progress?.pages_done ?? '?'}
        </button>
        <div className="flex-1" />
        <button onClick={onDismiss}
                className="bg-bg-input border text-fg font-medium text-[13px] px-3.5 py-2 rounded">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function Header({ job, elapsed, kind }: { job: CaptureJob; elapsed: string; kind: 'done' | 'failed' | 'cancelled' }) {
  const tint = {
    done: ['bg-[rgba(34,197,94,0.10)]', 'text-[--up]', '✓'],
    failed: ['bg-[rgba(244,63,94,0.10)]', 'text-[--down]', '×'],
    cancelled: ['bg-[rgba(148,163,184,0.12)]', 'text-fg-dim', '—'],
  }[kind];
  return (
    <div className="flex justify-between items-center mb-3.5">
      <div className="flex items-center gap-2">
        <span className={`w-3.5 h-3.5 rounded-full grid place-items-center text-bg text-[9px] font-bold ${tint[0]} ${tint[1]}`}>
          {tint[2]}
        </span>
        <span className="font-mono text-[13px] text-fg">{job.code} / {job.date}</span>
        <span className={`${tint[0]} ${tint[1]} text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded`}>
          {kind}
        </span>
      </div>
      <span className="font-mono text-[11px] text-fg-dim">finished in {elapsed}</span>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: 'up' }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wider text-fg-dim mb-1">{label}</div>
      <div className={`font-mono text-[22px] font-medium tabular-nums ${
        highlight === 'up' ? 'text-[--up]' : 'text-fg'
      }`}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Add component tests**

```tsx
// frontend/src/capture/CaptureProgress.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureProgress } from './CaptureProgress';
import type { CaptureJob } from '../api/types';

function makeJob(overrides: Partial<CaptureJob> = {}): CaptureJob {
  return {
    job_id: 'j1', code: '005930', date: '20260520', phase: 'capturing',
    options: { allow_partial: false, resume: false, capture_only: false },
    started_at_ms: 0, result: null, error: null,
    progress: {
      pages_done: 47, events_seen: 12401,
      frontier_ms: Date.UTC(2026, 4, 20, 4, 24, 0), // 13:24 KST
      estimate_pct: 62, elapsed_ms: 134_000,
    },
    ...overrides,
  };
}

describe('CaptureProgress', () => {
  it('renders three big numbers from progress', () => {
    render(<CaptureProgress job={makeJob()} onCancel={vi.fn()} />);
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('12,401')).toBeInTheDocument();
    expect(screen.getByText('13:24:00')).toBeInTheDocument();
  });

  it('shows PARSING label when phase=parsing', () => {
    render(<CaptureProgress job={makeJob({ phase: 'parsing' })} onCancel={vi.fn()} />);
    expect(screen.getByTestId('capture-phase')).toHaveTextContent('PARSING');
  });

  it('cancel button shows confirm popover', () => {
    const onCancel = vi.fn();
    render(<CaptureProgress job={makeJob()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.getByText(/Cancel capture/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Cancel capture/));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

```tsx
// frontend/src/capture/CaptureResult.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { CaptureResult } from './CaptureResult';
import type { CaptureJob } from '../api/types';

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

const base: CaptureJob = {
  job_id: 'j1', code: '005930', date: '20260520', phase: 'done',
  options: { allow_partial: false, resume: false, capture_only: false },
  started_at_ms: 0, error: null,
  progress: { pages_done: 76, events_seen: 19873, frontier_ms: 0, estimate_pct: 98, elapsed_ms: 222_000 },
  result: { pages_written: 76, unique_events: 19873, raw_dir: '/tmp', parsed: true },
};

describe('CaptureResult', () => {
  it('done phase shows Open in Replay CTA', () => {
    render(wrap(<CaptureResult job={base} onDismiss={vi.fn()} onResume={vi.fn()} />));
    expect(screen.getByText(/Open in Replay/)).toBeInTheDocument();
    expect(screen.getByText(/View in Inventory/)).toBeInTheDocument();
  });

  it('failed phase shows error message and Retry with Resume', () => {
    const job: CaptureJob = {
      ...base, phase: 'failed', result: null,
      error: { code: 'cookie_expired', message: 'Refresh your .cookie...', at_page: 34 },
    };
    const onResume = vi.fn();
    render(wrap(<CaptureResult job={job} onDismiss={vi.fn()} onResume={onResume} />));
    expect(screen.getByText('cookie_expired')).toBeInTheDocument();
    expect(screen.getByText(/Refresh your \.cookie/)).toBeInTheDocument();
    expect(screen.getByText(/Retry with Resume/)).toBeInTheDocument();
  });

  it('cancelled phase shows Resume from page N', () => {
    const job: CaptureJob = { ...base, phase: 'cancelled', result: null };
    render(wrap(<CaptureResult job={job} onDismiss={vi.fn()} onResume={vi.fn()} />));
    expect(screen.getByText(/Resume from page 76/)).toBeInTheDocument();
  });
});
```

Run:

```bash
cd frontend && npm test -- Capture
```

Expected: all passing (combines CaptureForm + CaptureProgress + CaptureResult tests).

- [ ] **Step 5: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/capture/CaptureProgress.tsx frontend/src/capture/CaptureLog.tsx frontend/src/capture/CaptureResult.tsx frontend/src/capture/CaptureProgress.test.tsx frontend/src/capture/CaptureResult.test.tsx
git commit -m "feat(frontend): CaptureProgress + CaptureLog + CaptureResult components"
```

---

### Task 19: `pages/Capture.tsx` — wire everything

**Files:**
- Modify: `frontend/src/pages/Capture.tsx`

- [ ] **Step 1: Replace placeholder with full page**

```tsx
// frontend/src/pages/Capture.tsx
import { useCaptureJob } from '../capture/useCaptureJob';
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureProgress } from '../capture/CaptureProgress';
import { CaptureResult } from '../capture/CaptureResult';
import type { CaptureJob } from '../api/types';

export default function Capture() {
  const { job, start, cancel, dismiss } = useCaptureJob();

  const isRunning = job?.phase === 'capturing' || job?.phase === 'parsing';
  const isTerminal = job?.phase === 'done' || job?.phase === 'failed' || job?.phase === 'cancelled';

  function handleResume(finished: CaptureJob) {
    start.mutate({
      code: finished.code,
      date: finished.date,
      allow_partial: finished.options.allow_partial,
      resume: true,
      capture_only: finished.options.capture_only,
    });
  }

  return (
    <div className="p-6 grid grid-cols-[320px_1fr] gap-3 h-full min-h-0">
      <CaptureForm
        disabled={isRunning}
        onStart={(args) => start.mutate(args)}
      />
      <div className="min-h-0">
        {!job && (
          <div className="text-[12px] text-fg-dim p-4">
            Fill in a Code and Date, then Start Capture.
          </div>
        )}
        {isRunning && <CaptureProgress job={job!} onCancel={() => cancel.mutate()} />}
        {isTerminal && <CaptureResult job={job!} onDismiss={() => dismiss.mutate()} onResume={handleResume} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Start dev server and open `/capture` in a browser**

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173/capture`. Confirm:
- Form renders.
- Typing `005930` / `20260520` enables Start.
- Without a backend running you can't actually capture; that's expected — the next phases test it end-to-end.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Capture.tsx
git commit -m "feat(frontend): wire Capture page (form + progress + result)"
```

---

## Phase 6 — LeftNav global pill

### Task 20: Pulse keyframe in `global.css`

**Files:**
- Modify: `frontend/src/styles/global.css`

- [ ] **Step 1: Append keyframe**

```css
@keyframes capture-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.capture-pulse {
  animation: capture-pulse 1.5s ease-in-out infinite;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/styles/global.css
git commit -m "feat(frontend): capture-pulse keyframe for LeftNav indicator"
```

---

### Task 21: `CaptureStatusPill` component + tests

**Files:**
- Create: `frontend/src/nav/CaptureStatusPill.tsx`
- Create: `frontend/src/nav/CaptureStatusPill.test.tsx`

- [ ] **Step 1: Implement pill**

```tsx
// frontend/src/nav/CaptureStatusPill.tsx
import { Link } from 'react-router';
import { useCaptureJob } from '../capture/useCaptureJob';

export default function CaptureStatusPill() {
  const { job } = useCaptureJob();
  if (!job) return null;
  if (job.phase !== 'capturing' && job.phase !== 'parsing') return null;

  const label = job.phase === 'capturing' ? 'CAPTURING' : 'PARSING';
  const p = job.progress;
  const stats = p ? `${p.pages_done} pg · ${p.events_seen.toLocaleString()} ev · ~${p.estimate_pct}%` : '…';

  return (
    <Link to="/capture" data-testid="capture-pill"
          className="m-2.5 p-2 block bg-bg-card border rounded
                     hover:bg-bg-input-hover transition-colors">
      <div className="flex justify-between items-center mb-1">
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-accent flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-accent capture-pulse" />
          {label}
        </span>
        <span className="font-mono text-[11px] text-fg tabular-nums">{job.code}</span>
      </div>
      <div className="font-mono text-[10px] text-fg-dim tabular-nums">{stats}</div>
      {p && (
        <div className="h-0.5 bg-bg-input rounded mt-1.5 overflow-hidden">
          <div className="h-full bg-accent" style={{ width: `${p.estimate_pct}%` }} />
        </div>
      )}
    </Link>
  );
}
```

- [ ] **Step 2: Add test**

```tsx
// frontend/src/nav/CaptureStatusPill.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CaptureStatusPill from './CaptureStatusPill';

const mockUseCaptureJob = vi.fn();
vi.mock('../capture/useCaptureJob', () => ({
  useCaptureJob: () => mockUseCaptureJob(),
}));

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe('CaptureStatusPill', () => {
  it('renders null when no job', () => {
    mockUseCaptureJob.mockReturnValue({ job: null });
    const { container } = render(wrap(<CaptureStatusPill />));
    expect(container.firstChild).toBeNull();
  });

  it('renders null when terminal', () => {
    mockUseCaptureJob.mockReturnValue({ job: { phase: 'done', code: '005930', date: '20260520', progress: null } });
    const { container } = render(wrap(<CaptureStatusPill />));
    expect(container.firstChild).toBeNull();
  });

  it('renders pill when capturing', () => {
    mockUseCaptureJob.mockReturnValue({
      job: {
        job_id: 'j1', code: '005930', date: '20260520', phase: 'capturing',
        progress: { pages_done: 47, events_seen: 12401, frontier_ms: 0, estimate_pct: 62, elapsed_ms: 0 },
      },
    });
    render(wrap(<CaptureStatusPill />));
    expect(screen.getByTestId('capture-pill')).toBeInTheDocument();
    expect(screen.getByText(/005930/)).toBeInTheDocument();
    expect(screen.getByText(/47 pg/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
cd frontend && npm test -- CaptureStatusPill
```

Expected: passing.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/nav/CaptureStatusPill.tsx frontend/src/nav/CaptureStatusPill.test.tsx
git commit -m "feat(frontend): CaptureStatusPill global indicator"
```

---

### Task 22: Insert pill into `LeftNav.tsx`

**Files:**
- Modify: `frontend/src/nav/LeftNav.tsx`

- [ ] **Step 1: Add import and pill placement**

Edit `frontend/src/nav/LeftNav.tsx`:

```tsx
import CaptureStatusPill from './CaptureStatusPill';
```

**Insert** `<CaptureStatusPill />` IMMEDIATELY AFTER the existing `<div className="flex-1" />` (line 20) and IMMEDIATELY BEFORE `<Section label="System">` (line 21). Do NOT remove the spacer — the spacer is what pushes the pill against the System block. The result:

```tsx
      <Section label="Workspace">
        <NavItem to="/replay" label="Replay Viewer" />
        <NavItem to="/inventory" label="Inventory" />
        <NavItem to="/capture" label="Capture" />
      </Section>
      <div className="flex-1" />
      <CaptureStatusPill />
      <Section label="System">
        <NavItem to="/settings" label="Settings" />
      </Section>
```

- [ ] **Step 2: Smoke test in browser**

```bash
cd frontend && npm run dev
```

Open `http://localhost:5173`. Confirm LeftNav still renders normally (pill renders null without a job — no visible change). No layout shift between Workspace and System sections.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/nav/LeftNav.tsx
git commit -m "feat(frontend): mount CaptureStatusPill in LeftNav"
```

---

## Phase 7 — End-to-end test

### Task 23: Playwright capture-flow spec

**Files:**
- Create: `frontend/tests/e2e/capture-flow.spec.ts`

- [ ] **Step 1: Confirm Playwright + globalSetup are configured for `HOGA_ENABLE_TEST_ENDPOINTS=1`**

```bash
cat frontend/playwright.config.ts | grep -E "HOGA_ENABLE|globalSetup"
cat frontend/tests/e2e/globalSetup.ts 2>/dev/null | head -30
```

If `globalSetup` does not set `HOGA_ENABLE_TEST_ENDPOINTS=1` for the spawned backend, add it. (Likely already set per existing `sse-refresh.spec.ts`.)

- [ ] **Step 2: Write the spec**

```typescript
// frontend/tests/e2e/capture-flow.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Capture flow', () => {
  test('happy path: form → progress → done → Open in Replay', async ({ page }) => {
    await page.goto('/capture');

    // Form is visible
    await expect(page.getByTestId('capture-code')).toBeVisible();
    await expect(page.getByTestId('capture-start')).toBeDisabled();

    // Fill and start
    await page.getByTestId('capture-code').fill('005930');
    await page.getByTestId('capture-date').fill('20260520');
    // Older date → no partial banner; allow-partial untouched
    await page.getByTestId('capture-start').click();

    // Phase transitions
    await expect(page.getByTestId('capture-phase')).toContainText(/CAPTURING|PARSING/, { timeout: 5000 });

    // LeftNav pill is visible while running
    await expect(page.getByTestId('capture-pill')).toBeVisible({ timeout: 5000 });

    // Wait for terminal phase
    await expect(page.getByText(/Open in Replay/)).toBeVisible({ timeout: 30000 });

    // Click Open in Replay
    await page.getByText('Open in Replay →').click();
    await expect(page).toHaveURL(/\/replay\?code=005930&date=20260520/);
  });

  test('pill visible from Inventory page while capturing', async ({ page }) => {
    await page.goto('/capture');
    await page.getByTestId('capture-code').fill('005930');
    await page.getByTestId('capture-date').fill('20260520');
    await page.getByTestId('capture-start').click();
    await expect(page.getByTestId('capture-pill')).toBeVisible({ timeout: 5000 });

    // Navigate to Inventory; pill stays
    await page.goto('/inventory');
    await expect(page.getByTestId('capture-pill')).toBeVisible();

    // Wait for finish so the next test (if any) starts clean
    await page.goto('/capture');
    await expect(page.getByText(/Open in Replay|Retry with Resume/)).toBeVisible({ timeout: 30000 });
    await page.getByText('Dismiss').click();
  });
});
```

- [ ] **Step 3: Run E2E**

```bash
cd frontend && npx playwright test capture-flow
```

Expected: both tests pass. (Takes ~30s due to fake collector pacing.)

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/e2e/capture-flow.spec.ts
git commit -m "test(e2e): Playwright capture-flow happy path + cross-page pill"
```

---

## Phase 8 — Final integration + cleanup

### Task 24: Full backend test sweep + frontend typecheck

- [ ] **Step 1: Run backend test suite**

```bash
pytest -x -v
```

Expected: all passing.

- [ ] **Step 2: Run frontend tests + typecheck + build**

```bash
cd frontend && npm run typecheck && npm test -- --run && npm run build
```

Expected: all passing, build artifact in `frontend/dist/`.

- [ ] **Step 3: Manual smoke test**

```bash
# Terminal 1
hoga serve

# Terminal 2
cd frontend && npm run dev
```

In a browser at `http://localhost:5173/capture`:
1. Try invalid code (`12345`) → Start stays disabled.
2. Try today's date → amber banner appears, allow-partial pre-checked, Advanced expanded.
3. Use an old date with real cookie → real capture starts.
4. Watch progress numbers + bar advance.
5. Navigate to `/inventory` while running → pill visible in LeftNav.
6. Wait for done → click Open in Replay → URL changes correctly.

(Skip 3–6 if no valid `.cookie`; the Fake DI path validates the same flow via E2E.)

- [ ] **Step 4: Commit (only if any cleanup edits were made)**

```bash
git status
# If clean: skip commit. If anything changed:
git add -A && git commit -m "chore: integration sweep cleanup"
```

---

## Self-review checklist (for the implementer)

After all tasks complete, verify against the spec:

- [ ] §4.1 — `POST /api/captures` returns 201 with `CaptureJob`; 409 on conflict; 400 on partial_refused. ✅ Tasks 8, 9.
- [ ] §4.1 — `GET /latest`, `POST /latest/cancel`, `DELETE /latest` with correct status codes. ✅ Task 9.
- [ ] §4.1 — Error code mapping table. ✅ Task 5.
- [ ] §4.2 — SSE `capture_progress` / `capture_phase` / `capture_finished` events. ✅ Tasks 7, 10.
- [ ] §4.2 — No throttling in v1+1; 1:1 emission. ✅ Task 10 test.
- [ ] §4.3 — Collector `on_progress` + `CancelToken` non-breaking. ✅ Tasks 1, 2.
- [ ] §4.3 — HHMMSSmmm → Unix-ms conversion in `hoga/api/captures.py`. ✅ Task 7.
- [ ] §4.4 — Multi-worker assert at module level. ✅ Task 5.
- [ ] §4.4 — `started_at_ms` set immediately before `collect_stock_date`. ✅ Task 7.
- [ ] §5.2 — `useCaptureJob` invalidates on `start.onSuccess` (not setQueryData). ✅ Task 15.
- [ ] §5.3 — Split layout, terminal CTAs, Retry with Resume. ✅ Tasks 18, 19.
- [ ] §5.4 — Form validation + today's-date partial preview (KST hour < 16). ✅ Task 17.
- [ ] §5.5 — Backend-computed `estimate_pct`. ✅ Task 7.
- [ ] §5.6 — LeftNav pill (placement, pulse, visible on all pages including `/capture`). ✅ Tasks 20, 21, 22.
- [ ] §6 — All visual tokens come from DESIGN.md (no hardcoded colors outside `--warn`/`--up`/`--down` tints). ✅ Tasks 17, 18, 21.
- [ ] §8.1 — Backend tests in `tests/test_*.py` flat. ✅ Tasks 1, 5, 7, 8, 9, 10.
- [ ] §8.3 — E2E via FakeHogaplayClient DI (not a separate fake endpoint). ✅ Tasks 11, 23.
- [ ] §9 — User-visible behavior: single-worker required, server restart loses state, cross-page survival, Inventory auto-update. ✅ Behavior emerges from architecture; no additional code.
- [ ] §3 (Task 3, rename) — `_REGULAR_SESSION_CLOSE_HOUR` gone. ✅ Task 3.

---

**Plan complete.** Save path: `docs/superpowers/plans/2026-05-21-capture-ui.md`.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (single-user local tool; product framing settled in spec) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR_WITH_FIXES | 7 findings (2 P1, 3 P2, 2 P3); all P1 + P2 applied inline to plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (spec grilling Q16 covered placement + tokens; design system reuse) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run (no public SDK / dev-facing surface) |

**Findings applied to plan:**
- **F1 [P1] Thread-safe SSE publish** — collector runs in `run_in_executor` thread; original plan called `_bus.publish` directly (not loop-safe). Fixed: `set_bus(bus, loop)` accepts loop reference; `_publish` uses `loop.call_soon_threadsafe`. Matches existing watchdog pattern in `hoga/api/sse.py:57`.
- **F2 [P1] CaptureProgress log buffer math** — `events_added` delta was computed against previous delta instead of previous cumulative. Fixed: added `lastEventsSeenRef` to track previous cumulative; `added = events_seen - lastEventsSeen`.
- **F3 [P2] Backend branch test gaps** — added 4 tests: `test_post_captures_400_partial_refused` (mocked KST clock), `test_cancel_happy_path_202`, `test_run_capture_job_failed_branch` (CookieExpiredError path), `test_run_capture_job_cancelled_branch`.
- **F4 [P2] Frontend component tests** — added `CaptureProgress.test.tsx` (3 cases) and `CaptureResult.test.tsx` (3 phase branches).
- **F6 [P3] Graceful uvicorn shutdown** — added `cancel_latest_on_shutdown()` helper called from lifespan teardown; raw files preserved for Resume.
- **F7 [P3] LeftNav edit instruction** — rephrased "Replace" → "Insert AFTER", added "Do NOT remove the spacer" guardrail.

**Findings deferred (not applied):**
- **F5 [P2] Spec/plan UX divergence** — spec §5.3 says "inline tooltip" when clicking Start while running; plan disables the button. Plan is simpler. Recommendation: align spec to plan in a follow-up doc cleanup (the implementation does what the plan says).

**UNRESOLVED:** none (all P1/P2 fixed inline; F5 documented as known divergence).

**VERDICT:** ENG CLEARED — ready to implement. Plan revisions are small and localized; no architectural rework required.

**Worktree parallelization:**
- Lane A (Backend): Tasks 1 → 2 → 3 → 4 → 5–10 (sequential, all touch `hoga/`)
- Lane B (Frontend): Tasks 12 → 13 → 14 → 15 → 16 → 17–19 (sequential, all touch `frontend/src/`)
- Lane C (LeftNav pill): Tasks 20–22 (depends on Lane B's hook)
- Lane D (E2E): Task 23 (depends on Lanes A + B + C all merged)
- **Parallel execution**: Lanes A and B independent up through Task 19. Could ship in parallel worktrees, merge, then proceed to C+D sequentially.


# No-Upstream-Data State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit `NO_UPSTREAM_DATA` state across collector → worker → DiskState → CalendarStatus → UI marker, so hogaplay's empty-`info.php` response is recognized as a legitimate "no data" signal instead of surfacing as `internal_error: info row expects >=22 fields, got 0`. Trigger case: `003490/20260319`.

**Architecture:** Sentinel-file persistence (`raw/{date}/{code}/.no_upstream_data`). Five backend layers + five frontend layers updated. `force_retry=True` deletes the sentinel and re-runs collection. Classification reuses `skipped + skip_reason`; no new `CapturePhase`. See [spec](../specs/2026-05-24-no-upstream-data-design.md) and [ADR-0021](../../adr/0021-no-upstream-data-sentinel.md).

**Tech Stack:** Python 3.12 (FastAPI, pytest, pydantic), TypeScript (React 18, vitest, lightweight-charts). Tests run via `pytest` (backend) and `npm run test` (frontend, vitest).

---

## File Structure

**Backend — modified files:**

| File | Responsibility | Change scope |
|---|---|---|
| `hoga/collector/orchestrator.py` | Collector loop owner | Add `UpstreamNoDataError`, raise it when `info_body.strip() == ""` |
| `hoga/api/disk_state.py` | Single classifier for (code, date) directory | Add `DiskState.NO_UPSTREAM_DATA`, sentinel-first branch in `check_disk_state` |
| `hoga/api/eligibility.py` | Worker deciding-phase + enqueue gate | Extend `SkipReason`, add NO_UPSTREAM_DATA branches in `decide_capture` (skip / force_retry delete-sentinel) |
| `hoga/api/captures.py` | Queue worker lifecycle | Add `_record_no_upstream_data` helper, wrap `collect_stock_date` call with `try/except UpstreamNoDataError` |
| `hoga/api/calendar.py` | Cell status builder | Add one dict entry in `_disk_state_to_status` |
| `hoga/api/models.py` | Wire types (mirrors frontend) | Extend `SkipReason` Literal + `CalendarStatus` Literal |

**Frontend — modified files:**

| File | Responsibility | Change scope |
|---|---|---|
| `frontend/src/api/types.ts` | TS mirror of wire types | Extend `SkipReason` union + `CalendarStatus` union |
| `frontend/src/capture/useCalendar.ts` | Calendar status helpers | Add `'no_upstream_data' → '–'` branch in `markerFor` |
| `frontend/src/capture/CalendarCell.tsx` | Calendar cell renderer | Add badge color, tooltip case, baseColor branch |
| `frontend/src/capture/CaptureForm.tsx` | Capture form legend | Update Legend text |
| `frontend/src/capture/phase.ts` | Phase → CalendarStatus mapping | Add `no_upstream_data` branch in `phaseToCalendarStatus` |

**Test files — modified or extended:**

- `tests/test_collector_orchestrator.py` — collector empty-body test
- `tests/test_api_disk_state.py` — sentinel detection test
- `tests/test_api_eligibility.py` — decide_capture branches
- `tests/test_api_calendar.py` — disk_state mapping test
- `hoga/api/test_routes.py` — worker integration test (captures pipeline)
- `frontend/src/capture/useCalendar.test.tsx` — markerFor test
- `frontend/src/capture/CalendarCell.test.tsx` — render + tooltip + clickable
- `frontend/src/capture/CaptureForm.test.tsx` — Legend text
- `frontend/src/capture/phase.test.ts` — phaseToCalendarStatus branch

---

## Ordering and dependencies

Backend layers are implemented bottom-up so each task's tests pass without forward references:

1. Collector (raises new exception)
2. DiskState (classifies sentinel directory) — wire types extended in same task as the consumer that needs them
3. Eligibility (skip + force_retry semantics) — also bumps `models.SkipReason`
4. CalendarStatus mapping (also bumps `models.CalendarStatus`)
5. Captures worker (glues collector exception → sentinel + skipped phase)

Frontend layers can be done in any order once `types.ts` is updated, but the plan does them top-down (types first, then consumers).

---

## Task 1 — Collector: `UpstreamNoDataError` + empty-info detection

**Files:**
- Modify: `hoga/collector/orchestrator.py` (add exception class near top; modify `collect_stock_date` around line 441-447)
- Test: `tests/test_collector_orchestrator.py` (add one test using existing `FakeClient`)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_collector_orchestrator.py`:

```python
def test_collect_raises_when_info_body_empty(tmp_path: Path) -> None:
    """hogaplay returning HTTP 200 + empty body for info.php is the
    'upstream has no data for this (code, date)' signal. The collector
    must raise UpstreamNoDataError immediately instead of writing a
    zero-byte info.tsv that later crashes the parser."""
    from hoga.collector.orchestrator import UpstreamNoDataError

    client = FakeClient(info_body="", first_pages={}, chart_body="")
    with pytest.raises(UpstreamNoDataError) as exc_info:
        collect_stock_date(
            client=client,
            code="003490",
            date="20260319",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            resume=False,
        )
    assert exc_info.value.code == "003490"
    assert exc_info.value.date == "20260319"
    # info.tsv must NOT be written when the body is empty.
    info_path = tmp_path / "raw" / "20260319" / "003490" / "info.tsv"
    assert not info_path.exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_collector_orchestrator.py::test_collect_raises_when_info_body_empty -v`

Expected: FAIL with `ImportError: cannot import name 'UpstreamNoDataError'` (or similar).

- [ ] **Step 3: Add `UpstreamNoDataError` class to `orchestrator.py`**

Add near the top of `hoga/collector/orchestrator.py`, alongside the other exception classes (look for `CaptureCancelled`, `TodayTooEarlyRefused`):

```python
class UpstreamNoDataError(RuntimeError):
    """Raised when hogaplay returns HTTP 200 with an empty body for
    info.php — the upstream signal that no data exists for this
    (code, date). See ADR-0021."""
    def __init__(self, code: str, date: str) -> None:
        super().__init__(f"hogaplay returned empty info.php for {code}/{date}")
        self.code = code
        self.date = date
```

- [ ] **Step 4: Add the empty-body check in `collect_stock_date`**

Locate the info.php block (around line 441-447):

```python
    # 1. info.php
    info_path = raw_dir / "info.tsv"
    if not (resume and info_path.exists()):
        info_body = client.fetch_info(code, date)
        info_path.write_text(info_body, encoding="utf-8")
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)
```

Replace with:

```python
    # 1. info.php — hogaplay signals "no data for this (code, date)" via
    # HTTP 200 + empty body (see ADR-0021). Detect at the collector boundary
    # before zero-byte artifacts pollute disk.
    info_path = raw_dir / "info.tsv"
    if not (resume and info_path.exists()):
        info_body = client.fetch_info(code, date)
        if not info_body.strip():
            raise UpstreamNoDataError(code, date)
        info_path.write_text(info_body, encoding="utf-8")
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)
```

- [ ] **Step 5: Run test to verify it passes + nothing regressed**

Run: `uv run pytest tests/test_collector_orchestrator.py -v`

Expected: all tests including the new one PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/collector/orchestrator.py tests/test_collector_orchestrator.py
git commit -m "feat(collector): detect empty info.php body as UpstreamNoDataError

Implements step 1 of docs/superpowers/specs/2026-05-24-no-upstream-data-design.md
and the collector half of ADR-0021. The collector now raises
UpstreamNoDataError immediately on empty info.php response instead of
writing a zero-byte info.tsv that later crashes the parser.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — DiskState: add `NO_UPSTREAM_DATA` + sentinel detection

**Files:**
- Modify: `hoga/api/disk_state.py` (extend enum, prepend sentinel branch in `check_disk_state`)
- Test: `tests/test_api_disk_state.py` (add sentinel tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api_disk_state.py`:

```python
def test_check_disk_state_returns_no_upstream_data_for_sentinel(tmp_path: Path) -> None:
    """A .no_upstream_data sentinel alone in raw_dir classifies as
    DiskState.NO_UPSTREAM_DATA (ADR-0021 sentinel-first ordering)."""
    from hoga.api.disk_state import DiskState, check_disk_state

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    result = check_disk_state(tmp_path, "003490", "20260319")
    assert result.state == DiskState.NO_UPSTREAM_DATA
    assert result.violations == []


def test_check_disk_state_sentinel_takes_precedence_over_stray_parquet(tmp_path: Path) -> None:
    """If a stale parquet/meta.json exists alongside the sentinel (invariant
    violation that the implementation must still survive gracefully), the
    sentinel wins. Sentinel-first ordering protects the UI from showing
    `complete` for a (code, date) the user explicitly knows is empty."""
    from hoga.api.disk_state import DiskState, check_disk_state

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    parquet_dir = tmp_path / "parquet" / "20260319" / "003490"
    parquet_dir.mkdir(parents=True)
    (parquet_dir / "meta.json").write_text("{}", encoding="utf-8")

    result = check_disk_state(tmp_path, "003490", "20260319")
    assert result.state == DiskState.NO_UPSTREAM_DATA
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_disk_state.py -v -k no_upstream_data`

Expected: FAIL with `AttributeError: NO_UPSTREAM_DATA` (enum value missing).

- [ ] **Step 3: Extend `DiskState` enum**

In `hoga/api/disk_state.py`, around line 21-26:

```python
class DiskState(Enum):
    NONE = "none"
    NO_UPSTREAM_DATA = "no_upstream_data"   # ADR-0021
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    INVALID = "invalid"                     # ADR-0020
    COMPLETE = "complete"
```

- [ ] **Step 4: Add sentinel-first branch to `check_disk_state`**

In `hoga/api/disk_state.py`, modify the body of `check_disk_state` (around line 97-127). The sentinel check is the very first branch — before the parquet/meta.json check. Replace the existing function body's first lines:

```python
def check_disk_state(data_dir: Path, code: str, date: str) -> Classification:
    """Classify the on-disk state for ``(code, date)`` under ``data_dir``.

    Resolution order (ADR-0021 + ADR-0020 + ADR-0007):
      0. ``raw/{date}/{code}/.no_upstream_data`` sentinel exists →
         ``NO_UPSTREAM_DATA``. Sentinel-first ordering protects against
         stale parquet artifacts left from a prior capture; by invariant
         (ADR-0021) the sentinel sits alone, but the ordering makes the
         contract robust to bugs that violate it.
      1. ``data/parquet/{date}/{code}/meta.json`` exists → delegate to
         :func:`classify_from_meta`. Truncated / unreadable JSON →
         ``CLIENT_INCOMPLETE`` (no violations).
      2. ``data/raw/{date}/{code}/`` has any TSV files → ``CLIENT_INCOMPLETE``.
      3. Otherwise → ``NONE``.
    """
    raw_dir = data_dir / "raw" / date / code
    if (raw_dir / ".no_upstream_data").exists():
        return Classification(state=DiskState.NO_UPSTREAM_DATA)

    parquet_dir = data_dir / "parquet" / date / code
    meta_path = parquet_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return Classification(state=DiskState.CLIENT_INCOMPLETE)
        return classify_from_meta(meta)

    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        return Classification(state=DiskState.CLIENT_INCOMPLETE)

    return Classification(state=DiskState.NONE)
```

- [ ] **Step 5: Run tests to verify they pass + no regression**

Run: `uv run pytest tests/test_api_disk_state.py -v`

Expected: all tests including the two new ones PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/disk_state.py tests/test_api_disk_state.py
git commit -m "feat(disk_state): add DiskState.NO_UPSTREAM_DATA + sentinel branch

Sentinel-first ordering in check_disk_state per ADR-0021. The
.no_upstream_data file in raw_dir is now the canonical marker for
'hogaplay has no data for this (code, date)'. The ordering protects
against stale parquet artifacts left from a prior capture cycle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Eligibility + Wire models: extend `SkipReason` + `decide_capture` branches

**Files:**
- Modify: `hoga/api/eligibility.py` (extend `SkipReason`, add two NO_UPSTREAM_DATA branches to `decide_capture`)
- Modify: `hoga/api/models.py` (extend `SkipReason` Literal — must stay in sync with eligibility.py)
- Test: `tests/test_api_eligibility.py` (add four tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_api_eligibility.py`:

```python
def test_decide_capture_no_upstream_data_without_force_retry_skips(tmp_path: Path) -> None:
    """A sentinel-only directory + force_retry=False → skip with reason
    no_upstream_data. The sentinel must remain on disk (we are not
    cleaning up; we are skipping)."""
    from hoga.api.eligibility import decide_capture

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    sentinel = raw_dir / ".no_upstream_data"
    sentinel.touch()

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=False
    )
    assert decision.skip_reason == "no_upstream_data"
    assert decision.resume is False
    assert sentinel.exists()  # NOT deleted on plain skip


def test_decide_capture_no_upstream_data_with_force_retry_deletes_sentinel(tmp_path: Path) -> None:
    """force_retry=True bypasses the sentinel: the sentinel file is deleted
    and the decision proceeds with resume=False so collect_stock_date runs
    fresh. Mirrors the SOURCE_PARTIAL+force_retry path (consistent UX:
    force_retry ignores every cache)."""
    from hoga.api.eligibility import decide_capture

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    sentinel = raw_dir / ".no_upstream_data"
    sentinel.touch()

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=True
    )
    assert decision.skip_reason is None
    assert decision.resume is False
    assert not sentinel.exists()  # deleted by decide_capture


def test_decide_capture_no_sentinel_no_change_in_existing_paths(tmp_path: Path) -> None:
    """A fresh (NONE) Stock-Date is unaffected by the new branches."""
    from hoga.api.eligibility import decide_capture

    decision = decide_capture(
        data_dir=tmp_path, code="003490", date="20260319", force_retry=False
    )
    assert decision.skip_reason is None
    assert decision.resume is False


def test_skip_reason_wire_type_includes_no_upstream_data() -> None:
    """models.py SkipReason and eligibility.py SkipReason must agree —
    the worker writes the eligibility value into state.skip_reason which
    pydantic then serialises through the models.py Literal."""
    from hoga.api import eligibility as elig_module
    from hoga.api import models as models_module
    # Both modules define SkipReason as a Literal[...] type. Compare via
    # typing.get_args which works on Literal aliases.
    from typing import get_args
    assert "no_upstream_data" in get_args(elig_module.SkipReason)
    assert "no_upstream_data" in get_args(models_module.SkipReason)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_api_eligibility.py -v -k no_upstream_data`

Expected: FAIL — the new branches and the extended SkipReason Literal don't exist yet.

- [ ] **Step 3: Extend `SkipReason` in `hoga/api/eligibility.py`**

Line 42:

```python
SkipReason = Literal["already_complete", "source_partial", "no_upstream_data"]
```

- [ ] **Step 4: Add NO_UPSTREAM_DATA branches to `decide_capture`**

In `hoga/api/eligibility.py`, replace the body of `decide_capture` (around line 58-83):

```python
def decide_capture(
    *,
    data_dir: Path,
    code: str,
    date: str,
    force_retry: bool,
) -> CaptureDecision:
    """Worker deciding-phase decision.

    Branches (ADR-0021 + ADR-0007):
      - DiskState.COMPLETE         → skip with reason "already_complete"
      - DiskState.NO_UPSTREAM_DATA + not force_retry → skip "no_upstream_data"
      - DiskState.NO_UPSTREAM_DATA + force_retry     → delete sentinel,
                                                       proceed resume=False
      - DiskState.SOURCE_PARTIAL   → skip with "source_partial" unless
                                     force_retry (then fall through to fresh)
      - DiskState.INVALID          → proceed with resume=False (don't trust
                                     corrupt artifacts; fresh capture)
      - DiskState.CLIENT_INCOMPLETE → proceed with resume=True
      - DiskState.NONE             → proceed with resume=False
    """
    disk = check_disk_state(data_dir, code, date).state
    if disk == DiskState.COMPLETE:
        return CaptureDecision(skip_reason="already_complete", resume=False)
    if disk == DiskState.NO_UPSTREAM_DATA:
        if not force_retry:
            return CaptureDecision(skip_reason="no_upstream_data", resume=False)
        # force_retry: clear the sentinel so collect_stock_date runs fresh.
        # If hogaplay still returns empty, the worker re-creates the sentinel.
        (data_dir / "raw" / date / code / ".no_upstream_data").unlink(missing_ok=True)
        return CaptureDecision(skip_reason=None, resume=False)
    if disk == DiskState.SOURCE_PARTIAL and not force_retry:
        return CaptureDecision(skip_reason="source_partial", resume=False)
    # INVALID and NONE both produce resume=False; only CLIENT_INCOMPLETE resumes.
    resume_flag = (disk == DiskState.CLIENT_INCOMPLETE)
    return CaptureDecision(skip_reason=None, resume=resume_flag)
```

- [ ] **Step 5: Extend `SkipReason` in `hoga/api/models.py`**

Line 122:

```python
SkipReason = Literal["already_complete", "source_partial", "no_upstream_data"]
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_api_eligibility.py -v`

Expected: all four new tests PASS; existing tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/eligibility.py hoga/api/models.py tests/test_api_eligibility.py
git commit -m "feat(eligibility): NO_UPSTREAM_DATA skip + force_retry sentinel delete

Adds the new SkipReason value and the two decide_capture branches per
ADR-0021. force_retry=True deletes the sentinel before proceeding so
the next collect_stock_date runs fresh; force_retry=False short-circuits
without calling hogaplay. Wire SkipReason in models.py kept in sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Calendar status mapping + `CalendarStatus` wire type

**Files:**
- Modify: `hoga/api/calendar.py` (one new dict entry in `_disk_state_to_status`)
- Modify: `hoga/api/models.py` (extend `CalendarStatus` Literal)
- Test: `tests/test_api_calendar.py` (add one test)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_api_calendar.py`:

```python
def test_calendar_cell_shows_no_upstream_data_for_sentinel(tmp_path: Path) -> None:
    """A sentinel directory must surface as CalendarCell.status =
    'no_upstream_data' on the wire so the frontend can render the '–' marker.
    captured_at_ms stays None (no capture timestamp — there was nothing to
    capture)."""
    from hoga.api.calendar import get_month_map

    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True)
    (raw_dir / ".no_upstream_data").touch()

    # Force the trading-day branch deterministically: pretend 20260319 is a
    # trading day by populating the module cache. Other dates fall back to
    # the standard weekday heuristic.
    from hoga.api.calendar import _month_cache, reset_cache_for_tests
    reset_cache_for_tests()
    _month_cache[(2026, 3)] = {f"202603{day:02d}" for day in range(1, 32)}

    resp = get_month_map(data_dir=tmp_path, code="003490", year=2026, month=3)
    cell = next(c for c in resp.cells if c.date == "20260319")
    assert cell.status == "no_upstream_data"
    assert cell.captured_at_ms is None
    reset_cache_for_tests()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_api_calendar.py::test_calendar_cell_shows_no_upstream_data_for_sentinel -v`

Expected: FAIL — `KeyError: DiskState.NO_UPSTREAM_DATA` from `_disk_state_to_status`.

- [ ] **Step 3: Add the dict entry to `_disk_state_to_status`**

In `hoga/api/calendar.py`, line 138-145:

```python
def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
        DiskState.INVALID: "invalid",                  # ADR-0020
        DiskState.NO_UPSTREAM_DATA: "no_upstream_data",  # ADR-0021
        DiskState.NONE: "none",
    }[st]
```

- [ ] **Step 4: Extend `CalendarStatus` in `hoga/api/models.py`**

Line 317-320:

```python
CalendarStatus = Literal[
    "complete", "source_partial", "client_incomplete", "invalid", "none",
    "weekend", "holiday", "future", "today_locked",
    "no_upstream_data",   # ADR-0021
]
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_api_calendar.py -v`

Expected: new test PASS + all existing PASS.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/calendar.py hoga/api/models.py tests/test_api_calendar.py
git commit -m "feat(calendar): map NO_UPSTREAM_DATA disk state to wire status

One dict entry + one Literal addition. captured_at_ms stays None for
no_upstream_data cells (whitelist in _captured_at_ms already excludes
the new status — no change needed there).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Captures worker: `_record_no_upstream_data` + try/except

**Files:**
- Modify: `hoga/api/captures.py` (import `UpstreamNoDataError`, add helper, wrap collector call)
- Test: `hoga/api/test_routes.py` (add a worker-level integration test using the existing fake-client harness)

- [ ] **Step 1: Inspect the existing captures fake-client harness**

Run: `grep -n "captures_fake\|class FakeClient" hoga/api/captures_fake.py hoga/api/test_routes.py | head -20`

Read `hoga/api/captures_fake.py` to confirm the fake client's `fetch_info` signature. The test client lives there and is injected via `captures._client_factory`. The harness in `test_routes.py` uses it.

- [ ] **Step 2: Write the failing integration test**

Append to `hoga/api/test_routes.py` (find the existing test pattern for an integration test that runs a queue item to completion; mirror that shape). Skeleton:

```python
@pytest.mark.asyncio
async def test_worker_handles_empty_info_body_as_skipped_no_upstream_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: enqueue → worker calls collect_stock_date with a fake
    client that returns empty info body → UpstreamNoDataError → sentinel
    created + zero-byte files cleaned + state.phase='skipped' +
    state.skip_reason='no_upstream_data' + capture_finished SSE published.
    """
    from hoga.api import captures
    from hoga.api.captures_fake import FakeHogaplayClient

    # Wire the captures module to tmp_path + a fake client that returns "".
    captures._data_dir = tmp_path
    captures._client_factory = lambda: FakeHogaplayClient(
        info_body="", first_pages={}, chart_body=""
    )
    captures.reset_state_for_tests()

    # Enqueue one item (use whatever helper the existing tests use; the
    # canonical entry is the worker's _run_item path. Bypass the HTTP route
    # by constructing a QueueItemState directly).
    state = captures.QueueItemState(
        item_id="test-item-1",
        code="003490",
        date="20260319",
        force_retry=False,
        enqueued_at_ms=0,
    )
    captures._active[state.item_id] = state

    await captures._run_item(state)

    # Assertions
    assert state.phase == "skipped"
    assert state.skip_reason == "no_upstream_data"
    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    assert (raw_dir / ".no_upstream_data").exists()
    # Stale pre-collect artifacts removed
    assert not (raw_dir / "info.tsv").exists()
    assert not (raw_dir / "chart.tsv").exists()
    assert not (raw_dir / "_progress.json").exists()
```

Note: if `FakeHogaplayClient` has a different name in `captures_fake.py`, use that. The existing tests in `test_routes.py` show the canonical usage; copy that import.

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest hoga/api/test_routes.py::test_worker_handles_empty_info_body_as_skipped_no_upstream_data -v`

Expected: FAIL with `UpstreamNoDataError` propagating out of `_run_capture_inner` (or `_record_no_upstream_data` missing).

- [ ] **Step 4: Add `_record_no_upstream_data` helper to `captures.py`**

In `hoga/api/captures.py`, near the other module-level helpers (e.g., after `_require_data_dir` / `_require_client_factory`, before `reset_state_for_tests`):

```python
def _record_no_upstream_data(data_dir: Path, code: str, date: str) -> None:
    """Write the .no_upstream_data sentinel and remove zero-byte
    pre-collect artifacts so the directory is in canonical form for
    check_disk_state (see ADR-0021).

    Invariant after this call: raw_dir contains exactly one file
    (.no_upstream_data) and parquet_dir does not exist. force_retry
    deletes the sentinel before re-running collect_stock_date.
    """
    raw_dir = data_dir / "raw" / date / code
    raw_dir.mkdir(parents=True, exist_ok=True)
    for stale in ("info.tsv", "chart.tsv", "_progress.json"):
        (raw_dir / stale).unlink(missing_ok=True)
    (raw_dir / ".no_upstream_data").touch()
```

- [ ] **Step 5: Import `UpstreamNoDataError` and wrap the collector call**

In `hoga/api/captures.py`, update the existing collector import (around line 43-52) to add `UpstreamNoDataError`:

```python
from hoga.collector.orchestrator import (
    CHART_FINAL_TIME_MS,
    DATA_WINDOW_START_MS,
    DEFAULT_RATE_LIMIT_S,
    CancelToken,
    CaptureCancelled,
    ProgressEvent,
    TodayTooEarlyRefused,
    UpstreamNoDataError,
    collect_stock_date,
)
```

In `_run_capture_inner` (around line 449-487), wrap the `loop.run_in_executor(... collect_stock_date ...)` call:

```python
async def _run_capture_inner(state: QueueItemState, resume: bool) -> None:
    """Run the collector then the parser. Cookie-missing/expired rejection
    happens via the cookie-pause path in the worker loop. Task 11's
    ``_run_capture_and_parse`` wrapper provides 429 backoff around this.

    UpstreamNoDataError (ADR-0021) is caught here and converted to a normal
    `skipped` return — not an exception path. The outer worker loop's
    generic except handler never sees it, so `state.phase` does not flip to
    'failed'.
    """
    if state.cancel_token is None:
        state.cancel_token = CancelToken()
    data_dir = _require_data_dir()
    client = _require_client_factory()()

    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    await _publish_phase(state)

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: collect_stock_date(
                client=client,
                code=state.code,
                date=state.date,
                data_dir=data_dir,
                rate_limit_s=0.0 if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1" else DEFAULT_RATE_LIMIT_S,
                resume=resume,
                on_progress=_make_progress_callback(state),
                cancel_token=state.cancel_token,
            ),
        )
    except UpstreamNoDataError:
        _record_no_upstream_data(data_dir, state.code, state.date)
        state.phase = "skipped"
        state.skip_reason = "no_upstream_data"
        state.estimate_pct = 100
        progress = state.to_progress()
        if progress is not None:
            _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))
        return

    state.phase = "parsing"
    await _publish_phase(state)
    await loop.run_in_executor(
        None,
        lambda: parse_stock_date(
            code=state.code, date=state.date, data_dir=data_dir, lenient=False,
        ),
    )

    state.result = CaptureResult(
        pages_written=result.pages_written,
        unique_events=result.unique_events,
        raw_dir=str(result.raw_dir),
        parsed=True,
        abort_reason=result.abort_reason,
    )
    state.phase = "done"
    state.estimate_pct = 100
    progress = state.to_progress()
    if progress is not None:
        _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))
```

- [ ] **Step 6: Run the integration test + the full captures test module**

Run: `uv run pytest hoga/api/test_routes.py -v -k no_upstream_data` then `uv run pytest hoga/api/ -v`

Expected: new test PASS, no regression in existing route tests.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/captures.py hoga/api/test_routes.py
git commit -m "feat(captures): worker handles UpstreamNoDataError as skipped

Wraps collect_stock_date in _run_capture_inner with try/except. On
empty-info signal: writes the .no_upstream_data sentinel, cleans up
zero-byte artifacts (info.tsv / chart.tsv / _progress.json), and
terminates the queue item as skipped/no_upstream_data. Outer worker
loop's generic except handler never sees the exception, so failed
classification is avoided. ADR-0021.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Frontend types: `SkipReason` + `CalendarStatus`

**Files:**
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Run typecheck to confirm baseline is clean**

Run: `cd frontend && npm run typecheck`

Expected: 0 errors. (If this fails, stop and fix the baseline first.)

- [ ] **Step 2: Extend `SkipReason` and `CalendarStatus`**

In `frontend/src/api/types.ts`:

```typescript
// Around line 90:
export type SkipReason = 'already_complete' | 'source_partial' | 'no_upstream_data';

// Around line 226-234:
export type CalendarStatus =
  | 'complete'
  | 'source_partial'
  | 'client_incomplete'
  | 'none'
  | 'weekend'
  | 'holiday'
  | 'future'
  | 'today_locked'
  | 'no_upstream_data';
```

- [ ] **Step 3: Run typecheck to see which consumers exhaustively switch on these unions**

Run: `cd frontend && npm run typecheck`

Expected: TypeScript flags `phaseToCalendarStatus` and `markerFor` if they have exhaustive checks, plus any `Record<CalendarStatus, _>` usages. Note the file:line locations — these are the consumers we'll update in subsequent tasks.

- [ ] **Step 4: Commit (types only — consumer updates follow)**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(frontend/types): mirror SkipReason + CalendarStatus new variant

Type-level half of the frontend changes for ADR-0021. Consumers
(markerFor, phaseToCalendarStatus, CalendarCell, Legend) updated in
follow-up commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Frontend: `markerFor('no_upstream_data') === '–'`

**Files:**
- Modify: `frontend/src/capture/useCalendar.ts`
- Test: `frontend/src/capture/useCalendar.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/capture/useCalendar.test.tsx`:

```typescript
import { markerFor } from './useCalendar';

describe('markerFor (no_upstream_data)', () => {
  it("returns '–' for no_upstream_data — distinct from '✕' broken", () => {
    expect(markerFor('no_upstream_data')).toBe('–');
    expect(markerFor('client_incomplete')).toBe('✕');  // regression guard
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- useCalendar.test.tsx`

Expected: FAIL — `markerFor` returns `null` for `'no_upstream_data'` (unhandled case).

- [ ] **Step 3: Extend `markerFor`**

In `frontend/src/capture/useCalendar.ts`, line 80-86:

```typescript
export function markerFor(status: CalendarStatus): '✓' | '⚠' | '✕' | '🔒' | '–' | null {
  if (status === 'complete') return '✓';
  if (status === 'source_partial') return '⚠';
  if (status === 'client_incomplete') return '✕';
  if (status === 'today_locked') return '🔒';
  if (status === 'no_upstream_data') return '–';   // ADR-0021
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- useCalendar.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/useCalendar.ts frontend/src/capture/useCalendar.test.tsx
git commit -m "feat(frontend/calendar): markerFor returns '–' for no_upstream_data

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Frontend: `CalendarCell` tooltip + badge color + dimmed text

**Files:**
- Modify: `frontend/src/capture/CalendarCell.tsx`
- Test: `frontend/src/capture/CalendarCell.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/capture/CalendarCell.test.tsx`:

```typescript
describe('CalendarCell (no_upstream_data)', () => {
  it("renders the '–' marker", () => {
    render(<CalendarCell date="20260319" status="no_upstream_data" />);
    expect(screen.getByText('–')).toBeTruthy();
  });

  it("is clickable (not disabled)", () => {
    const onClick = vi.fn();
    render(<CalendarCell date="20260319" status="no_upstream_data" onClick={onClick} />);
    const btn = screen.getByTestId('calendar-cell-20260319');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledWith('20260319');
  });

  it("shows the 'no upstream data (force to retry)' tooltip", () => {
    render(<CalendarCell date="20260319" status="no_upstream_data" />);
    const btn = screen.getByTestId('calendar-cell-20260319');
    expect(btn.getAttribute('title')).toBe('20260319 · no upstream data (force to retry)');
  });
});
```

Make sure the imports at the top of the file include `fireEvent` and `vi` from `@testing-library/react` / `vitest` as the other tests do; copy from a sibling test that already imports them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test -- CalendarCell.test.tsx`

Expected: FAIL — marker is missing (`markerFor` returns `'–'` but `CalendarCell` may not render it yet if it relies on `STATUS_BADGE_COLOR` to be defined) AND tooltip says just `20260319`.

- [ ] **Step 3: Extend `STATUS_BADGE_COLOR`**

In `frontend/src/capture/CalendarCell.tsx`, line 9-13:

```typescript
const STATUS_BADGE_COLOR: Partial<Record<CalendarStatus, string>> = {
  complete: 'var(--success)',
  source_partial: 'var(--warn)',
  client_incomplete: 'var(--error)',
  no_upstream_data: 'var(--fg-dimmer)',   // ADR-0021 — gray, signals absence
};
```

- [ ] **Step 4: Add tooltip case**

In `frontend/src/capture/CalendarCell.tsx`, inside `tooltipFor` (line 27-37), add before the default branch:

```typescript
    case 'no_upstream_data': return `${date} · no upstream data (force to retry)`;
```

- [ ] **Step 5: Add dimmed baseColor branch**

In `frontend/src/capture/CalendarCell.tsx`, line 45-48:

```typescript
  const baseColor: string =
    status === 'weekend' || status === 'holiday' || status === 'future' ? 'var(--fg-dimmer)'
    : status === 'today_locked' ? 'var(--fg-dim)'
    : status === 'no_upstream_data' ? 'var(--fg-dim)'
    : 'var(--fg)';
```

`DISABLED_STATUSES` at line 5-7 is intentionally left unchanged — the cell stays clickable so `force_retry` works.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npm run test -- CalendarCell.test.tsx`

Expected: PASS (all three new tests + existing).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/capture/CalendarCell.tsx frontend/src/capture/CalendarCell.test.tsx
git commit -m "feat(frontend/calendar): no_upstream_data cell — tooltip + dim + click

Cell renders the '–' marker (gray --fg-dimmer), tooltip says 'no
upstream data (force to retry)', cell stays clickable so users can
trigger force_retry. Visual contrast vs '✕' broken (--error) keeps
the two states distinguishable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — Frontend: `CaptureForm` Legend

**Files:**
- Modify: `frontend/src/capture/CaptureForm.tsx`
- Test: `frontend/src/capture/CaptureForm.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/capture/CaptureForm.test.tsx`:

```typescript
it('Legend lists the new "no upstream data" entry', () => {
  setup({});  // existing helper in the file
  // Legend is plain text in a div; assert the substring.
  expect(screen.getByText(/– no upstream data/)).toBeTruthy();
});
```

If `setup` doesn't render the legend by default, render via the same path as the existing test for the Legend (check the file — it already mounts CaptureForm in `setup`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- CaptureForm.test.tsx`

Expected: FAIL — current Legend does not include "no upstream data".

- [ ] **Step 3: Update the Legend text**

In `frontend/src/capture/CaptureForm.tsx`, line 107:

```jsx
        Legend: ✓ complete · ⚠ partial · ✕ broken · – no upstream data · 🔒 today &lt; 18:00 KST
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- CaptureForm.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureForm.test.tsx
git commit -m "feat(frontend/capture): add '– no upstream data' to legend

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — Frontend: `phaseToCalendarStatus` branch

**Files:**
- Modify: `frontend/src/capture/phase.ts`
- Test: `frontend/src/capture/phase.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/capture/phase.test.ts`:

```typescript
import { phaseToCalendarStatus } from './phase';

describe('phaseToCalendarStatus (no_upstream_data)', () => {
  it('maps skipped + no_upstream_data to no_upstream_data calendar status', () => {
    expect(phaseToCalendarStatus('skipped', 'no_upstream_data')).toBe('no_upstream_data');
  });

  it('regression: skipped + source_partial still maps to source_partial', () => {
    expect(phaseToCalendarStatus('skipped', 'source_partial')).toBe('source_partial');
  });

  it('regression: skipped + already_complete still maps to complete', () => {
    expect(phaseToCalendarStatus('skipped', 'already_complete')).toBe('complete');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- phase.test.ts`

Expected: FAIL — `phaseToCalendarStatus('skipped', 'no_upstream_data')` currently returns `'complete'` (falls into the final else of the skipped branch).

- [ ] **Step 3: Extend `phaseToCalendarStatus`**

In `frontend/src/capture/phase.ts`, line 61-69:

```typescript
export function phaseToCalendarStatus(
  phase: CapturePhase,
  skipReason: SkipReason | null,
): CalendarStatus | null {
  if (phase === 'done') return 'complete';
  if (phase === 'skipped') {
    if (skipReason === 'source_partial') return 'source_partial';
    if (skipReason === 'no_upstream_data') return 'no_upstream_data';   // ADR-0021
    return 'complete';
  }
  if (phase === 'failed' || phase === 'cancelled') return 'client_incomplete';
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- phase.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/capture/phase.ts frontend/src/capture/phase.test.ts
git commit -m "feat(frontend/capture): phaseToCalendarStatus maps no_upstream_data

SSE capture_finished → calendar cell patch path. A worker terminating
as skipped/no_upstream_data now immediately patches the calendar cell
to status='no_upstream_data', without waiting for the next GET refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 — Full verification + smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `uv run pytest -x -q`

Expected: all tests pass. If anything fails, the failure is in the integration of the changes — fix in the relevant earlier task.

- [ ] **Step 2: Run the full frontend test suite**

Run: `cd frontend && npm run test -- --run`

Expected: all tests pass.

- [ ] **Step 3: Run frontend typecheck**

Run: `cd frontend && npm run typecheck`

Expected: 0 errors. (TypeScript exhaustiveness will catch any union-switch we forgot.)

- [ ] **Step 4: Run frontend lint**

Run: `cd frontend && npm run lint`

Expected: 0 errors.

- [ ] **Step 5: Manual smoke — re-run `003490/20260319` with force_retry**

This step is a human verification, but document the expected user-facing result so the worker can describe it in the PR:

1. Start backend (`uv run uvicorn hoga.api.app:default_app --factory --reload --reload-dir hoga --port 8000`) and frontend (`cd frontend && npm run dev`).
2. Open `http://localhost:5173/capture`, search `003490`, navigate to March 2026.
3. The `19` cell should now show as `–` (gray, clickable), tooltip `20260319 · no upstream data (force to retry)`. The previous failed row in the queue can be dismissed.
4. Check "force retry" and click the cell to enqueue. Queue row should terminate as `⚠ skipped` with `no upstream data`.
5. Confirm `data/raw/20260319/003490/.no_upstream_data` exists on disk and `info.tsv`/`chart.tsv`/`_progress.json` are gone.

- [ ] **Step 6: Final commit (if any cleanup needed) or note "no changes"**

If steps 1-5 surfaced any small fix, commit it. If everything passes clean, no commit needed — the implementation is complete across the 10 prior task commits.

---

## Spec coverage check

| Spec requirement | Implemented in |
|---|---|
| `UpstreamNoDataError` + empty `info_body` detection | Task 1 |
| `_record_no_upstream_data` helper + sentinel write | Task 5 |
| `DiskState.NO_UPSTREAM_DATA` + sentinel-first branch | Task 2 |
| `SkipReason = "no_upstream_data"` (eligibility + wire) | Task 3 |
| `decide_capture` NO_UPSTREAM_DATA branches (skip + force_retry delete) | Task 3 |
| `_disk_state_to_status` mapping | Task 4 |
| `CalendarStatus = "no_upstream_data"` (wire) | Task 4 |
| Captures worker try/except + skip terminal state | Task 5 |
| Frontend `SkipReason` mirror | Task 6 |
| Frontend `CalendarStatus` mirror | Task 6 |
| `markerFor('no_upstream_data') === '–'` | Task 7 |
| `STATUS_BADGE_COLOR` + tooltip + dimmed baseColor (clickable) | Task 8 |
| Legend text | Task 9 |
| `phaseToCalendarStatus` SSE patch path | Task 10 |
| End-to-end verification | Task 11 |

# Capture Queue Backend — Plan B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `hoga/api/captures.py`'s `_latest` singleton with a `_queue + _active + _done` worker pool (N=3 asyncio tasks per process), wire all the queue/cancel/pause/dismiss routes the redesign needs, enforce the 18 KST today-lock backend-side, and add two new sibling modules — `symbols.py` (pykrx master cache, 3-tier policy) and `calendar.py` (per-symbol month status map). Backend-only; no frontend touched in this plan.

**Architecture:** The capture lifecycle moves from "one job in flight, singleton state" to "N concurrent items, dedup'd by (code, date)". `disk_state.check_disk_state` (Plan A) drives the worker's deciding phase, the calendar endpoint, and the symbols breakdown — three call sites, one source of truth. Cookie expiry pauses the whole pool atomically; 429s back off per-item. Two sibling endpoint modules carry the search and calendar surfaces; ADR-0007 already greenlights `captures.py` growing past 700 lines as one cohesive lifecycle.

**Tech Stack:** Python 3.14, `pydantic`, `fastapi`, `pykrx` (already a transitive dep — `hoga/inventory/trading_days.py` uses it), `pytest`, `pytest-asyncio`. No new runtime dependencies.

Spec authority: `docs/superpowers/specs/2026-05-21-capture-range-redesign-design.md` — §3, §5, §7.1, and **§11 (Q14–Q21) authoritative delta**. ADR-0006 (single module) + ADR-0007 (queue growth budget retired, `disk_state` extracted).

---

## File Structure

```
hoga/collector/orchestrator.py             [modify]  Drop allow_partial param; rename is_partial_capture
                                                     → is_today_too_early (cutoff 18 not 16);
                                                     rename PartialCaptureRefused → TodayTooEarlyRefused
hoga/cli.py                                 [modify]  Drop --allow-partial flag
hoga/api/models.py                          [modify]  Add QueueItem, SymbolHit, SymbolsAllResponse,
                                                     CalendarCell, CalendarResponse + new SSE event
                                                     classes; rename _CaptureEventBase.job_id → item_id;
                                                     extend CapturePhase literal with deciding/queued/skipped
hoga/api/captures.py                        [rewrite] _latest singleton retired; _queue + _active + _done
                                                     state; _worker_loop pool (N=3); deciding phase;
                                                     dedupe + inflight lock; cookie pool pause; 429
                                                     backoff; new route surface
hoga/collector/client.py                    [modify]  Add `status_code: int | None` attr to
                                                     HogaplayHTTPError so the 429 backoff (Task 11)
                                                     can dispatch on it. Current code only stuffs
                                                     status in the message string (verified by
                                                     pre-flight grep) — add a typed field.
hoga/api/symbols.py             [new]                 pykrx symbol master cache (3-tier policy) +
                                                     captured_breakdown via disk_state; routes:
                                                     /api/symbols/all, /api/symbols, /api/symbols/refresh.
                                                     Uses `pykrx.stock.get_market_cap(date)` BULK
                                                     (one call per market for ~6000 ticker+name pairs)
                                                     — NOT N=6000 individual get_market_ticker_name
                                                     calls, which would take ~10 min at boot.
hoga/api/calendar.py            [new]                 per-symbol month status map with as_of_ms;
                                                     /api/inventory/calendar. ALSO owns the small
                                                     trading-day expansion helper (`trading_days_in_range`,
                                                     `trading_days_in_month`) used by captures.py
                                                     Task 7 — there is no pre-existing
                                                     `hoga/inventory/trading_days.py` (verified).
                                                     Module-level cache for trading-day sets per
                                                     (year, month) so repeated calendar GETs don't
                                                     re-call pykrx.get_market_ohlcv.
hoga/api/app.py                             [modify]  Lifespan schedules symbols.ensure_cache_warm()
                                                     (fire-and-forget); wires the new routers;
                                                     replaces cancel_latest_on_shutdown with
                                                     cancel_all_on_shutdown
hoga/api/routes.py                          [modify]  Mount symbols + calendar routers

tests/test_api_models_capture_queue.py     [new]    QueueItem/SymbolHit/CalendarCell shape + new SSE
                                                     event discriminators
tests/test_collector_today_too_early.py    [new]    Renamed file replacing the deleted partial-refused
                                                     test cases in test_collector_orchestrator.py
tests/test_api_captures_queue.py           [new]    Enqueue + dedupe + worker pool + cancel + pause
                                                     + drained + force_retry + 429 backoff
tests/test_api_symbols.py                  [new]    3-tier cache + search + breakdown
tests/test_api_calendar.py                 [new]    Status per date, weekend/holiday, today_locked,
                                                     as_of_ms
tests/test_api_captures.py                  [modify] Old _latest tests removed in Task 15
tests/test_api_sse_capture.py               [modify] Allow_partial usages dropped in Task 1; full file
                                                     deleted (or repurposed) in Task 15
tests/test_collector_orchestrator.py        [modify] allow_partial=True drops to defaults;
                                                     PartialCaptureRefused test rewritten as
                                                     TodayTooEarlyRefused with 18 KST cutoff
tests/test_collector_progress_callback.py   [modify] Drop allow_partial=True (becomes default behavior)
tests/test_collector_progress_finished.py   [modify] Drop allow_partial=True
tests/test_e2e_completeness.py              [modify] Drop allow_partial=True

docs/adr/0007-capture-grows-disk-state-extracted.md  [modify] Footer note: "Plan B landed YYYY-MM-DD"
```

Each module has one responsibility:
- `captures.py` — entire queue lifecycle: state singletons, worker pool, deciding phase, cookie pause, 429 backoff, all queue routes. ADR-0007 explicitly retires the line budget; aim for clarity over splitting.
- `symbols.py` — pykrx master cache + search + per-code breakdown. Owns its own lock + Future dedupe; no shared state with `captures.py`.
- `calendar.py` — pure read-side: builds month status map by composing `disk_state.check_disk_state`, the trading-day list, and the 18 KST overlay. No mutation.
- `models.py` — wire shapes only. No I/O, no business logic.

---

## Pre-flight (do before Task 1)

- [ ] **Step P1: Verify worktree branch**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `worktree-feat+frontend2`.

- [ ] **Step P2: Verify baseline test count and that everything is green**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: `224 passed` (Plan A baseline). If the count differs, stop and reconcile before starting.

- [ ] **Step P3: Verify pykrx is importable (used by symbols.py and calendar.py)**

Run: `uv run python -c "from pykrx import stock; print(len(stock.get_market_ticker_list('20260501', market='KOSPI')) > 0)"`
Expected: `True`. (Already a transitive dep via `hoga/inventory/trading_days.py`; this confirms it.)

- [ ] **Step P4: Confirm `_DATA_WINDOW_CLOSE_HOUR = 16` stays — Q14 keeps it for its semantic meaning (when Data Window closes), distinct from the new 18 KST policy cutoff**

Run: `grep -n "_DATA_WINDOW_CLOSE_HOUR" hoga/collector/orchestrator.py`
Expected: one definition at top, plus references inside the orchestrator. We will leave the constant alone.

---

## Task 1: Q14 — rename `is_partial_capture` → `is_today_too_early`, drop `allow_partial`

The Data Window closes at 16 KST, but the **policy** says we don't capture today before 18 KST. Q14 makes that single rule backend-enforced and renames the function so "partial" stops meaning two different things (policy vs. data).

**Files:**
- Modify: `hoga/collector/orchestrator.py:32` (constant comment), `:45–46` (rename exception), `:98–105` (rename function + bump 16 → 18), `:270` (drop param), `:287–292` (rename refusal raise)
- Modify: `hoga/cli.py:29,47` (drop `--allow-partial` flag and kwarg)
- Modify: `hoga/api/captures.py:35,38,59,269,325,361,373` (drop `allow_partial`; the `_latest`-side rejection guard moves to the new POST in Task 7 — this task removes it from the old POST too, simplifying it before the bigger rewrite)
- Test: `tests/test_collector_today_too_early.py` [new], plus modifications to `tests/test_collector_orchestrator.py`, `tests/test_collector_progress_callback.py`, `tests/test_collector_progress_finished.py`, `tests/test_e2e_completeness.py`, `tests/test_api_captures.py`, `tests/test_api_sse_capture.py` to drop `allow_partial=True` (now the default behavior).

- [ ] **Step 1: Write the failing test for the renamed predicate (18 KST cutoff)**

Create `tests/test_collector_today_too_early.py`:
```python
"""is_today_too_early returns True iff date == today_kst AND now.hour < 18."""
import datetime as dt
import pytest
from hoga.collector import orchestrator as orch

KST = dt.timezone(dt.timedelta(hours=9))


def test_today_too_early_before_18():
    today = dt.date(2026, 5, 22)
    now = dt.datetime(2026, 5, 22, 17, 59, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260522", now) is True


def test_today_too_early_exactly_18_returns_false():
    now = dt.datetime(2026, 5, 22, 18, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260522", now) is False


def test_today_too_early_past_date_returns_false():
    now = dt.datetime(2026, 5, 22, 10, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260521", now) is False


def test_today_too_early_future_date_returns_false():
    now = dt.datetime(2026, 5, 22, 10, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("20260601", now) is False


def test_today_too_early_malformed_date_returns_false():
    now = dt.datetime(2026, 5, 22, 10, 0, 0, tzinfo=KST)
    assert orch.is_today_too_early("not-a-date", now) is False


def test_today_too_early_refused_raised_when_capture_today_pre_18():
    """collect_stock_date raises TodayTooEarlyRefused when policy hits."""
    from hoga.collector.client import HogaplayClientProto  # type: ignore[unused-ignore]
    # Just verify the exception type exists and inherits RuntimeError.
    assert issubclass(orch.TodayTooEarlyRefused, RuntimeError)
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_collector_today_too_early.py -v`
Expected: FAIL with `AttributeError: module 'hoga.collector.orchestrator' has no attribute 'is_today_too_early'` (and `TodayTooEarlyRefused`).

- [ ] **Step 3: Rename in `hoga/collector/orchestrator.py`**

Edit `hoga/collector/orchestrator.py`:

Replace the exception class block (currently around line 45):
```python
class TodayTooEarlyRefused(RuntimeError):
    """Capture target is today (KST) and now.hour < 18 — policy refuses regardless of Data Window state."""
```

Replace the predicate function (currently `is_partial_capture` around line 98):
```python
# Policy cutoff for "is it too early to capture today?" — distinct from
# _DATA_WINDOW_CLOSE_HOUR (= 16, when raw data stops). The 2-hour buffer
# accounts for hogaplay's post-close aggregation lag. See spec §11 Q14.
_TODAY_TOO_EARLY_HOUR = 18


def is_today_too_early(date: str, now: dt.datetime) -> bool:
    try:
        d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:8]))
    except (ValueError, IndexError):
        return False
    if d != now.date():
        return False
    return now.hour < _TODAY_TOO_EARLY_HOUR
```

Replace the `collect_stock_date` signature (drop `allow_partial`) and its body's policy check:

```python
def collect_stock_date(
    *,
    client: HogaplayClientProto,
    code: str,
    date: str,
    data_dir: Path,
    rate_limit_s: float = 0.2,
    resume: bool = False,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
) -> CollectResult:
    ...
    now = _now_kst()
    if is_today_too_early(date, now):
        raise TodayTooEarlyRefused(
            f"date={date} is today (KST) and now.hour={now.hour} < {_TODAY_TOO_EARLY_HOUR}. "
            "Wait until 18:00 KST."
        )
    ...
```

- [ ] **Step 4: Update `hoga/cli.py` — drop `--allow-partial`**

Edit `hoga/cli.py`: remove the `allow_partial: bool = typer.Option(False, "--allow-partial")` parameter and its `allow_partial=allow_partial` kwarg in the `collect_stock_date(...)` call.

- [ ] **Step 5: Update `hoga/api/captures.py` to remove `allow_partial`**

This is a transitional change — the old single-capture endpoint still exists (deleted in Task 15) but uses the new naming.

Edit `hoga/api/captures.py`:
- Line 35: remove `PartialCaptureRefused` from the orchestrator import; add `TodayTooEarlyRefused`.
- Line 38: replace `is_partial_capture` with `is_today_too_early`.
- Lines 59–60 (`_exception_to_error_code`): replace the `PartialCaptureRefused` branch with:
  ```python
  if isinstance(exc, TodayTooEarlyRefused):
      return "today_too_early"
  ```
- Line 269: drop `allow_partial=bool(state.options.get("allow_partial", False)),` from the `collect_stock_date(...)` call.
- Line 325 (`class StartCaptureRequest`): drop `allow_partial: bool = False` line.
- Lines 360–370: replace the `is_partial_capture` block with:
  ```python
  now_kst = datetime.now(tz=KST)
  if is_today_too_early(req.date, now_kst):
      raise HTTPException(
          status_code=400,
          detail={
              "code": "today_too_early",
              "message": (
                  f"date={req.date} is today (KST) and now.hour={now_kst.hour} < 18."
              ),
          },
      )
  ```
- Line 373: drop `"allow_partial": req.allow_partial,` from the options dict.

- [ ] **Step 6: Update existing tests — strip `allow_partial=True` (now default) and rewrite the partial-refused case**

Edit `tests/test_collector_orchestrator.py`:
- Lines 107, 136, 168, 215: remove the `allow_partial=True,` argument (the cutoff is now 18 KST so most test dates won't trigger refusal; if any test uses today's date, mock the clock past 18 or change the fixture date).
- Lines 187–194 (the `PartialCaptureRefused` block): rewrite as:
  ```python
  def test_collect_stock_date_today_too_early_refused(monkeypatch, tmp_path):
      """Today's date + now.hour < 18 raises TodayTooEarlyRefused."""
      KST = dt.timezone(dt.timedelta(hours=9))
      fixed_now = dt.datetime(2026, 5, 22, 17, 30, 0, tzinfo=KST)
      monkeypatch.setattr(orch, "_now_kst", lambda: fixed_now)
      with pytest.raises(orch.TodayTooEarlyRefused):
          orch.collect_stock_date(
              client=_make_fake_client(),
              code="005930",
              date="20260522",  # same day as fixed_now
              data_dir=tmp_path,
              rate_limit_s=0.0,
          )
  ```

Edit `tests/test_collector_progress_callback.py:53,75,98`: remove `allow_partial=True,`.

Edit `tests/test_collector_progress_finished.py:75,93`: remove `allow_partial=True,`.

Edit `tests/test_e2e_completeness.py:58`: remove `allow_partial=True,`.

Edit `tests/test_api_captures.py`:
- Line 27: rename import `PartialCaptureRefused` → `TodayTooEarlyRefused`.
- Line 34: rename the assertion code to `"today_too_early"`.
- Lines 70, 89, 121, 175, 236, 254: remove `"allow_partial": ...,` from the options dicts. (These tests die in Task 15 anyway — minimal touch here to keep them compiling.)
- Lines 261: drop the assertion that `options["allow_partial"]` is True.
- Lines 267–end: rewrite the partial-refused HTTP test to use `is_today_too_early`/`today_too_early` (same monkeypatch pattern as the orchestrator test above).

Edit `tests/test_api_sse_capture.py:73`: remove `"allow_partial": True,` from the options dict.

- [ ] **Step 7: Run the renamed test plus all touched files**

Run: `uv run pytest tests/test_collector_today_too_early.py tests/test_collector_orchestrator.py tests/test_collector_progress_callback.py tests/test_collector_progress_finished.py tests/test_e2e_completeness.py tests/test_api_captures.py tests/test_api_sse_capture.py -v 2>&1 | tail -30`
Expected: all pass. `is_today_too_early` is exercised by the new test file plus the rewritten orchestrator test.

- [ ] **Step 8: Confirm no `allow_partial` / `is_partial_capture` / `PartialCaptureRefused` references remain in production code**

Run: `grep -rn "allow_partial\|is_partial_capture\|PartialCaptureRefused" hoga/ 2>/dev/null`
Expected: zero matches (test fixtures may keep references; production code must be clean).

Run: `grep -rn "allow_partial\|is_partial_capture\|PartialCaptureRefused" tests/ 2>/dev/null`
Expected: zero matches (the rewritten tests use the new names; if anything remains it's a missed edit).

- [ ] **Step 9: Full pytest sweep to confirm no other test regressed**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green. Test count may have changed slightly (one new file, one rewritten test).

- [ ] **Step 10: Commit**

```bash
git add hoga/collector/orchestrator.py hoga/cli.py hoga/api/captures.py tests/test_collector_today_too_early.py tests/test_collector_orchestrator.py tests/test_collector_progress_callback.py tests/test_collector_progress_finished.py tests/test_e2e_completeness.py tests/test_api_captures.py tests/test_api_sse_capture.py
git commit -m "$(cat <<'EOF'
refactor(Q14): rename is_partial_capture → is_today_too_early, drop allow_partial

Policy cutoff is now 18 KST (was 16), backend-enforced. Data Window close
constant (16) stays under its original name — orthogonal concept. Removes
the `allow_partial` parameter from `collect_stock_date` and the API surface;
renames `PartialCaptureRefused` → `TodayTooEarlyRefused` so "partial"
unambiguously refers to the data-completeness bit going forward.

See spec §11 Q14.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Models — `QueueItem`, `SymbolHit`, `CalendarCell` + new SSE event classes

Lay down all wire shapes first. Once these compile + round-trip, every subsequent task can reference them by name without forward-declaring.

**Files:**
- Modify: `hoga/api/models.py` (extend `CapturePhase` literal; rename `_CaptureEventBase.job_id` → `item_id`; add `QueueItem`, `SymbolHit`, `SymbolsAllResponse`, `CalendarCell`, `CalendarResponse`, `CaptureQueuedEvent`, `CaptureQueuePausedEvent`, `CaptureQueueResumedEvent`, `CaptureQueueDrainedEvent`; extend `CaptureFinishedEvent` with `skip_reason`)
- Modify: `hoga/api/captures.py` (update `state.event_header()` and `CaptureJobState.job_id` → `item_id` references where they cross the wire — this is a partial transitional rename that completes in Task 15)
- Test: `tests/test_api_models_capture_queue.py` [new]

- [ ] **Step 1: Write the failing model-shape tests**

Create `tests/test_api_models_capture_queue.py`:
```python
"""Wire shape tests for Plan B model additions. Pure pydantic round-trip
checks — no business logic. Catches accidental field renames at the boundary."""
from __future__ import annotations

import json
from hoga.api.models import (
    CalendarCell,
    CalendarResponse,
    CaptureFinishedEvent,
    CaptureProgressEvent,
    CaptureQueuedEvent,
    CaptureQueueDrainedEvent,
    CaptureQueuePausedEvent,
    CaptureQueueResumedEvent,
    QueueItem,
    SymbolHit,
    SymbolsAllResponse,
)


def test_queue_item_roundtrip():
    item = QueueItem(
        item_id="20260522T103000-005930-20260520",
        code="005930",
        date="20260520",
        phase="queued",
        force_retry=False,
        pause_origin=False,
        enqueued_at_ms=1_700_000_000_000,
    )
    payload = json.loads(item.model_dump_json())
    assert payload["item_id"].endswith("-20260520")
    assert payload["phase"] == "queued"
    assert payload["force_retry"] is False
    assert payload["pause_origin"] is False


def test_symbol_hit_includes_complete_count_and_breakdown():
    hit = SymbolHit(
        code="005930",
        name="삼성전자",
        market="KOSPI",
        captured_count=14,
        captured_breakdown={"complete": 14, "source_partial": 3, "client_incomplete": 2},
    )
    payload = json.loads(hit.model_dump_json())
    assert payload["captured_count"] == 14  # complete only, the headline
    assert payload["captured_breakdown"]["source_partial"] == 3
    assert payload["captured_breakdown"]["client_incomplete"] == 2


def test_symbols_all_response_envelope():
    resp = SymbolsAllResponse(symbols=[], status="loading", fetched_at_ms=None)
    payload = json.loads(resp.model_dump_json())
    assert payload["status"] == "loading"
    assert payload["fetched_at_ms"] is None


def test_calendar_cell_shape():
    cell = CalendarCell(date="20260520", status="complete", captured_at_ms=1_700_000_000_000)
    payload = json.loads(cell.model_dump_json())
    assert payload["status"] == "complete"
    assert payload["captured_at_ms"] == 1_700_000_000_000


def test_calendar_response_carries_as_of_ms():
    resp = CalendarResponse(cells=[], as_of_ms=1_700_000_000_500)
    payload = json.loads(resp.model_dump_json())
    assert payload["as_of_ms"] == 1_700_000_000_500


def test_progress_event_uses_item_id_not_job_id():
    """spec §3.4: all payloads carry item_id (renamed from job_id)."""
    from hoga.api.models import CaptureProgress
    evt = CaptureProgressEvent(
        item_id="x",
        code="005930",
        date="20260520",
        phase="capturing",
        progress=CaptureProgress(pages_done=1, events_seen=10, frontier_ms=0, estimate_pct=5, elapsed_ms=100),
    )
    payload = json.loads(evt.model_dump_json())
    assert "item_id" in payload and "job_id" not in payload
    assert payload["type"] == "capture_progress"


def test_finished_event_carries_skip_reason():
    evt = CaptureFinishedEvent(
        item_id="x", code="005930", date="20260520", phase="skipped",
        skip_reason="already_complete",
    )
    payload = json.loads(evt.model_dump_json())
    assert payload["skip_reason"] == "already_complete"


def test_queued_event_carries_items_array():
    items = [QueueItem(
        item_id=f"x-{i}", code="005930", date=f"2026052{i}", phase="queued",
        force_retry=False, pause_origin=False, enqueued_at_ms=0,
    ) for i in range(3)]
    evt = CaptureQueuedEvent(items=items)
    payload = json.loads(evt.model_dump_json())
    assert payload["type"] == "capture_queued"
    assert len(payload["items"]) == 3


def test_queue_paused_resumed_drained_event_types():
    paused = CaptureQueuePausedEvent(reason="cookie_expired", message="cookie expired")
    resumed = CaptureQueueResumedEvent()
    drained = CaptureQueueDrainedEvent(total_done=5, total_failed=1, total_cancelled=2, total_skipped=3)
    assert json.loads(paused.model_dump_json())["type"] == "capture_queue_paused"
    assert json.loads(resumed.model_dump_json())["type"] == "capture_queue_resumed"
    assert json.loads(drained.model_dump_json())["type"] == "capture_queue_drained"
    assert json.loads(drained.model_dump_json())["total_done"] == 5
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_api_models_capture_queue.py -v 2>&1 | tail -15`
Expected: FAIL — ImportError on `QueueItem`, `SymbolHit`, etc.

- [ ] **Step 3: Extend `hoga/api/models.py`**

Edit `hoga/api/models.py`:

Replace the `CapturePhase` literal (currently around line 132) to add the queue-phase values:

```python
CapturePhase = Literal[
    "queued", "deciding", "capturing", "parsing",
    "done", "failed", "cancelled", "skipped",
]
SkipReason = Literal["already_complete", "source_partial"]
```

Replace `_CaptureEventBase` (currently around line 179) — rename `job_id` → `item_id`:

```python
class _CaptureEventBase(BaseModel):
    item_id: str
    code: str
    date: str
    phase: CapturePhase
```

Extend `CaptureFinishedEvent` (currently around line 197) with a `skip_reason` field:

```python
class CaptureFinishedEvent(_CaptureEventBase):
    """Terminal event. `phase` is one of done | failed | cancelled | skipped."""
    type: Literal["capture_finished"] = "capture_finished"
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None  # set when phase == "skipped"
```

Replace the old `CaptureJob` (currently around line 158) with the new `QueueItem` shape, and keep `CaptureJob` as an alias for one task only (Task 15 deletes it):

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


# Transitional alias — Task 15 deletes CaptureJob along with the old _latest singleton.
CaptureJob = QueueItem
```

Add the new SSE event classes (at the bottom of the file):

```python
class CaptureQueuedEvent(BaseModel):
    type: Literal["capture_queued"] = "capture_queued"
    items: list[QueueItem]


class CaptureQueuePausedEvent(BaseModel):
    type: Literal["capture_queue_paused"] = "capture_queue_paused"
    reason: Literal["cookie_expired"]
    message: str


class CaptureQueueResumedEvent(BaseModel):
    type: Literal["capture_queue_resumed"] = "capture_queue_resumed"
    reason: Literal["user_resume", "cancel_all"] = "user_resume"


class CaptureQueueDrainedEvent(BaseModel):
    type: Literal["capture_queue_drained"] = "capture_queue_drained"
    total_done: int
    total_failed: int
    total_cancelled: int
    total_skipped: int


# Wire models for the new sibling endpoints (Tasks 16–17).

class SymbolHit(BaseModel):
    code: str
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    captured_count: int               # complete only — headline number (spec §11 Q18)
    captured_breakdown: dict[str, int]  # {"complete": N, "source_partial": M, "client_incomplete": K}


class SymbolsAllResponse(BaseModel):
    symbols: list[SymbolHit]
    status: Literal["fresh", "loading", "stale", "unavailable"]
    fetched_at_ms: int | None


CalendarStatus = Literal[
    "complete", "source_partial", "client_incomplete", "none",
    "weekend", "holiday", "future", "today_locked",
]


class CalendarCell(BaseModel):
    date: str
    status: CalendarStatus
    captured_at_ms: int | None = None


class CalendarResponse(BaseModel):
    cells: list[CalendarCell]
    as_of_ms: int                       # server wall-clock when cells were read (spec §11 Q21)
```

- [ ] **Step 4: Update `hoga/api/captures.py` to use `item_id`**

This is a partial rename — `CaptureJobState.job_id` field stays internally (so `_latest` keeps working through Task 14), but the event emission paths now use `item_id`:

Edit `hoga/api/captures.py:106–113` (`event_header`):
```python
def event_header(self) -> dict[str, Any]:
    """Common fields every capture_* SSE event carries."""
    return {
        "item_id": self.job_id,   # internal field name unchanged for now (Task 15 finalizes)
        "code": self.code,
        "date": self.date,
        "phase": self.phase,
    }
```

Edit `hoga/api/captures.py:115–123` (`to_wire`): since `CaptureJob` is now an alias for `QueueItem`, supply the new fields conservatively:
```python
def to_wire(self) -> CaptureJob:
    return CaptureJob(
        item_id=self.job_id,
        code=self.code,
        date=self.date,
        phase=self.phase,                # type: ignore[arg-type]
        force_retry=False,                # old singleton path never set this
        pause_origin=False,
        enqueued_at_ms=self.started_at_ms or 0,
        started_at_ms=self.started_at_ms or None,
        progress=self.to_progress(),
        result=self.result,
        error=self.error,
    )
```

Edit `hoga/api/captures.py` tests that assert against `job_id` — `tests/test_api_captures.py` and `tests/test_api_sse_capture.py` — substitute `"item_id"` for `"job_id"` in their JSON assertions. (Both files die in Task 15; this just keeps them compiling.)

Run `grep -n '"job_id"' tests/test_api_captures.py tests/test_api_sse_capture.py` to find every assertion that needs updating; replace each with `"item_id"`.

- [ ] **Step 5: Run the new model tests + existing captures tests**

Run: `uv run pytest tests/test_api_models_capture_queue.py tests/test_api_captures.py tests/test_api_sse_capture.py -v 2>&1 | tail -25`
Expected: all green.

- [ ] **Step 6: Full pytest sweep**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/models.py hoga/api/captures.py tests/test_api_models_capture_queue.py tests/test_api_captures.py tests/test_api_sse_capture.py
git commit -m "$(cat <<'EOF'
feat(models): QueueItem + SymbolHit + CalendarCell + new SSE event classes

Adds the wire shapes Plan B needs. Renames `job_id` → `item_id` on the
SSE event base (spec §3.4). Extends CapturePhase with queued/deciding/skipped.
`CaptureJob` kept as a transitional alias for `QueueItem` until the old
_latest singleton is removed in Task 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Queue state singletons + reset helper

Stand up `_queue`, `_active`, `_done`, `_inflight_paths`, `_queue_paused`, `_max_concurrent`, `_wakeup`. Coexist with the old `_latest` for now. Add `get_queue_snapshot()` so subsequent tasks have something to inspect.

**Files:**
- Modify: `hoga/api/captures.py` (add new singletons + helpers near the existing `_lock` block at ~line 130)
- Test: `tests/test_api_captures_queue.py` [new]

- [ ] **Step 1: Write the failing snapshot-shape test**

Create `tests/test_api_captures_queue.py`:
```python
"""Plan B queue/worker tests. Built up across Tasks 3–15."""
from __future__ import annotations

import asyncio
import pytest
from hoga.api import captures


@pytest.fixture(autouse=True)
def _reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


def test_initial_snapshot_is_empty():
    snap = captures.get_queue_snapshot()
    assert snap.active == []
    assert snap.queued == []
    assert snap.done == []
    assert snap.paused is False
    assert snap.max_concurrent >= 1


def test_max_concurrent_reads_env_default_3(monkeypatch):
    monkeypatch.delenv("HOGA_MAX_CONCURRENT", raising=False)
    snap = captures.get_queue_snapshot()
    # Default 3 unless overridden — but the module reads env at import time,
    # so we just check it's a positive int matching what the module loaded.
    assert isinstance(snap.max_concurrent, int) and snap.max_concurrent >= 1


def test_reset_state_clears_queue_active_done_and_pause():
    # Mutate then reset, then re-check.
    captures._queue.append(object())  # type: ignore[arg-type]
    captures._active["x"] = object()  # type: ignore[assignment]
    captures._done.append(object())   # type: ignore[arg-type]
    captures._inflight_paths.add(("005930", "20260520"))
    captures._queue_paused = True
    captures.reset_state_for_tests()
    snap = captures.get_queue_snapshot()
    assert snap.queued == [] and snap.active == [] and snap.done == []
    assert snap.paused is False
    assert captures._inflight_paths == set()
```

Also add the snapshot Wire Model to `hoga/api/models.py`:
```python
class QueueSnapshot(BaseModel):
    active: list[QueueItem]
    queued: list[QueueItem]
    done: list[QueueItem]
    paused: bool
    max_concurrent: int
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_api_captures_queue.py -v 2>&1 | tail -10`
Expected: FAIL on `get_queue_snapshot` / `_inflight_paths` not existing.

- [ ] **Step 3: Add the state singletons to `hoga/api/captures.py`**

Edit `hoga/api/captures.py` — add a block after the existing `_lock = asyncio.Lock()` (around line 130):

```python
import collections

# --- Queue state singletons (Plan B) ---------------------------------------
# These coexist with the legacy `_latest` until Task 15 removes the old
# singleton. New code paths only ever touch the queue surface.

_queue: collections.deque[Any] = collections.deque()    # deque[QueueItemState]
_active: dict[str, Any] = {}                            # item_id → QueueItemState
_done: list[Any] = []                                   # terminal items, cleared by DELETE /done
_inflight_paths: set[tuple[str, str]] = set()           # (code, date) — see spec §11 Q15 Layer 2
_queue_paused: bool = False
_max_concurrent: int = int(os.environ.get("HOGA_MAX_CONCURRENT", "3"))
_wakeup: asyncio.Event | None = None                    # lazily constructed when the first worker starts
```

Add the snapshot helper at module bottom (before `build_router`):

```python
from hoga.api.models import QueueSnapshot


def get_queue_snapshot() -> QueueSnapshot:
    """Build the wire-side snapshot of queue/active/done. Read-only."""
    return QueueSnapshot(
        active=[s.to_wire() for s in _active.values()],
        queued=[s.to_wire() for s in _queue],
        done=[s.to_wire() for s in _done],
        paused=_queue_paused,
        max_concurrent=_max_concurrent,
    )
```

Update `reset_state_for_tests`:
```python
def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears all module singletons."""
    global _latest, _queue_paused  # noqa: PLW0603
    _latest = None
    _queue.clear()
    _active.clear()
    _done.clear()
    _inflight_paths.clear()
    _queue_paused = False
```

- [ ] **Step 4: Add a placeholder `QueueItemState` dataclass to support `to_wire()`**

Edit `hoga/api/captures.py` — add the dataclass alongside `CaptureJobState` (~line 73):

```python
@dataclass
class QueueItemState:
    """Mutable server-side state for one queue item. Not a Wire Model."""
    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    phase: str = "queued"
    pause_origin: bool = False
    started_at_ms: int | None = None
    pages_done: int = 0
    events_seen: int = 0
    frontier: HogaMs = HogaMs(0)
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: str | None = None
    cancel_token: Any = None

    def to_progress(self) -> CaptureProgress | None:
        if self.pages_done == 0:
            return None
        return CaptureProgress(
            pages_done=self.pages_done,
            events_seen=self.events_seen,
            frontier_ms=hhmmssms_to_unix_ms(self.date, self.frontier),
            estimate_pct=self.estimate_pct,
            elapsed_ms=self.elapsed_ms,
        )

    def event_header(self) -> dict[str, Any]:
        return {"item_id": self.item_id, "code": self.code, "date": self.date, "phase": self.phase}

    def to_wire(self):
        from hoga.api.models import QueueItem
        return QueueItem(
            item_id=self.item_id,
            code=self.code,
            date=self.date,
            phase=self.phase,  # type: ignore[arg-type]
            force_retry=self.force_retry,
            pause_origin=self.pause_origin,
            enqueued_at_ms=self.enqueued_at_ms,
            started_at_ms=self.started_at_ms,
            progress=self.to_progress(),
            result=self.result,
            error=self.error,
            skip_reason=self.skip_reason,  # type: ignore[arg-type]
        )

    @property
    def is_terminal(self) -> bool:
        return self.phase in ("done", "failed", "cancelled", "skipped")
```

- [ ] **Step 5: Run test**

Run: `uv run pytest tests/test_api_captures_queue.py -v`
Expected: PASS.

- [ ] **Step 6: Confirm baseline still green**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/captures.py hoga/api/models.py tests/test_api_captures_queue.py
git commit -m "feat(captures): queue state singletons + snapshot helper

Adds _queue / _active / _done / _inflight_paths / _queue_paused /
_max_concurrent + QueueItemState dataclass + QueueSnapshot wire model.
Coexists with the legacy _latest singleton until Task 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Worker loop skeleton — drives queued → done with a stub runner

Build the asyncio task pump first, before wiring it to the collector. The stub runner just sleeps briefly and marks `done`. Worker pool start/stop hooks added.

**Files:**
- Modify: `hoga/api/captures.py` (add `_worker_loop`, `start_workers`, `stop_workers`, `_publish_phase`, `_finalize_item`)
- Test: `tests/test_api_captures_queue.py` (extend with worker-pool tests)

- [ ] **Step 1: Write the failing worker-pool test**

Append to `tests/test_api_captures_queue.py`:
```python
import time
from hoga.api.captures import QueueItemState


def _make_item(item_id: str, code: str = "005930", date: str = "20260520"):
    return QueueItemState(
        item_id=item_id, code=code, date=date,
        force_retry=False, enqueued_at_ms=int(time.time() * 1000),
    )


@pytest.mark.asyncio
async def test_worker_pool_drains_three_items_with_stub_runner(monkeypatch):
    """With a stub _run_item that just marks done, the worker pool transitions
    all queued items to done."""
    # Stub the collector path with a no-op.
    async def _stub_run(state):
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_item", _stub_run)
    monkeypatch.setattr(captures, "_max_concurrent", 3, raising=False)

    for i in range(3):
        captures._queue.append(_make_item(f"x-{i}", date=f"2026052{i}"))

    workers = captures.start_workers(n=3)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    assert snap.active == []
    assert len(snap.done) == 3
    assert all(item.phase == "done" for item in snap.done)


@pytest.mark.asyncio
async def test_worker_pool_respects_max_concurrent(monkeypatch):
    """With max_concurrent=2 and a slow stub runner, only 2 items are active at once."""
    sem = asyncio.Semaphore(0)
    max_seen_active = 0

    async def _slow_run(state):
        nonlocal max_seen_active
        max_seen_active = max(max_seen_active, len(captures._active))
        await sem.acquire()
        state.phase = "done"

    monkeypatch.setattr(captures, "_run_item", _slow_run)
    monkeypatch.setattr(captures, "_max_concurrent", 2, raising=False)

    for i in range(5):
        captures._queue.append(_make_item(f"x-{i}", date=f"2026052{i}"))

    workers = captures.start_workers(n=2)
    # Let the loop tick so 2 items become active.
    await asyncio.sleep(0.05)
    assert len(captures._active) == 2
    # Release them one at a time.
    for _ in range(5):
        sem.release()
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert max_seen_active == 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_api_captures_queue.py -v 2>&1 | tail -10`
Expected: FAIL on `start_workers` / `wait_drained` not existing.

- [ ] **Step 3: Implement the worker pool in `hoga/api/captures.py`**

Add near the bottom of `hoga/api/captures.py`, before `build_router`:

```python
async def _publish_phase(state: QueueItemState) -> None:
    _publish_event(CapturePhaseEvent(**state.event_header()))


async def _run_item(state: QueueItemState) -> None:
    """Default item-running path. Tasks 5+ replace this with the deciding/
    capturing/parsing pipeline. Stub for Task 4: just mark done immediately
    so the pump infrastructure can be tested in isolation."""
    state.phase = "done"


async def _finalize_item(state: QueueItemState) -> None:
    """Move state into _done, publish finished, wake other workers, emit
    drained if applicable."""
    from hoga.api.models import CaptureQueueDrainedEvent
    async with _lock:
        _active.pop(state.item_id, None)
        _inflight_paths.discard((state.code, state.date))
        _done.append(state)
        # Drain detection — also check we're not paused (drained only fires
        # when the queue has naturally bottomed out).
        if not _queue and not _active and not _queue_paused:
            totals = {
                "total_done": sum(1 for s in _done if s.phase == "done"),
                "total_failed": sum(1 for s in _done if s.phase == "failed"),
                "total_cancelled": sum(1 for s in _done if s.phase == "cancelled"),
                "total_skipped": sum(1 for s in _done if s.phase == "skipped"),
            }
            _publish_event(CaptureQueueDrainedEvent(**totals))
        if _wakeup is not None:
            _wakeup.set()
    _publish_event(CaptureFinishedEvent(
        **state.event_header(),
        result=state.result,
        error=state.error,
        skip_reason=state.skip_reason,  # type: ignore[arg-type]
    ))


async def _worker_loop() -> None:
    """One of N coroutines. Pulls items off _queue under the lock, runs each,
    finalizes."""
    global _wakeup  # noqa: PLW0603
    while True:
        async with _lock:
            if _queue_paused or len(_active) >= _max_concurrent or not _queue:
                if _wakeup is None:
                    _wakeup = asyncio.Event()
                wait = _wakeup.wait()
            else:
                state = _queue.popleft()
                state.phase = "deciding"
                _active[state.item_id] = state
                wait = None
        if wait is not None:
            await wait
            async with _lock:
                if _wakeup is not None:
                    _wakeup.clear()
            continue
        # Outside the lock: notify deciding, run, finalize.
        await _publish_phase(state)
        try:
            await _run_item(state)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — terminal path
            state.error = CaptureError(
                code=_exception_to_error_code(exc) or "internal_error",
                message=str(exc),
                at_page=state.pages_done or None,
            )
            state.phase = "failed"
        await _finalize_item(state)


def start_workers(n: int | None = None) -> list[asyncio.Task]:
    """Spin up the worker pool. Idempotent in test scope only — production
    lifespan calls this exactly once."""
    global _wakeup  # noqa: PLW0603
    if _wakeup is None:
        _wakeup = asyncio.Event()
    n = n if n is not None else _max_concurrent
    return [asyncio.create_task(_worker_loop(), name=f"capture-worker-{i}") for i in range(n)]


async def stop_workers(workers: list[asyncio.Task]) -> None:
    for w in workers:
        w.cancel()
    for w in workers:
        try:
            await w
        except asyncio.CancelledError:
            pass


async def wait_drained() -> None:
    """Block until both _queue and _active are empty (and not paused).
    Used by tests; production code listens for the SSE event instead."""
    while True:
        async with _lock:
            done = not _queue and not _active and not _queue_paused
        if done:
            return
        await asyncio.sleep(0.01)
```

- [ ] **Step 4: Make sure `asyncio_mode = "auto"` or `pytest-asyncio` decorators work**

Run: `grep -n "asyncio_mode\|pytest.ini\|pyproject" pyproject.toml | head -5; grep -rn "asyncio_mode\|pytest-asyncio" pyproject.toml`
Expected: shows existing pytest-asyncio config. If it's `auto` mode, drop the `@pytest.mark.asyncio` decorators; if it's `strict`, keep them. Either way, confirm by running the new tests.

- [ ] **Step 5: Run the worker tests**

Run: `uv run pytest tests/test_api_captures_queue.py -v 2>&1 | tail -15`
Expected: all green.

- [ ] **Step 6: Confirm baseline**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): worker pool skeleton (asyncio task pump)

start_workers / stop_workers / wait_drained + _worker_loop with stub
_run_item. Respects _max_concurrent + _queue_paused. Publishes
capture_phase + capture_finished + capture_queue_drained. Task 5 wires
the collector into _run_item.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire `disk_state.check_disk_state` into the deciding phase

Replace the stub `_run_item` with the full pipeline: deciding (consult disk_state) → skipped OR (capturing → parsing → done). 429 backoff and cookie pause come in Tasks 10–11; this task does the happy path + skip branches.

**Files:**
- Modify: `hoga/api/captures.py` (rewrite `_run_item`)
- Test: `tests/test_api_captures_queue.py` (extend)

- [ ] **Step 1: Write failing deciding-phase tests**

Append to `tests/test_api_captures_queue.py`:
```python
from hoga.api.disk_state import DiskState


@pytest.mark.asyncio
async def test_deciding_skips_complete(monkeypatch, tmp_path):
    """When disk_state.check_disk_state returns COMPLETE, item is skipped."""
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.COMPLETE)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    assert snap.done[0].phase == "skipped"
    assert snap.done[0].skip_reason == "already_complete"


@pytest.mark.asyncio
async def test_deciding_skips_source_partial(monkeypatch, tmp_path):
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.SOURCE_PARTIAL)

    captures._queue.append(_make_item("x-1"))  # force_retry=False
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.done[0].phase == "skipped"
    assert snap.done[0].skip_reason == "source_partial"


@pytest.mark.asyncio
async def test_deciding_resumes_client_incomplete(monkeypatch, tmp_path):
    """CLIENT_INCOMPLETE forces resume=True in the collector call."""
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.CLIENT_INCOMPLETE)

    captured = {}
    async def _stub_capture(state, resume):
        captured["resume"] = resume
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _stub_capture)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert captured.get("resume") is True


@pytest.mark.asyncio
async def test_force_retry_overrides_source_partial_skip(monkeypatch, tmp_path):
    """SOURCE_PARTIAL + force_retry=True → falls through to fresh capture."""
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.SOURCE_PARTIAL)

    captured = {}
    async def _stub_capture(state, resume):
        captured["resume"] = resume
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _stub_capture)

    item = _make_item("x-1")
    item.force_retry = True
    captures._queue.append(item)
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert captured.get("resume") is False  # fresh, not resume
    snap = captures.get_queue_snapshot()
    assert snap.done[0].phase == "done"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_api_captures_queue.py -k "deciding or force_retry" -v 2>&1 | tail -15`
Expected: FAIL — `_run_capture_and_parse` not defined.

- [ ] **Step 3: Implement the deciding pipeline**

Edit `hoga/api/captures.py` — add `_data_dir_for_tests` injection seam + replace `_run_item`:

```python
from hoga.api.disk_state import DiskState, check_disk_state

# Injection seam for tests; production replaces this in build_router() closure.
_data_dir_for_tests: Callable[[], Path] | None = None
_client_factory_for_tests: Callable[[], Any] | None = None


def _resolve_data_dir() -> Path:
    if _data_dir_for_tests is not None:
        return _data_dir_for_tests()
    # In production, captures._data_dir is set during build_router init.
    return _data_dir  # type: ignore[name-defined]


def _resolve_client_factory() -> Callable[[], Any]:
    if _client_factory_for_tests is not None:
        return _client_factory_for_tests
    return _client_factory  # type: ignore[name-defined]


async def _run_capture_and_parse(state: QueueItemState, resume: bool) -> None:
    """Run the collector then the parser. Equivalent to the old
    _run_capture_job (sans the partial/cookie-missing rejection — those
    moved to the route guard and the cookie-pause path). Replaced/wrapped
    with backoff in Task 11."""
    from hoga.collector.orchestrator import CancelToken, collect_stock_date
    from hoga.parser import parse_stock_date
    if state.cancel_token is None:
        state.cancel_token = CancelToken()
    data_dir = _resolve_data_dir()
    client = _resolve_client_factory()()

    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    await _publish_phase(state)

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: collect_stock_date(
            client=client,
            code=state.code,
            date=state.date,
            data_dir=data_dir,
            rate_limit_s=0.0 if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1" else 0.2,
            resume=resume,
            on_progress=_make_progress_callback(state),
            cancel_token=state.cancel_token,
        ),
    )

    state.phase = "parsing"
    await _publish_phase(state)
    await loop.run_in_executor(
        None,
        lambda: parse_stock_date(code=state.code, date=state.date,
                                 data_dir=data_dir, lenient=False),
    )

    state.result = CaptureResult(
        pages_written=result.pages_written,
        unique_events=result.unique_events,
        raw_dir=str(result.raw_dir),
        parsed=True,
    )
    state.phase = "done"


async def _run_item(state: QueueItemState) -> None:
    """Full pipeline: deciding → (skipped | capturing → parsing → done)."""
    data_dir = _resolve_data_dir()
    disk = check_disk_state(data_dir, state.code, state.date)

    if disk == DiskState.COMPLETE:
        state.phase = "skipped"
        state.skip_reason = "already_complete"
        return
    if disk == DiskState.SOURCE_PARTIAL and not state.force_retry:
        state.phase = "skipped"
        state.skip_reason = "source_partial"
        return

    resume_flag = (disk == DiskState.CLIENT_INCOMPLETE)
    await _run_capture_and_parse(state, resume=resume_flag)
```

Also adjust `_make_progress_callback` to use the new `QueueItemState` type (it already works because `_apply_progress` only touches duck-typed fields, but verify):

`_apply_progress` (already in file) reads `state.pages_done`, `state.events_seen`, `state.frontier`, `state.elapsed_ms`, `state.estimate_pct`, `state.started_at_ms`, `state.event_header()`. All exist on `QueueItemState` with matching shapes. No change needed.

- [ ] **Step 4: Run deciding tests**

Run: `uv run pytest tests/test_api_captures_queue.py -k "deciding or force_retry" -v 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Full pytest sweep**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): deciding phase consumes disk_state.check_disk_state

Worker pipeline becomes deciding → (skipped | capturing → parsing → done).
COMPLETE → skipped/already_complete. SOURCE_PARTIAL → skipped/source_partial
unless force_retry. CLIENT_INCOMPLETE → resume=True. NONE → fresh.

See spec §5.2 worker algorithm + §11 Q16 force_retry semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Per-(code, date) inflight lock (Q15 Layer 2)

Two enqueues for the same (code, date) race past Layer 1 (because Layer 1 is enqueue-time). Layer 2 catches the rest: the worker deciding phase checks `_inflight_paths` under the lock; if collision, the item is requeued and the worker picks the next slot.

**Files:**
- Modify: `hoga/api/captures.py` (wrap `_run_item` with the inflight check)
- Test: `tests/test_api_captures_queue.py`

- [ ] **Step 1: Write the failing inflight-collision test**

Append to `tests/test_api_captures_queue.py`:
```python
@pytest.mark.asyncio
async def test_worker_defers_when_inflight_collision(monkeypatch, tmp_path):
    """If two items have the same (code, date) and the first is already in
    _inflight_paths, the second worker requeues it instead of double-running."""
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)

    start_order: list[str] = []
    finish_order: list[str] = []
    sem = asyncio.Semaphore(0)

    async def _capture(state, resume):
        start_order.append(state.item_id)
        await sem.acquire()
        state.phase = "done"
        finish_order.append(state.item_id)
    monkeypatch.setattr(captures, "_run_capture_and_parse", _capture)

    # Both items share (005930, 20260520)
    captures._queue.append(_make_item("x-1", date="20260520"))
    captures._queue.append(_make_item("x-2", date="20260520"))

    workers = captures.start_workers(n=2)
    await asyncio.sleep(0.1)
    # Only one started; the other got requeued.
    assert len(start_order) == 1
    sem.release()
    await asyncio.sleep(0.1)
    sem.release()
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert sorted(finish_order) == ["x-1", "x-2"]
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_api_captures_queue.py::test_worker_defers_when_inflight_collision -v`
Expected: FAIL — both items run concurrently.

- [ ] **Step 3: Add the inflight check inside `_worker_loop`**

Edit `hoga/api/captures.py` — modify `_worker_loop` to claim the inflight path under the lock:

```python
async def _worker_loop() -> None:
    global _wakeup  # noqa: PLW0603
    while True:
        async with _lock:
            if _queue_paused or len(_active) >= _max_concurrent or not _queue:
                if _wakeup is None:
                    _wakeup = asyncio.Event()
                wait = _wakeup.wait()
                state = None
            else:
                state = _queue.popleft()
                # Q15 Layer 2: per-(code, date) inflight lock.
                if (state.code, state.date) in _inflight_paths:
                    # Collision — requeue to back, do not occupy a slot.
                    _queue.append(state)
                    state = None
                    wait = None
                else:
                    _inflight_paths.add((state.code, state.date))
                    state.phase = "deciding"
                    _active[state.item_id] = state
                    wait = None
        if wait is not None:
            await wait
            async with _lock:
                if _wakeup is not None:
                    _wakeup.clear()
            continue
        if state is None:
            # Requeued; yield so other workers / the requeued slot can proceed.
            await asyncio.sleep(0)
            continue
        await _publish_phase(state)
        try:
            await _run_item(state)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            state.error = CaptureError(
                code=_exception_to_error_code(exc) or "internal_error",
                message=str(exc),
                at_page=state.pages_done or None,
            )
            state.phase = "failed"
        await _finalize_item(state)
```

`_finalize_item` already discards from `_inflight_paths` in its `async with _lock` block (added in Task 4) — no change needed.

- [ ] **Step 4: Run inflight test**

Run: `uv run pytest tests/test_api_captures_queue.py::test_worker_defers_when_inflight_collision -v`
Expected: PASS.

- [ ] **Step 5: Full pytest sweep**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): per-(code, date) inflight lock — Q15 Layer 2

Worker enters deciding only after claiming (code, date) in _inflight_paths.
On collision the item is requeued; the worker yields and picks the next
slot. Layer 1 (enqueue-time dedupe) follows in Task 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `POST /api/captures/items` — enqueue with Q15 Layer 1 dedupe + Q14 18 KST guard

The first new route. Expands the requested range to trading days, filters duplicates against `_queue ∪ _active ∪ _inflight_paths`, rejects pre-18 KST today dates, returns the enqueued list + dedupe report, emits `CaptureQueuedEvent`.

**Files:**
- Modify: `hoga/api/captures.py` (add the route inside `build_router`)
- Modify: `hoga/api/models.py` (add `EnqueueRequest`, `EnqueueResponse`)
- Test: `tests/test_api_captures_queue.py` (HTTP-level tests via FastAPI TestClient)

- [ ] **Step 1: Add request/response models**

Edit `hoga/api/models.py`:
```python
class EnqueueRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    start_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    end_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    dates: list[str] | None = None         # alternative to start/end
    force_retry: bool = False


class EnqueueDedupedRow(BaseModel):
    code: str
    date: str
    reason: Literal["already_in_queue", "already_running"]


class EnqueueResponse(BaseModel):
    enqueued: list[QueueItem]
    deduped: list[EnqueueDedupedRow]
```

Note: also `from pydantic import Field` at the top (already imported elsewhere in models, verify).

- [ ] **Step 2: Write the failing enqueue route tests**

Append to `tests/test_api_captures_queue.py`:
```python
import datetime as dt
from fastapi.testclient import TestClient


def _build_test_app(monkeypatch, tmp_path):
    from hoga.api.app import create_app
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    app = create_app()
    return app


def test_enqueue_expands_date_range_to_trading_days(monkeypatch, tmp_path):
    """start_date=20260518 (Mon) end_date=20260520 (Wed) → 3 trading-day items."""
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "start_date": "20260518", "end_date": "20260520",
            "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 3
        assert [it["date"] for it in body["enqueued"]] == ["20260518", "20260519", "20260520"]
        assert body["deduped"] == []


def test_enqueue_skips_weekend_dates(monkeypatch, tmp_path):
    """Range spanning a weekend yields only weekday items."""
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        # 20260515 Fri → 20260518 Mon. Sat+Sun excluded.
        r = c.post("/api/captures/items", json={
            "code": "005930", "start_date": "20260515", "end_date": "20260518",
            "force_retry": False,
        })
        assert r.status_code == 201
        body = r.json()
        assert {it["date"] for it in body["enqueued"]} == {"20260515", "20260518"}


def test_enqueue_rejects_today_pre_18_kst(monkeypatch, tmp_path):
    """A date matching today_kst before 18:00 → 400 today_too_early."""
    app = _build_test_app(monkeypatch, tmp_path)
    KST = dt.timezone(dt.timedelta(hours=9))
    fixed_now = dt.datetime(2026, 5, 22, 17, 30, 0, tzinfo=KST)
    monkeypatch.setattr("hoga.api.captures._now_kst", lambda: fixed_now, raising=False)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260522"], "force_retry": False,
        })
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "today_too_early"


def test_enqueue_dedupes_duplicate_dates_in_request(monkeypatch, tmp_path):
    """Same (code, date) submitted twice in one request → one enqueued, one deduped."""
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520", "20260520"], "force_retry": False,
        })
        assert r.status_code == 201
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert len(body["deduped"]) == 1
        assert body["deduped"][0]["reason"] == "already_in_queue"


def test_enqueue_dedupes_against_existing_queue(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert r.status_code == 201
        body = r.json()
        assert body["enqueued"] == []
        assert body["deduped"][0]["reason"] == "already_in_queue"


def test_enqueue_requires_either_range_or_dates(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={"code": "005930", "force_retry": False})
        assert r.status_code == 400
```

- [ ] **Step 3: Run to verify fail**

Run: `uv run pytest tests/test_api_captures_queue.py -k "enqueue" -v 2>&1 | tail -20`
Expected: FAIL — route doesn't exist or 404.

- [ ] **Step 4: Implement the route inside `build_router`**

Edit `hoga/api/captures.py`. Add at module level (before `build_router`):

```python
def _now_kst() -> datetime:
    return datetime.now(tz=KST)


def _expand_to_trading_days(start: str, end: str) -> list[str]:
    """Return YYYYMMDD strings for each KRX trading day in [start, end].
    
    Delegates to hoga.api.calendar.trading_days_in_range which owns the
    pykrx-backed cache. Pre-flight verified there is NO existing
    hoga/inventory/trading_days.py — the helper lives in calendar.py
    because calendar.py is the dominant consumer (one call per month
    render); captures.py uses it only on enqueue.
    """
    from hoga.api.calendar import trading_days_in_range
    return trading_days_in_range(start, end)


def _make_item_id(code: str, date: str) -> str:
    stamp = _now_kst().strftime("%Y%m%dT%H%M%S%f")[:-3]   # ms precision
    return f"{stamp}-{code}-{date}"
```

Note: `hoga.api.calendar.trading_days_in_range` is implemented in Task 15
(calendar.py). For Task 7 to land first, define a temporary forward
declaration in `hoga/api/calendar.py` as a stub that just calls pykrx
inline (no caching) — Task 15 then upgrades it with the (year, month)
cache. This keeps Tasks 7-12 unblocked by Task 15's full implementation.

Stub (add to a new `hoga/api/calendar.py` placeholder file as part of
Task 7's commit; Task 15 expands the same file):

```python
# hoga/api/calendar.py — Task 7 placeholder, Task 15 expands.
from __future__ import annotations
from datetime import datetime


def trading_days_in_range(start: str, end: str) -> list[str]:
    """Returns YYYYMMDD trading days in [start, end] inclusive.
    
    Task 7 version: direct pykrx call, no cache (acceptable for enqueue
    which fires once per Start click). Task 15 adds the (year, month)
    cache used by the calendar endpoint.
    """
    from pykrx import stock
    start_d = datetime.strptime(start, "%Y%m%d").date()
    end_d = datetime.strptime(end, "%Y%m%d").date()
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    cal = stock.get_market_ohlcv(start, end, "005930")
    return [d.strftime("%Y%m%d") for d in cal.index]
```

Inside `build_router`, add the new route:

```python
@router.post("/items", status_code=201)
async def enqueue_items(req: EnqueueRequest) -> EnqueueResponse:
    """Enqueue items for one (code, range or dates) request.
    
    Q14 guard: any date in the request equal to today_kst with now.hour < 18
    → 400 today_too_early.
    Q15 Layer 1: per-(code, date) dedupe against _queue ∪ _active ∪
    _inflight_paths. Returns the dedupe list in the response.
    """
    # 1. Expand to a flat list of dates.
    if req.dates is not None:
        candidate_dates = list(req.dates)
    elif req.start_date and req.end_date:
        candidate_dates = _expand_to_trading_days(req.start_date, req.end_date)
    else:
        raise HTTPException(status_code=400, detail={
            "code": "missing_range",
            "message": "Provide either dates=[...] or start_date+end_date.",
        })

    # 2. Q14 today-too-early guard.
    now = _now_kst()
    too_early = [d for d in candidate_dates if is_today_too_early(d, now)]
    if too_early:
        raise HTTPException(status_code=400, detail={
            "code": "today_too_early",
            "message": f"Dates {too_early} are today (KST) and now.hour={now.hour} < 18.",
            "dates": too_early,
        })

    # 3. Q15 Layer 1 dedupe — against existing queue + active + inflight + within-request duplicates.
    enqueued: list[QueueItemState] = []
    deduped: list[dict[str, str]] = []
    enqueued_at_ms = int(time.time() * 1000)
    async with _lock:
        existing_pairs = set(_inflight_paths)
        existing_pairs |= {(s.code, s.date) for s in _queue}
        existing_pairs |= {(s.code, s.date) for s in _active.values()}
        seen_in_request: set[tuple[str, str]] = set()
        for date in candidate_dates:
            pair = (req.code, date)
            if pair in existing_pairs or pair in seen_in_request:
                reason = "already_running" if pair in {(s.code, s.date) for s in _active.values()} else "already_in_queue"
                deduped.append({"code": req.code, "date": date, "reason": reason})
                continue
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
        if enqueued and _wakeup is not None:
            _wakeup.set()

    # 4. Emit queued event.
    if enqueued:
        from hoga.api.models import CaptureQueuedEvent
        _publish_event(CaptureQueuedEvent(items=[s.to_wire() for s in enqueued]))

    return EnqueueResponse(
        enqueued=[s.to_wire() for s in enqueued],
        deduped=[EnqueueDedupedRow(**d) for d in deduped],   # type: ignore[arg-type]
    )
```

Also: production needs `_data_dir` + `_client_factory` to be module-globals so `_resolve_data_dir` / `_resolve_client_factory` can find them. Inside `build_router`:

```python
def build_router(*, data_dir: Path, client_factory: Callable[[], object]) -> APIRouter:
    global _data_dir, _client_factory  # noqa: PLW0603
    _data_dir = data_dir
    _client_factory = client_factory
    ...
```

And declare `_data_dir`, `_client_factory` near the top of the module with sentinel defaults so the names always exist:

```python
_data_dir: Path | None = None
_client_factory: Callable[[], object] | None = None
```

- [ ] **Step 5: Wire `start_workers` into app lifespan**

Edit `hoga/api/app.py` — inside `lifespan`, after the bus is initialized:
```python
import hoga.api.captures as captures
...
captures._workers = captures.start_workers()   # store on the module
try:
    yield
finally:
    await captures.stop_workers(captures._workers)
```

And in `captures.py`, add `_workers: list[asyncio.Task] = []` as a sentinel.

- [ ] **Step 6: Run enqueue tests**

Run: `uv run pytest tests/test_api_captures_queue.py -k "enqueue" -v 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Full pytest sweep**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add hoga/api/captures.py hoga/api/models.py hoga/api/app.py tests/test_api_captures_queue.py
git commit -m "feat(captures): POST /api/captures/items with Q14 guard + Q15 dedupe

Expands range to trading days. Rejects today-pre-18-KST with
today_too_early. Dedupes (code, date) against queue ∪ active ∪ inflight
(Layer 1). Emits CaptureQueuedEvent. App lifespan now starts the worker
pool.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `GET /api/captures/queue` — snapshot route

Wrapper around `get_queue_snapshot()`. Plus header summary helpers if the test demands them (kept minimal — frontend computes its own header).

**Files:**
- Modify: `hoga/api/captures.py`
- Test: `tests/test_api_captures_queue.py`

- [ ] **Step 1: Failing test**

```python
def test_get_queue_returns_snapshot(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        r = c.get("/api/captures/queue")
        assert r.status_code == 200
        body = r.json()
        # Item may have already finished if disk_state is NONE and the
        # collector path runs; but the snapshot envelope shape is stable.
        assert "active" in body and "queued" in body and "done" in body
        assert "paused" in body and "max_concurrent" in body
        assert isinstance(body["max_concurrent"], int)
```

- [ ] **Step 2: Verify fail**

Run: `uv run pytest tests/test_api_captures_queue.py::test_get_queue_returns_snapshot -v`
Expected: 404.

- [ ] **Step 3: Add the route**

Inside `build_router`:
```python
@router.get("/queue")
async def get_queue() -> QueueSnapshot:
    return get_queue_snapshot()
```

- [ ] **Step 4: Pass + sweep + commit**

Run: `uv run pytest tests/test_api_captures_queue.py::test_get_queue_returns_snapshot -v && uv run pytest -q 2>&1 | tail -3`

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): GET /api/captures/queue snapshot route

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Cancel routes — `POST /items/{id}/cancel` + `POST /cancel-all`

Per-item: queued → drop from `_queue`, mark cancelled, push to `_done`. Active → call `cancel_token.cancel()`, let the worker observe and finalize. Terminal → 409.
Cancel-all: drain queue + cancel every active. (Q20 paused-state semantics ride in Task 10 because they touch pause state.)

**Files:**
- Modify: `hoga/api/captures.py`
- Test: `tests/test_api_captures_queue.py`

- [ ] **Step 1: Failing tests**

```python
def test_cancel_queued_item_removes_and_marks_cancelled(monkeypatch, tmp_path):
    """Item not yet active → POST /cancel drops it from queue, marks cancelled."""
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    # Patch _run_capture_and_parse to block so items stay queued.
    sem = asyncio.Event()
    async def _block(state, resume):
        await sem.wait()
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _block)

    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260518", "20260519"],
            "force_retry": False,
        })
        items = r.json()["enqueued"]
        # The 2nd item is in queue (n=3 workers but blocked on sem).
        target = items[1]
        cr = c.post(f"/api/captures/items/{target['item_id']}/cancel")
        assert cr.status_code == 202
        # Snapshot should show it in done with cancelled phase.
        snap = c.get("/api/captures/queue").json()
        cancelled = [it for it in snap["done"] if it["item_id"] == target["item_id"]]
        assert cancelled and cancelled[0]["phase"] == "cancelled"
        sem.set()   # let the rest drain so the test teardown is clean


def test_cancel_terminal_item_returns_409(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.COMPLETE)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260518"], "force_retry": False,
        })
        item_id = r.json()["enqueued"][0]["item_id"]
        # Wait for it to terminate.
        for _ in range(20):
            snap = c.get("/api/captures/queue").json()
            if snap["active"] == [] and any(it["item_id"] == item_id for it in snap["done"]):
                break
            time.sleep(0.05)
        cr = c.post(f"/api/captures/items/{item_id}/cancel")
        assert cr.status_code == 409


def test_cancel_all_drains_queue(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    sem = asyncio.Event()
    async def _block(state, resume):
        await sem.wait()
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _block)

    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260518", "20260519", "20260520"],
            "force_retry": False,
        })
        cr = c.post("/api/captures/cancel-all")
        assert cr.status_code == 202
        sem.set()
        # All terminal.
        for _ in range(30):
            snap = c.get("/api/captures/queue").json()
            if not snap["queued"] and not snap["active"]:
                break
            time.sleep(0.05)
        snap = c.get("/api/captures/queue").json()
        assert all(it["phase"] in ("done", "cancelled") for it in snap["done"])
```

- [ ] **Step 2: Verify fail**

Run: `uv run pytest tests/test_api_captures_queue.py -k "cancel" -v 2>&1 | tail -15`

- [ ] **Step 3: Add routes**

Inside `build_router`:
```python
@router.post("/items/{item_id}/cancel", status_code=202)
async def cancel_item(item_id: str) -> dict:
    async with _lock:
        # Queued case
        for i, s in enumerate(_queue):
            if s.item_id == item_id:
                del _queue[i]
                s.phase = "cancelled"
                _done.append(s)
                if _wakeup is not None:
                    _wakeup.set()
                _publish_event(CaptureFinishedEvent(**s.event_header(), result=None, error=None, skip_reason=None))
                return {"status": "cancelled", "item_id": item_id}
        # Active case
        state = _active.get(item_id)
        if state is not None and state.cancel_token is not None:
            state.cancel_token.cancel()
            return {"status": "cancel_signal_delivered", "item_id": item_id}
        # Terminal case
        for s in _done:
            if s.item_id == item_id:
                raise HTTPException(status_code=409, detail={
                    "code": "terminal", "phase": s.phase,
                })
    raise HTTPException(status_code=404, detail={"code": "not_found"})


@router.post("/cancel-all", status_code=202)
async def cancel_all() -> dict:
    async with _lock:
        # Drain queue.
        drained = []
        while _queue:
            s = _queue.popleft()
            s.phase = "cancelled"
            _done.append(s)
            drained.append(s)
        # Signal all active.
        for s in list(_active.values()):
            if s.cancel_token is not None:
                s.cancel_token.cancel()
        if _wakeup is not None:
            _wakeup.set()
    for s in drained:
        _publish_event(CaptureFinishedEvent(**s.event_header(), result=None, error=None, skip_reason=None))
    return {"status": "cancel_all_delivered", "drained_count": len(drained)}
```

Also: `_run_item` (and `_run_capture_and_parse`) need to recognize `CaptureCancelled` from the collector and translate to `state.phase = "cancelled"`. Update `_worker_loop`'s exception block:
```python
        except CaptureCancelled:
            state.phase = "cancelled"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            ...
```
(Import `CaptureCancelled` from `hoga.collector.orchestrator` — already imported.)

- [ ] **Step 4: Pass + sweep + commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): per-item cancel + cancel-all routes

queued → drop; active → cancel_token; terminal → 409. cancel-all drains
queue and signals all active.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Cookie expiry pool pause + resume + Q20 cancel-all-in-paused semantics

When a worker raises `CookieExpiredError`: set `_queue_paused = True`, mark every other active with `pause_origin = True`, cancel them, emit `CaptureQueuePausedEvent`. `POST /queue/resume`: re-queue all `pause_origin` items from `_done` to the front, clear flag, emit `CaptureQueueResumedEvent`. Q20: `POST /cancel-all` while paused additionally clears `_queue_paused = False`, downgrades pause_origin cancels to plain cancels (so Resume doesn't re-enqueue them), emits `CaptureQueueResumedEvent(reason="cancel_all")`.

**Files:**
- Modify: `hoga/api/captures.py`
- Test: `tests/test_api_captures_queue.py`

- [ ] **Step 1: Failing tests**

```python
@pytest.mark.asyncio
async def test_cookie_expired_pauses_pool(monkeypatch, tmp_path):
    from hoga.collector.client import CookieExpiredError
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    counter = {"calls": 0}
    sem = asyncio.Event()

    async def _maybe_fail(state, resume):
        counter["calls"] += 1
        if counter["calls"] == 1:
            raise CookieExpiredError("expired")
        await sem.wait()
        state.phase = "done"

    monkeypatch.setattr(captures, "_run_capture_and_parse", _maybe_fail)

    for i in range(3):
        captures._queue.append(_make_item(f"x-{i}", date=f"2026052{i}"))
    workers = captures.start_workers(n=3)
    # Wait until pause flips on.
    for _ in range(50):
        if captures._queue_paused:
            break
        await asyncio.sleep(0.02)
    assert captures._queue_paused is True
    # Other active items are cancelled with pause_origin=True.
    cancelled_pause_origin = [s for s in captures._done if s.pause_origin and s.phase == "cancelled"]
    assert len(cancelled_pause_origin) >= 1
    sem.set()
    await captures.stop_workers(workers)


@pytest.mark.asyncio
async def test_resume_reenqueues_pause_origin(monkeypatch, tmp_path):
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    # Manually craft the pause aftermath.
    s1 = _make_item("x-1", date="20260518")
    s1.phase, s1.pause_origin = "cancelled", True
    s2 = _make_item("x-2", date="20260519")
    s2.phase, s2.pause_origin = "cancelled", True
    captures._done.extend([s1, s2])
    captures._queue_paused = True

    await captures.resume_queue()

    assert captures._queue_paused is False
    assert [s.item_id for s in captures._queue] == ["x-1", "x-2"]
    assert all(s.phase == "queued" and not s.pause_origin for s in captures._queue)
    assert s1 not in captures._done and s2 not in captures._done


@pytest.mark.asyncio
async def test_cancel_all_in_paused_resets_everything(monkeypatch, tmp_path):
    """Q20: Cancel All in paused state drains queue, downgrades pause_origin
    cancelled to plain cancelled, clears _queue_paused."""
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    s1 = _make_item("x-1", date="20260518")
    s1.phase, s1.pause_origin = "cancelled", True
    captures._done.append(s1)
    captures._queue.append(_make_item("x-2", date="20260519"))   # still queued
    captures._queue_paused = True

    # Build the test app to hit the HTTP route.
    app = _build_test_app(monkeypatch, tmp_path)
    # The app's lifespan will reset state, so do this differently: directly
    # call the cancel_all_when_paused helper that the route delegates to.
    await captures.cancel_all()

    assert captures._queue_paused is False
    assert s1.pause_origin is False
    assert all(s.phase == "cancelled" for s in captures._done)
    assert captures._queue == deque()  # all drained
```

Add `from collections import deque` to test imports if not already there.

- [ ] **Step 2: Verify fail**

Run: `uv run pytest tests/test_api_captures_queue.py -k "cookie or resume or paused" -v 2>&1 | tail -15`

- [ ] **Step 3: Implement cookie pause + resume + cancel-all-in-paused**

Add to `hoga/api/captures.py`:
```python
from hoga.api.models import CaptureQueuePausedEvent, CaptureQueueResumedEvent


async def _handle_cookie_expired(state: QueueItemState) -> None:
    """Triggered when a worker raises CookieExpiredError. Pauses the pool
    atomically and cancels all OTHER active items (the current item already
    failed)."""
    async with _lock:
        global _queue_paused  # noqa: PLW0603
        if _queue_paused:
            return  # idempotent — another worker won the race
        _queue_paused = True
        for other in _active.values():
            if other.item_id == state.item_id:
                continue
            other.pause_origin = True
            if other.cancel_token is not None:
                other.cancel_token.cancel()
    _publish_event(CaptureQueuePausedEvent(
        reason="cookie_expired",
        message="Cookie expired — pool paused. Refresh .cookie and POST /api/captures/queue/resume.",
    ))


async def resume_queue() -> None:
    """Re-queue pause_origin items from _done to the front; clear pause flag."""
    global _queue_paused  # noqa: PLW0603
    async with _lock:
        _queue_paused = False
        re = [s for s in _done if s.pause_origin and s.phase == "cancelled"]
        for s in reversed(re):
            s.phase = "queued"
            s.pause_origin = False
            _queue.appendleft(s)
        _done[:] = [s for s in _done if s not in re]
        if _wakeup is not None and _queue:
            _wakeup.set()
    _publish_event(CaptureQueueResumedEvent(reason="user_resume"))


async def cancel_all() -> dict:
    """Drain queue + cancel all active. Q20: when called in paused state,
    additionally downgrade pause_origin cancelled items to plain cancelled
    (so a later Resume doesn't re-enqueue them) and clear _queue_paused."""
    global _queue_paused  # noqa: PLW0603
    was_paused = False
    drained = []
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
        if _wakeup is not None:
            _wakeup.set()
    for s in drained:
        _publish_event(CaptureFinishedEvent(**s.event_header(), result=None, error=None, skip_reason=None))
    if was_paused:
        _publish_event(CaptureQueueResumedEvent(reason="cancel_all"))
    return {"status": "cancel_all_delivered", "drained_count": len(drained), "was_paused": was_paused}
```

Adjust the worker loop's exception handling — replace the generic `except Exception` block:
```python
        except CookieExpiredError as exc:
            state.error = CaptureError(code="cookie_expired", message=str(exc),
                                        at_page=state.pages_done or None)
            state.phase = "failed"
            await _handle_cookie_expired(state)
        except CaptureCancelled:
            state.phase = "cancelled"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            state.error = CaptureError(
                code=_exception_to_error_code(exc) or "internal_error",
                message=str(exc), at_page=state.pages_done or None,
            )
            state.phase = "failed"
```

Replace the existing `cancel_all` route to delegate:
```python
@router.post("/cancel-all", status_code=202)
async def cancel_all_route() -> dict:
    return await cancel_all()


@router.post("/queue/resume", status_code=200)
async def resume_route() -> dict:
    await resume_queue()
    return {"status": "resumed"}
```

- [ ] **Step 4: Pass + sweep + commit**

Run: `uv run pytest tests/test_api_captures_queue.py -k "cookie or resume or paused" -v && uv run pytest -q 2>&1 | tail -3`

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): cookie expiry pool pause + resume + Q20 cancel-all-in-paused

First CookieExpiredError pauses the pool, cancels other actives with
pause_origin=True, emits CaptureQueuePausedEvent. POST /queue/resume
re-enqueues pause_origin items to the front. POST /cancel-all in paused
state downgrades pause_origin cancellations and clears the flag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 429 per-item exponential backoff (5/10/30s, 3 retries) + cancel-aware sleep

Wrap the collector call in a retry loop. Rate-limit errors only retry; other errors propagate. **Cancellation during the backoff sleep aborts immediately** so a user-cancelled item doesn't wait 30s before terminating.

**Files:**
- Modify: `hoga/collector/client.py` — add `status_code: int | None = None` attr to `HogaplayHTTPError` (pre-flight grep confirmed it currently carries no status field; the wrapper needs to dispatch on 429 specifically). Update the raise sites at lines ~94 / 98 / 102 to populate `status_code=r.status_code`.
- Modify: `hoga/api/captures.py` (rename `_run_capture_and_parse` body to `_run_capture_inner`; wrap with the backoff in `_run_capture_and_parse`)
- Test: `tests/test_api_captures_queue.py`

The rename strategy is INTENTIONAL: the public symbol `_run_capture_and_parse` stays stable (Tasks 5/6/9/10's tests keep monkeypatching it). Backoff lives inside as a wrapper, and the inner unwrapped path gets a new name `_run_capture_inner`. Earlier tests don't break.

- [ ] **Step 1: Verify `HogaplayHTTPError` currently has no status_code field**

Run: `grep -n "class HogaplayHTTPError\|status_code" hoga/collector/client.py`
Expected: `HogaplayHTTPError` is `class HogaplayHTTPError(RuntimeError)` with no attributes — status is only embedded in the message string. We will add `status_code` as a typed field in Step 4 below.

- [ ] **Step 2: Failing tests (includes cancel-during-backoff)**

```python
@pytest.mark.asyncio
async def test_429_backoff_then_success(monkeypatch, tmp_path):
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    monkeypatch.setattr("hoga.api.captures._BACKOFF_DELAYS", (0.0, 0.0, 0.0), raising=False)

    from hoga.collector.client import HogaplayHTTPError
    attempts = {"n": 0}

    async def _maybe_429(state, resume):
        attempts["n"] += 1
        if attempts["n"] <= 3:
            raise HogaplayHTTPError("429 rate limited", status_code=429)
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_inner", _maybe_429)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)
    assert captures._done[-1].phase == "done"
    assert attempts["n"] == 4


@pytest.mark.asyncio
async def test_429_backoff_exhausted_marks_failed(monkeypatch, tmp_path):
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    monkeypatch.setattr("hoga.api.captures._BACKOFF_DELAYS", (0.0, 0.0, 0.0), raising=False)

    from hoga.collector.client import HogaplayHTTPError

    async def _always_429(state, resume):
        raise HogaplayHTTPError("429", status_code=429)
    monkeypatch.setattr(captures, "_run_capture_inner", _always_429)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)
    assert captures._done[-1].phase == "failed"


@pytest.mark.asyncio
async def test_cancel_during_429_backoff_aborts_immediately(monkeypatch, tmp_path):
    """User cancels mid-sleep → item terminates as cancelled within ~50ms,
    NOT after waiting out the 30s backoff."""
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    # Long-enough delay that the test would hang if cancel doesn't interrupt.
    monkeypatch.setattr("hoga.api.captures._BACKOFF_DELAYS", (5.0,), raising=False)

    from hoga.collector.client import HogaplayHTTPError
    from hoga.collector.orchestrator import CaptureCancelled

    async def _always_429(state, resume):
        raise HogaplayHTTPError("429", status_code=429)
    monkeypatch.setattr(captures, "_run_capture_inner", _always_429)

    item = _make_item("x-1")
    captures._queue.append(item)
    workers = captures.start_workers(n=1)
    await asyncio.sleep(0.1)   # let the worker enter the backoff sleep
    # Find the active item and cancel it.
    active = next(iter(captures._active.values()), None) or item
    if active.cancel_token is not None:
        active.cancel_token.cancel()
    await asyncio.wait_for(captures.wait_drained(), timeout=1.0)
    await captures.stop_workers(workers)
    assert captures._done[-1].phase == "cancelled"
```

- [ ] **Step 3: Add `status_code` to `HogaplayHTTPError`**

Edit `hoga/collector/client.py`. Replace the class definition at line 33:
```python
class HogaplayHTTPError(RuntimeError):
    """HTTP error from hogaplay. `status_code` is None for low-level errors
    (timeout, connection reset) that never received a response."""
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
```

Update the three raise sites in the same file (around lines 94, 98, 102) to pass `status_code=r.status_code` as a kwarg. Each site already has `r.status_code` in scope.

Run baseline test sweep after this edit to confirm nothing depended on the old signature:
`uv run pytest -q 2>&1 | tail -3`

- [ ] **Step 4: Implement the backoff wrapper with cancel-aware sleep**

Edit `hoga/api/captures.py` — rename Task 5's `_run_capture_and_parse` body to `_run_capture_inner` (just rename the def line; body unchanged) + introduce a new `_run_capture_and_parse` wrapper:

```python
_BACKOFF_DELAYS: tuple[float, ...] = (5.0, 10.0, 30.0)


async def _run_capture_inner(state: QueueItemState, resume: bool) -> None:
    """The unwrapped collector+parse path. Task 5's body, renamed.
    Backoff lives in the wrapper below."""
    # ... (body unchanged from Task 5) ...


async def _cancel_aware_sleep(state: QueueItemState, delay: float) -> bool:
    """Sleep `delay` seconds but return early if state.cancel_token signals.
    Returns True if cancelled, False if slept to completion.
    
    Uses the underlying asyncio.Event in CancelToken (verified: orchestrator.py
    line 61 — CancelToken._event is asyncio.Event, .cancelled is a property
    that reads is_set()). asyncio.wait_for on event.wait() blocks at the
    OS level, so cancel signals wake immediately rather than polling."""
    if state.cancel_token is None:
        await asyncio.sleep(delay)
        return False
    if state.cancel_token.cancelled:
        return True
    try:
        await asyncio.wait_for(state.cancel_token._event.wait(), timeout=delay)
        return True   # event fired before timeout
    except asyncio.TimeoutError:
        return False  # slept to completion


async def _run_capture_and_parse(state: QueueItemState, resume: bool) -> None:
    """Wrap _run_capture_inner with 429 exponential backoff. 3 retries
    (5/10/30s) then propagate. Cancellation during the sleep aborts via
    CaptureCancelled — the worker exception handler catches it and marks
    the item cancelled."""
    from hoga.collector.client import HogaplayHTTPError
    from hoga.collector.orchestrator import CaptureCancelled
    last_exc: BaseException | None = None
    for attempt, delay in enumerate([*_BACKOFF_DELAYS, None]):
        try:
            await _run_capture_inner(state, resume=resume)
            return
        except HogaplayHTTPError as exc:
            if exc.status_code != 429 or delay is None:
                raise
            last_exc = exc
            if await _cancel_aware_sleep(state, delay):
                raise CaptureCancelled() from exc
    if last_exc is not None:
        raise last_exc
```

Note on the `CancelToken.is_cancelled()` method name: pre-flight verify with `grep -n "def is_cancelled\|cancelled\|_cancelled" hoga/collector/orchestrator.py` and use whichever predicate it exposes (if it's `.cancelled` property, swap the call). The CancelToken type is already in use by Task 5's `_run_capture_inner`, so the API is established.

- [ ] **Step 4: Pass + sweep + commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): per-item 429 exponential backoff (5/10/30s)

3 retries with HogaplayHTTPError(status=429); other errors propagate.
Test-friendly via _BACKOFF_DELAYS monkeypatch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `DELETE /api/captures/done` — dismiss terminal items

Simple route. Active items untouched.

**Files:**
- Modify: `hoga/api/captures.py`
- Test: `tests/test_api_captures_queue.py`

- [ ] **Step 1: Failing test**

```python
def test_dismiss_done_clears_terminals_only(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
                        lambda *_a, **_k: DiskState.COMPLETE)
    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260518", "20260519"], "force_retry": False,
        })
        # Wait until done.
        for _ in range(20):
            snap = c.get("/api/captures/queue").json()
            if len(snap["done"]) == 2 and not snap["active"]:
                break
            time.sleep(0.05)
        r = c.delete("/api/captures/done")
        assert r.status_code == 204
        snap = c.get("/api/captures/queue").json()
        assert snap["done"] == []
```

- [ ] **Step 2: Verify fail; implement; pass**

Inside `build_router`:
```python
@router.delete("/done", status_code=204)
async def dismiss_done() -> None:
    async with _lock:
        _done.clear()
```

- [ ] **Step 3: Sweep + commit**

```bash
git add hoga/api/captures.py tests/test_api_captures_queue.py
git commit -m "feat(captures): DELETE /api/captures/done clears terminals

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Remove old `_latest` singleton + endpoints + their tests

Hard cut per spec §3.3 "no deprecation period". Deletes `POST /api/captures`, `GET /api/captures/latest`, `POST /api/captures/latest/cancel`, `DELETE /api/captures/latest`, `StartCaptureRequest`, `CaptureJobState`, `_run_capture_job`, `_latest` global, `cancel_latest_on_shutdown`. Deletes `tests/test_api_captures.py` and `tests/test_api_sse_capture.py` (their fixtures targeted the singleton path). The new `tests/test_api_captures_queue.py` already covers the queue surface.

**Files:**
- Modify: `hoga/api/captures.py` (substantial deletion)
- Modify: `hoga/api/app.py` (rename `cancel_latest_on_shutdown` → `cancel_all_on_shutdown`)
- Modify: `hoga/api/models.py` (remove `CaptureJob` alias; `QueueItem` is canonical now)
- Delete: `tests/test_api_captures.py`, `tests/test_api_sse_capture.py`
- Possibly modify: `tests/test_api_inventory_sse.py` and `tests/test_api_sse_subscribe.py` if they reference removed symbols.

- [ ] **Step 1: Identify all references to the removed symbols**

Run:
```bash
grep -rn "CaptureJob\|StartCaptureRequest\|CaptureJobState\|cancel_latest_on_shutdown\|_run_capture_job\|get_latest\|/api/captures\"\|/latest/cancel\|/captures/latest" hoga/ tests/ 2>/dev/null
```
Expected: hits in `hoga/api/captures.py` (the definitions), `hoga/api/app.py` (lifespan hook), and (after this task) zero hits in tests.

- [ ] **Step 2: Delete the old test files**

Run: `rm tests/test_api_captures.py tests/test_api_sse_capture.py`

- [ ] **Step 3: Remove from `hoga/api/captures.py`**

Edit `hoga/api/captures.py`:
- Delete the `CaptureJobState` dataclass (lines ~72–128).
- Delete the `_latest: CaptureJobState | None = None` line (~131).
- Delete `def get_latest()` (~134–135) and `def cancel_latest_on_shutdown()` (~144–150).
- Delete `_run_capture_job` (~236–316).
- Delete `class StartCaptureRequest` (~322–327) and `def _make_job_id` (~330–332).
- Inside `build_router`, delete the `@router.post("")` (`start_capture`), `@router.get("/latest")`, `@router.post("/latest/cancel")`, `@router.delete("/latest")` handlers.
- Rename `reset_state_for_tests` to drop the `_latest` reset.

Add a new shutdown hook to replace `cancel_latest_on_shutdown`:
```python
def cancel_all_on_shutdown() -> None:
    """Best-effort cancel called from app lifespan teardown."""
    for s in _active.values():
        if s.cancel_token is not None:
            s.cancel_token.cancel()
```

- [ ] **Step 4: Update `hoga/api/app.py`**

Edit `hoga/api/app.py` — replace `cancel_latest_on_shutdown()` reference with `cancel_all_on_shutdown()`.

- [ ] **Step 5: Remove the transitional alias in models.py**

Edit `hoga/api/models.py` — remove the `CaptureJob = QueueItem` alias and the now-dead `class CaptureJob(BaseModel)` if it's still present.

- [ ] **Step 6: Fix any other files that imported the deleted symbols**

Run:
```bash
grep -rn "CaptureJob\b\|StartCaptureRequest\|CaptureJobState\|_run_capture_job\|cancel_latest_on_shutdown" hoga/ tests/ 2>/dev/null
```
Expected: zero matches. Fix any import that still references them — most likely candidates are `hoga/api/app.py` and `hoga/api/__init__.py` (if it re-exports). Update to import from the new surface.

- [ ] **Step 7: Run full test sweep**

Run: `uv run pytest -q 2>&1 | tail -5`
Expected: green (test count drops by however many were in the two deleted files).

- [ ] **Step 8: Commit**

```bash
git add hoga/api/captures.py hoga/api/app.py hoga/api/models.py
git add -u tests/    # records the deletions
git commit -m "$(cat <<'EOF'
feat!(captures): remove legacy _latest singleton + single-capture routes

Hard cut per spec §3.3 — no deprecation shim. Deletes POST /api/captures,
GET /api/captures/latest, POST /api/captures/latest/cancel, DELETE
/api/captures/latest, plus CaptureJobState, StartCaptureRequest,
_run_capture_job, the _latest global, and CaptureJob alias.

Old test files (test_api_captures.py, test_api_sse_capture.py) deleted —
test_api_captures_queue.py covers the equivalent surface for the new
queue-shaped API.

BREAKING CHANGE: frontend single-capture page is dead until Plan C lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `hoga/api/symbols.py` — pykrx master cache (3-tier policy) + `captured_breakdown`

The biggest new sibling. Three tiers: (1) lifespan prefetch fire-and-forget; (2) GET-time `asyncio.Lock` + in-flight Future dedupe; (3) stale fallback. The captured count per symbol comes from scanning `data/parquet/*/{code}/meta.json` and bucketing through `disk_state.classify_from_meta`.

**Files:**
- New: `hoga/api/symbols.py`
- Modify: `hoga/api/app.py` (lifespan schedules `symbols.ensure_cache_warm()` as a fire-and-forget task; wire the router)
- Modify: `hoga/api/routes.py` (mount symbols router)
- Test: `tests/test_api_symbols.py` [new]

- [ ] **Step 1: Failing tests**

Create `tests/test_api_symbols.py`:
```python
"""hoga/api/symbols.py — pykrx cache + 3-tier policy + breakdown."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import pytest

from hoga.api import symbols


@pytest.fixture(autouse=True)
def _reset():
    symbols.reset_state_for_tests()
    yield
    symbols.reset_state_for_tests()


def _stub_pykrx(monkeypatch, kospi=None, kosdaq=None, *, raise_exc=None):
    """Patch pykrx.stock.get_market_ticker_list and get_market_ticker_name."""
    kospi = kospi or [("005930", "삼성전자")]
    kosdaq = kosdaq or [("035720", "카카오")]
    if raise_exc is not None:
        monkeypatch.setattr(symbols, "_fetch_from_pykrx",
                            lambda: (_ for _ in ()).throw(raise_exc))
        return
    async def _fetch():
        return [
            symbols.SymbolHit(code=c, name=n, market="KOSPI",
                              captured_count=0, captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})
            for c, n in kospi
        ] + [
            symbols.SymbolHit(code=c, name=n, market="KOSDAQ",
                              captured_count=0, captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})
            for c, n in kosdaq
        ]
    monkeypatch.setattr(symbols, "_fetch_from_pykrx", _fetch)


@pytest.mark.asyncio
async def test_initial_status_is_loading_then_fresh(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch)
    resp = await symbols.get_all(data_dir=tmp_path)
    assert resp.status == "fresh"
    assert len(resp.symbols) == 2
    assert resp.fetched_at_ms is not None


@pytest.mark.asyncio
async def test_concurrent_gets_dedupe_to_one_fetch(monkeypatch, tmp_path):
    """N concurrent GETs trigger exactly one underlying fetch."""
    counter = {"n": 0}
    sem = asyncio.Event()
    async def _slow_fetch():
        counter["n"] += 1
        await sem.wait()
        return []
    monkeypatch.setattr(symbols, "_fetch_from_pykrx", _slow_fetch)

    t1 = asyncio.create_task(symbols.get_all(data_dir=tmp_path))
    t2 = asyncio.create_task(symbols.get_all(data_dir=tmp_path))
    t3 = asyncio.create_task(symbols.get_all(data_dir=tmp_path))
    await asyncio.sleep(0.05)
    assert counter["n"] == 1
    sem.set()
    await asyncio.gather(t1, t2, t3)
    assert counter["n"] == 1


@pytest.mark.asyncio
async def test_pykrx_failure_returns_unavailable_when_no_cache(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, raise_exc=RuntimeError("krx down"))
    resp = await symbols.get_all(data_dir=tmp_path)
    assert resp.status == "unavailable"
    assert resp.symbols == []


@pytest.mark.asyncio
async def test_pykrx_failure_returns_stale_with_prior_cache(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch)
    first = await symbols.get_all(data_dir=tmp_path)
    assert first.status == "fresh"
    # Now simulate a fetch failure on refresh.
    monkeypatch.setattr(symbols, "_fetch_from_pykrx",
                        lambda: (_ for _ in ()).throw(RuntimeError("krx down")))
    symbols.invalidate_cache_for_tests()    # mark stale
    second = await symbols.get_all(data_dir=tmp_path)
    assert second.status == "stale"
    assert len(second.symbols) == 2


def test_search_filters_by_name(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, kospi=[("005930", "삼성전자"), ("000660", "SK하이닉스")])
    asyncio.run(symbols.get_all(data_dir=tmp_path))
    hits = symbols.search("삼성", limit=5)
    assert [h.code for h in hits] == ["005930"]


def test_search_filters_by_code_prefix(monkeypatch, tmp_path):
    _stub_pykrx(monkeypatch, kospi=[("005930", "삼성전자"), ("005935", "삼성전자우")])
    asyncio.run(symbols.get_all(data_dir=tmp_path))
    hits = symbols.search("00593", limit=5)
    assert sorted(h.code for h in hits) == ["005930", "005935"]


def test_captured_breakdown_classifies_states(monkeypatch, tmp_path):
    """Setup a parquet dir per code with meta files representing each state."""
    (tmp_path / "parquet" / "20260518" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260518" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False}))   # complete
    (tmp_path / "parquet" / "20260519" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260519" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": True}))    # source_partial
    (tmp_path / "raw" / "20260520" / "005930").mkdir(parents=True)
    (tmp_path / "raw" / "20260520" / "005930" / "first_0001.tsv").write_text("")   # client_incomplete

    breakdown = symbols._count_captured_states(tmp_path, "005930")
    assert breakdown == {"complete": 1, "source_partial": 1, "client_incomplete": 1}
```

- [ ] **Step 2: Verify fail**

Run: `uv run pytest tests/test_api_symbols.py -v 2>&1 | tail -15`
Expected: FAIL — `hoga.api.symbols` doesn't exist.

- [ ] **Step 3: Implement `hoga/api/symbols.py`**

Create `hoga/api/symbols.py`:
```python
"""pykrx symbol master cache + search + captured breakdown via disk_state.

Three-tier policy (spec §11 Q19):
- Tier 1: lifespan schedules `ensure_cache_warm()` fire-and-forget at startup.
- Tier 2: GET-time `asyncio.Lock` + in-flight Future dedupe — N concurrent
  GETs trigger exactly one pykrx call.
- Tier 3: pykrx failure returns the last-known cache with status="stale"
  (or status="unavailable" if no cache ever existed).
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Awaitable

from fastapi import APIRouter, Depends, HTTPException, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.models import SymbolHit, SymbolsAllResponse

# Module-level state (per ADR-0006 single-module pattern, scoped to symbols.py).
_cache: list[SymbolHit] = []
_fetched_at_ms: int | None = None
_status: str = "loading"          # one of: loading / fresh / stale / unavailable
_lock = asyncio.Lock()
_inflight: asyncio.Future | None = None
_CACHE_TTL_MS = 24 * 60 * 60 * 1000   # 24h


def reset_state_for_tests() -> None:
    global _cache, _fetched_at_ms, _status, _inflight   # noqa: PLW0603
    _cache, _fetched_at_ms, _status, _inflight = [], None, "loading", None


def invalidate_cache_for_tests() -> None:
    """Mark current cache stale (for stale-fallback testing)."""
    global _fetched_at_ms   # noqa: PLW0603
    if _fetched_at_ms is not None:
        _fetched_at_ms -= _CACHE_TTL_MS * 2


async def _fetch_from_pykrx() -> list[SymbolHit]:
    """Override in tests. Production implementation calls pykrx directly.
    
    CRITICAL: uses pykrx.stock.get_market_cap(date, market=...) which returns
    a DataFrame containing both ticker codes (index) AND names (`종목명` column)
    in ONE call per market. The naive N=6000 sequential get_market_ticker_name
    approach would take ~10 minutes at boot — this version takes ~2 seconds.
    """
    from pykrx import stock
    loop = asyncio.get_running_loop()
    today = time.strftime("%Y%m%d")

    def _scrape() -> list[tuple[str, str, str]]:
        rows: list[tuple[str, str, str]] = []
        for market in ("KOSPI", "KOSDAQ"):
            df = stock.get_market_cap(today, market=market)   # ONE call returns code+name
            for code in df.index:
                name = str(df.loc[code, "종목명"])
                rows.append((str(code), name, market))
        return rows

    rows = await loop.run_in_executor(None, _scrape)
    return [SymbolHit(code=c, name=n, market=m,  # type: ignore[arg-type]
                      captured_count=0,
                      captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0})
            for c, n, m in rows]


def _count_captured_states(data_dir: Path, code: str) -> dict[str, int]:
    """Walk data/parquet/*/{code} + data/raw/*/{code} to bucket each Stock-Date
    by disk state. Used to populate SymbolHit.captured_count + breakdown."""
    counts = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    parquet_root = data_dir / "parquet"
    if parquet_root.exists():
        for date_dir in parquet_root.iterdir():
            target = date_dir / code
            if not target.exists():
                continue
            st = check_disk_state(data_dir, code, date_dir.name)
            if st == DiskState.COMPLETE:
                counts["complete"] += 1
            elif st == DiskState.SOURCE_PARTIAL:
                counts["source_partial"] += 1
            elif st == DiskState.CLIENT_INCOMPLETE:
                counts["client_incomplete"] += 1
    # Also walk raw-only dates (no parquet/{date}/{code} but raw/{date}/{code} exists).
    raw_root = data_dir / "raw"
    if raw_root.exists():
        for date_dir in raw_root.iterdir():
            target = date_dir / code
            if not target.exists():
                continue
            # Skip if parquet already counted this date.
            if (parquet_root / date_dir.name / code).exists():
                continue
            st = check_disk_state(data_dir, code, date_dir.name)
            if st == DiskState.CLIENT_INCOMPLETE:
                counts["client_incomplete"] += 1
    return counts


def _is_fresh() -> bool:
    if _fetched_at_ms is None:
        return False
    return (int(time.time() * 1000) - _fetched_at_ms) < _CACHE_TTL_MS


def _build_all_captured_breakdowns(data_dir: Path) -> dict[str, dict[str, int]]:
    """Walk data/parquet/* and data/raw/* ONCE, building {code: breakdown}.
    
    The naive approach (calling _count_captured_states per symbol from
    _do_fetch_and_populate) is O(symbols × parquet_dates) — 6000 × 100 =
    600,000 stat calls per cache rebuild. This single-pass walk is
    O(total_stock_date_dirs) — orders of magnitude fewer disk ops when the
    typical user has <200 captured Stock-Dates across all symbols.
    """
    breakdowns: dict[str, dict[str, int]] = {}
    parquet_root = data_dir / "parquet"
    if parquet_root.exists():
        for date_dir in parquet_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir():
                    continue
                st = check_disk_state(data_dir, code_dir.name, date_dir.name)
                bucket = breakdowns.setdefault(
                    code_dir.name,
                    {"complete": 0, "source_partial": 0, "client_incomplete": 0},
                )
                if st == DiskState.COMPLETE:
                    bucket["complete"] += 1
                elif st == DiskState.SOURCE_PARTIAL:
                    bucket["source_partial"] += 1
                elif st == DiskState.CLIENT_INCOMPLETE:
                    bucket["client_incomplete"] += 1
    raw_root = data_dir / "raw"
    if raw_root.exists():
        for date_dir in raw_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir():
                    continue
                # Skip if parquet covered this (code, date) — already counted.
                if (parquet_root / date_dir.name / code_dir.name).exists():
                    continue
                st = check_disk_state(data_dir, code_dir.name, date_dir.name)
                if st == DiskState.CLIENT_INCOMPLETE:
                    bucket = breakdowns.setdefault(
                        code_dir.name,
                        {"complete": 0, "source_partial": 0, "client_incomplete": 0},
                    )
                    bucket["client_incomplete"] += 1
    return breakdowns


async def _do_fetch_and_populate(data_dir: Path) -> None:
    """Inner helper — runs under in-flight Future protection."""
    global _cache, _fetched_at_ms, _status   # noqa: PLW0603
    try:
        hits = await _fetch_from_pykrx()
    except Exception:  # noqa: BLE001 — pykrx failure path
        # Don't clobber the cache; downgrade status.
        _status = "stale" if _cache else "unavailable"
        return
    # Single-pass walk → {code: breakdown}; assign per symbol.
    # Walks the filesystem in the executor to keep the loop responsive.
    loop = asyncio.get_running_loop()
    breakdowns = await loop.run_in_executor(None, _build_all_captured_breakdowns, data_dir)
    empty = {"complete": 0, "source_partial": 0, "client_incomplete": 0}
    for h in hits:
        breakdown = breakdowns.get(h.code, empty)
        h.captured_count = breakdown["complete"]
        h.captured_breakdown = breakdown
    _cache = hits
    _fetched_at_ms = int(time.time() * 1000)
    _status = "fresh"


async def ensure_cache_warm(data_dir: Path) -> None:
    """Tier 1 entry point — called from lifespan fire-and-forget."""
    if _is_fresh():
        return
    await get_all(data_dir=data_dir)


async def get_all(*, data_dir: Path) -> SymbolsAllResponse:
    """Tier 2: GET-time lock + Future dedupe.
    
    N concurrent calls share one underlying fetch.
    """
    global _inflight, _status   # noqa: PLW0603
    async with _lock:
        if _is_fresh():
            return SymbolsAllResponse(symbols=list(_cache), status="fresh",
                                       fetched_at_ms=_fetched_at_ms)
        if _inflight is None:
            _status = "loading" if not _cache else _status
            loop = asyncio.get_running_loop()
            _inflight = loop.create_future()
            fetch_task = asyncio.create_task(_do_fetch_and_populate(data_dir))
            def _signal(_t: asyncio.Task) -> None:
                if not _inflight.done():  # type: ignore[union-attr]
                    _inflight.set_result(None)   # type: ignore[union-attr]
            fetch_task.add_done_callback(_signal)
        fut = _inflight
    await fut
    async with _lock:
        _inflight = None
    return SymbolsAllResponse(symbols=list(_cache), status=_status,  # type: ignore[arg-type]
                               fetched_at_ms=_fetched_at_ms)


async def refresh(*, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — force a synchronous re-fetch."""
    global _fetched_at_ms   # noqa: PLW0603
    async with _lock:
        _fetched_at_ms = None
    return await get_all(data_dir=data_dir)


def search(q: str, *, limit: int = 20) -> list[SymbolHit]:
    """Pure in-memory filter — caller is expected to have already populated
    the cache via get_all().
    
    Numeric prefix → code match. Otherwise → name substring match.
    Sort: code-prefix matches before substring matches, then by name length.
    """
    q_norm = q.strip()
    if not q_norm:
        return list(_cache)[:limit]
    if q_norm.isdigit():
        # Code prefix
        matches = [h for h in _cache if h.code.startswith(q_norm)]
        return matches[:limit]
    # Name substring
    matches = [h for h in _cache if q_norm in h.name]
    matches.sort(key=lambda h: (not h.name.startswith(q_norm), len(h.name)))
    return matches[:limit]


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/symbols", tags=["symbols"])

    @router.get("/all")
    async def get_all_route() -> SymbolsAllResponse:
        return await get_all(data_dir=data_dir)

    @router.get("")
    async def search_route(q: str = Query("", min_length=0),
                           limit: int = Query(20, ge=1, le=100)) -> list[SymbolHit]:
        # If cache empty, populate first.
        if not _cache:
            await get_all(data_dir=data_dir)
        return search(q, limit=limit)

    @router.post("/refresh")
    async def refresh_route() -> SymbolsAllResponse:
        return await refresh(data_dir=data_dir)

    return router
```

- [ ] **Step 4: Mount the router**

Edit `hoga/api/routes.py` (or wherever routers get included) — add:
```python
from hoga.api.symbols import build_router as build_symbols_router
...
app.include_router(build_symbols_router(data_dir=data_dir))
```

Edit `hoga/api/app.py` lifespan — schedule the prefetch:
```python
from hoga.api import symbols as _symbols_module
asyncio.create_task(_symbols_module.ensure_cache_warm(data_dir))
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/test_api_symbols.py -v 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Full sweep + commit**

```bash
git add hoga/api/symbols.py hoga/api/app.py hoga/api/routes.py tests/test_api_symbols.py
git commit -m "feat(symbols): pykrx master cache (3-tier policy) + captured_breakdown

GET /api/symbols/all returns SymbolsAllResponse envelope with
{symbols, status, fetched_at_ms}. GET /api/symbols?q=... filters
in-memory. POST /api/symbols/refresh forces a synchronous re-fetch.
Lifespan schedules ensure_cache_warm() fire-and-forget. Concurrent GETs
dedupe to one fetch via in-flight Future. pykrx failure returns stale
cache (or unavailable if no prior cache).

SymbolHit.captured_count = complete-only count (spec §11 Q18).
captured_breakdown = {complete, source_partial, client_incomplete}.
Counts computed by walking data/parquet/*/{code} via
disk_state.check_disk_state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: `hoga/api/calendar.py` — per-symbol month status map with `as_of_ms`

Composition over invention: combine `disk_state.check_disk_state` with the KRX trading-day list and a today/18-KST overlay. Returns `{cells: [...], as_of_ms: int}`.

**Files:**
- New: `hoga/api/calendar.py`
- Modify: `hoga/api/routes.py` (mount router)
- Test: `tests/test_api_calendar.py` [new]

- [ ] **Step 1: Failing tests**

Create `tests/test_api_calendar.py`:
```python
"""GET /api/inventory/calendar?code&year&month."""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _build_app(monkeypatch, tmp_path):
    from hoga.api.app import create_app
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    return create_app()


def test_calendar_returns_envelope_with_as_of_ms(monkeypatch, tmp_path):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/inventory/calendar?code=005930&year=2026&month=5")
        assert r.status_code == 200
        body = r.json()
        assert "cells" in body and "as_of_ms" in body
        assert isinstance(body["as_of_ms"], int) and body["as_of_ms"] > 0
        # 31 days in May.
        assert len(body["cells"]) == 31


def test_calendar_marks_weekends(monkeypatch, tmp_path):
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/inventory/calendar?code=005930&year=2026&month=5")
        body = r.json()
        # 20260516 was a Saturday.
        sat = next(cell for cell in body["cells"] if cell["date"] == "20260516")
        assert sat["status"] == "weekend"


def test_calendar_marks_future_dates(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    fixed_now = dt.datetime(2026, 5, 15, 10, 0, 0, tzinfo=KST)
    monkeypatch.setattr("hoga.api.calendar._now_kst", lambda: fixed_now, raising=False)
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        # 20260518 is in the future relative to fixed_now.
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "future"


def test_calendar_marks_today_locked_before_18_kst(monkeypatch, tmp_path):
    KST = dt.timezone(dt.timedelta(hours=9))
    monkeypatch.setattr("hoga.api.calendar._now_kst",
                        lambda: dt.datetime(2026, 5, 22, 17, 59, 0, tzinfo=KST),
                        raising=False)
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        today_cell = next(c for c in body["cells"] if c["date"] == "20260522")
        assert today_cell["status"] == "today_locked"


def test_calendar_uses_disk_state_for_captured_cells(monkeypatch, tmp_path):
    (tmp_path / "parquet" / "20260518" / "005930").mkdir(parents=True)
    (tmp_path / "parquet" / "20260518" / "005930" / "meta.json").write_text(
        json.dumps({"collection_complete": True, "is_partial": False}))
    app = _build_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/inventory/calendar?code=005930&year=2026&month=5").json()
        cell = next(c for c in body["cells"] if c["date"] == "20260518")
        assert cell["status"] == "complete"
        assert cell["captured_at_ms"] is not None
```

- [ ] **Step 2: Verify fail**

Run: `uv run pytest tests/test_api_calendar.py -v 2>&1 | tail -15`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `hoga/api/calendar.py`**

Create `hoga/api/calendar.py`:
```python
"""GET /api/inventory/calendar — per-symbol month status map.

Composes disk_state.check_disk_state with the KRX trading-day list and a
today/18-KST overlay. Pure read-side; no mutation. See spec §5.3, §11 Q21.
"""
from __future__ import annotations

import calendar as stdlib_calendar
import datetime as dt
import time
from pathlib import Path

from fastapi import APIRouter, Query

from hoga.api.disk_state import DiskState, check_disk_state
from hoga.api.models import CalendarCell, CalendarResponse

KST = dt.timezone(dt.timedelta(hours=9))
_TODAY_TOO_EARLY_HOUR = 18


def _now_kst() -> dt.datetime:
    return dt.datetime.now(tz=KST)


# Module-level cache: (year, month) → set of YYYYMMDD trading-day strings.
# KRX trading days for past months are stable (holidays don't reschedule retro-
# actively), so an unbounded dict is fine for one process. For the current
# month we accept up to 24h staleness — a new holiday landing mid-month is
# rare enough that bouncing the server fixes it.
_month_cache: dict[tuple[int, int], set[str]] = {}


def _trading_days_for(year: int, month: int) -> set[str]:
    """Return YYYYMMDD strings for KRX trading days in (year, month). Cached."""
    key = (year, month)
    cached = _month_cache.get(key)
    if cached is not None:
        return cached
    start = f"{year:04d}{month:02d}01"
    last_day = stdlib_calendar.monthrange(year, month)[1]
    end = f"{year:04d}{month:02d}{last_day:02d}"
    from pykrx import stock
    df = stock.get_market_ohlcv(start, end, "005930")
    result = {d.strftime("%Y%m%d") for d in df.index}
    _month_cache[key] = result
    return result


def trading_days_in_range(start: str, end: str) -> list[str]:
    """Public helper used by captures.py Task 7. Returns YYYYMMDD trading days
    in [start, end] inclusive, sorted. Composes _trading_days_for across all
    months the range spans, so multi-month ranges only hit pykrx once per month.
    """
    start_d = dt.date(int(start[:4]), int(start[4:6]), int(start[6:8]))
    end_d = dt.date(int(end[:4]), int(end[4:6]), int(end[6:8]))
    if end_d < start_d:
        raise ValueError("end_date < start_date")
    out: list[str] = []
    cur = dt.date(start_d.year, start_d.month, 1)
    while cur <= end_d:
        days = _trading_days_for(cur.year, cur.month)
        for d in sorted(days):
            if start <= d <= end:
                out.append(d)
        # Advance to the first day of the next month.
        if cur.month == 12:
            cur = dt.date(cur.year + 1, 1, 1)
        else:
            cur = dt.date(cur.year, cur.month + 1, 1)
    return out


def reset_cache_for_tests() -> None:
    """Test helper — clears the trading-day cache between tests."""
    _month_cache.clear()


def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
        DiskState.NONE: "none",
    }[st]


def _captured_at_ms(data_dir: Path, code: str, date: str) -> int | None:
    parquet = data_dir / "parquet" / date / code
    if parquet.exists():
        try:
            return int(parquet.stat().st_mtime * 1000)
        except OSError:
            return None
    raw = data_dir / "raw" / date / code
    if raw.exists():
        try:
            return int(raw.stat().st_mtime * 1000)
        except OSError:
            return None
    return None


def _cell_status_for(date_str: str, now: dt.datetime, trading_days: set[str],
                     data_dir: Path, code: str) -> str:
    d = dt.date(int(date_str[:4]), int(date_str[4:6]), int(date_str[6:8]))
    today = now.date()
    if d > today:
        return "future"
    if d == today and now.hour < _TODAY_TOO_EARLY_HOUR:
        return "today_locked"
    if date_str not in trading_days:
        return "weekend" if d.weekday() >= 5 else "holiday"
    return _disk_state_to_status(check_disk_state(data_dir, code, date_str))


def get_month_map(*, data_dir: Path, code: str, year: int, month: int) -> CalendarResponse:
    """Build the month status map. Pure read-side."""
    now = _now_kst()
    trading_days = _trading_days_for(year, month)
    last_day = stdlib_calendar.monthrange(year, month)[1]
    cells: list[CalendarCell] = []
    for day in range(1, last_day + 1):
        date_str = f"{year:04d}{month:02d}{day:02d}"
        status = _cell_status_for(date_str, now, trading_days, data_dir, code)
        captured_ms = (_captured_at_ms(data_dir, code, date_str)
                        if status in ("complete", "source_partial", "client_incomplete")
                        else None)
        cells.append(CalendarCell(date=date_str, status=status,  # type: ignore[arg-type]
                                   captured_at_ms=captured_ms))
    return CalendarResponse(cells=cells, as_of_ms=int(time.time() * 1000))


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/inventory", tags=["inventory"])

    @router.get("/calendar")
    async def calendar_route(code: str = Query(..., pattern=r"^\d{6}$"),
                              year: int = Query(..., ge=2000, le=2100),
                              month: int = Query(..., ge=1, le=12)) -> CalendarResponse:
        return get_month_map(data_dir=data_dir, code=code, year=year, month=month)

    return router
```

- [ ] **Step 4: Mount the router**

Edit `hoga/api/routes.py` (or wherever):
```python
from hoga.api.calendar import build_router as build_calendar_router
...
app.include_router(build_calendar_router(data_dir=data_dir))
```

- [ ] **Step 5: Run tests + full sweep + commit**

Run: `uv run pytest tests/test_api_calendar.py -v 2>&1 | tail -15 && uv run pytest -q 2>&1 | tail -3`
Expected: green.

```bash
git add hoga/api/calendar.py hoga/api/routes.py tests/test_api_calendar.py
git commit -m "feat(calendar): GET /api/inventory/calendar with as_of_ms (Q21)

Composes disk_state.check_disk_state with KRX trading-day list + today/18
KST overlay. Returns {cells, as_of_ms} envelope per spec §11 Q21 for
client-side SSE reconciliation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Final sweep — cleanup audit + ADR-0007 footer

Confirm nothing legacy remains. Update ADR-0007's status footer with the landing date so future readers can place "growth budget retired" in time.

- [ ] **Step 1: Audit — these greps should all return zero hits**

```bash
grep -rn "frontier_hhmmss" hoga/ tests/ frontend/ 2>/dev/null
grep -rn "allow_partial\|is_partial_capture\|PartialCaptureRefused" hoga/ tests/ 2>/dev/null
grep -rn "CaptureJobState\|StartCaptureRequest\|_run_capture_job\|cancel_latest_on_shutdown\|_latest:" hoga/ tests/ 2>/dev/null
grep -rn "/api/captures\"\|/api/captures/latest\|/api/captures/latest/cancel" hoga/ tests/ 2>/dev/null
grep -rn "\"job_id\"" hoga/ tests/ 2>/dev/null     # wire field renamed to item_id
```
Expected: all zero. Each non-zero hit is a missed edit — fix before continuing.

- [ ] **Step 2: Confirm test count baseline**

Run: `uv run pytest --collect-only -q 2>&1 | tail -3`
Expected: greater than the 224 Plan A baseline by approximately 30+ (new model tests, queue tests, symbols tests, calendar tests, today_too_early tests). Note the exact number.

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: all green.

- [ ] **Step 3: Update ADR-0007 footer**

Edit `docs/adr/0007-capture-grows-disk-state-extracted.md` — change the status line and append a footer paragraph:

```markdown
**Status:** accepted (2026-05-21) — amends ADR-0006; Plan B landed 2026-05-22 confirming the queue/worker/pause growth
```

And append at the end of the file:
```markdown

## Postscript — Plan B landing notes (2026-05-22)

Plan B (`docs/superpowers/plans/2026-05-22-capture-queue-backend.md`)
implemented the queue + worker pool + cookie pause + sibling endpoints
(symbols, calendar). `hoga/api/captures.py` reached ~800 lines and stays
single-module per the decision above. Two new sibling modules (`symbols.py`,
`calendar.py`) appeared exactly where the spec said they would; no further
seams emerged in the process.
```

- [ ] **Step 4: Commit final sweep**

```bash
git add docs/adr/0007-capture-grows-disk-state-extracted.md
git commit -m "docs(adr-0007): Plan B landed — postscript with growth confirmation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Final ship gate**

Run: `uv run pytest -q 2>&1 | tail -3 && git log --oneline -20`
Expected: all green; Plan B's 16-task commit chain visible. Ready for `/plan-eng-review` then `/superpowers:subagent-driven-development` (if iterating subagent-driven).

---

## Done criteria

- All 16 tasks above committed; commit messages reference the Q-numbers and spec §-numbers they implement.
- `uv run pytest -q` is green (test count strictly greater than the Plan A 224 baseline; we added net-positive tests, deleted only the obsolete single-capture tests).
- Greps in Task 16 all return zero hits.
- `hoga/api/captures.py` reaches ~700–800 lines and stays single-module — confirmed by ADR-0007's postscript.
- `hoga/api/symbols.py` and `hoga/api/calendar.py` exist as the only two new sibling modules; no other splits introduced.
- The four new SSE event types (`capture_queued`, `capture_queue_paused`, `capture_queue_resumed`, `capture_queue_drained`) are emitted on the bus and consumed in tests.
- 18 KST today-lock is enforced by both `POST /api/captures/items` (route guard) and the worker deciding phase (defense-in-depth via the orchestrator's `is_today_too_early`).
- pykrx 3-tier policy verified by tests (cold start → loading; concurrent GETs dedupe; failure with prior cache → stale; failure without prior cache → unavailable).
- `GET /api/inventory/calendar` returns `as_of_ms`; statuses include `weekend / holiday / future / today_locked / complete / source_partial / client_incomplete / none`.

---

## What's NOT in this plan (intentional)

- **Frontend changes** — Plan C owns the new `SymbolSearch`, `DateRangePicker`, `CaptureForm`, `CaptureQueue` + Cancel All / Resume / Dismiss Done UI, the LeftNav pill rewrite, and `useCalendar` reconciliation against `as_of_ms`. The existing single-capture frontend page will break or behave incorrectly between Plan B landing and Plan C landing — this is acknowledged in spec §11 commentary and accepted.
- **Queue persistence across server restart** — spec §9.2 explicit out-of-scope.
- **A new ADR** — ADR-0007 already covers Plan B's growth justification; only a postscript is added.
- **`hoga reparse --all` CLI** — spec §9.3 follow-up.
- **Inventory SSE storm dedupe / debounce** — spec §9.3 follow-up, recorded in Q21 amendments.
- **E2E Playwright tests** — Plan C's territory (need a working frontend to drive).

---

## What already exists (reuse audit)

- `hoga/api/disk_state.py` (Plan A) — `DiskState` enum, `check_disk_state`, `classify_from_meta`, `has_meaningful_gaps`. Wired into worker deciding phase (Task 5), captured breakdown (Task 14), calendar cells (Task 15).
- `hoga/api/timeenc.py` (Plan A) — `HogaMs` NewType. Used by `QueueItemState.frontier` (Task 3) and `_apply_progress` (unchanged from existing).
- `meta.json` two completeness bits (Plan A) — read by every `disk_state.check_disk_state` call.
- `_publish_event`, `set_bus`, `_make_progress_callback`, `_apply_progress` — kept; the new worker pool uses them as-is.
- `hoga/collector/orchestrator.py` `collect_stock_date`, `CancelToken`, `CaptureCancelled` — interface unchanged (after the `allow_partial` removal in Task 1).
- `hoga/parser/__init__.py` `parse_stock_date` — interface unchanged.
- `hoga/inventory/trading_days.py` — reused by `_expand_to_trading_days` (Task 7). If it lacks the right helper, fall back to direct pykrx as documented.

---

## Failure modes (per new codepath)

| Codepath | Most likely failure | Detection | Recovery |
|---|---|---|---|
| Worker loop | One worker crashes mid-`_run_item`, leaks `_active` entry | `wait_drained()` hangs; test timeout | `_finalize_item` always runs in worker `finally`; verify in Task 4 test |
| Inflight lock | (code, date) re-enqueued forever | Test asserts both items finish, not "still in queue" | Task 6 test catches it |
| Cookie pause | Race: two workers raise CookieExpiredError simultaneously | Both publish pause event | `_handle_cookie_expired` is idempotent (returns early if already paused) |
| 429 backoff | All retries 429 → item stuck in capturing forever | Test timeout | After exhausting `_BACKOFF_DELAYS`, propagate → worker marks failed |
| Symbols cache | pykrx hangs forever | GET /api/symbols/all hangs N callers | `_inflight` Future + `_lock`; consider adding a timeout in production follow-up if observed |
| Calendar trading_days | pykrx returns empty for an unusual month | All non-weekend cells marked `holiday` | Acceptable degradation; calendar still renders, user can still pick dates |
| Queue drained event | `_active` empty but `_done` is huge → emit happens N times as items finalize | One drained per finalize triggers off | Guard: emit only when `_queue` empty AND `_active` empty AND not paused — the last item's finalize is the natural trigger |

---

## Worktree parallelization strategy

Tasks 1, 2 are sequentially dependent (rename + models). Tasks 3–13 (queue infrastructure) are sequentially dependent — each one builds on the previous via state in `captures.py`. Tasks 14 (symbols) and 15 (calendar) are independent of the queue work and of each other — they can run in parallel worktrees after Task 13 lands. Task 16 is the final reconciliation.

Suggested branches if running subagent-driven:
- main feature branch: `worktree-feat+frontend2` — Tasks 1–13 land here in order.
- side branch (optional): a sibling worktree picking up Task 14 and Task 15 once Task 13 commits.

If running inline single-session, just go top-to-bottom.

---

## Self-review (post-write)

Spec coverage check:
- §1.2 In scope "remove `allow_partial`" → Task 1 ✓
- §3.1 Module changes — captures.py rewrite, symbols.py new, calendar.py new → Tasks 3–13, 14, 15 ✓
- §3.2 Queue / worker pool — state singletons + worker pool → Tasks 3–4 ✓
- §3.3 Routes — all six routes — Tasks 7 (items), 8 (queue), 9 (cancel + cancel-all), 10 (resume), 12 (done) ✓
- §3.4 SSE events — all new event types in models.py Task 2, emitted across Tasks 4–10 ✓
- §3.5 Completeness — already in Plan A; Plan B consumes via disk_state ✓
- §3.6 `has_meaningful_gaps` — already in Plan A ✓
- §3.7 Cookie pause — Task 10 ✓
- §3.8 429 backoff — Task 11 ✓
- §3.9 Data migration — disk_state.classify_from_meta already has conservative defaults (Plan A); no migration tool needed
- §5.1 State machine — implemented across Tasks 3–11
- §5.2 Worker algorithm — Tasks 4, 5, 6, 10
- §5.3 Calendar marker computation — Task 15
- §5.4 End-to-end data flow — emerges from Tasks 7–10 + 15
- §7.1 Backend tests — every test name in §7.1 appears in this plan's test list (with minor renames where Q-numbered semantics demanded it, e.g. `test_partial_refused_400` → `test_enqueue_rejects_today_pre_18_kst`)
- §11 Q14 — Task 1 (rename + 18 KST) + Task 7 (route guard) + Task 5 (defense-in-depth via orchestrator)
- §11 Q15 — Task 6 (Layer 2 worker check) + Task 7 (Layer 1 enqueue dedupe)
- §11 Q16 — Task 7 (force_retry frozen at enqueue) + Task 5 (force_retry overrides skip)
- §11 Q17 — disk_state.py is Plan A; this plan consumes it across Tasks 5, 14, 15
- §11 Q18 — `captured_count` (complete only) + `captured_breakdown` in Task 14 SymbolHit model and _count_captured_states helper
- §11 Q19 — Task 14 three-tier cache
- §11 Q20 — Task 10 cancel-all-in-paused
- §11 Q21 — Task 15 `as_of_ms` in CalendarResponse

Placeholder scan: no "TBD", no "handle appropriately", every step contains the actual content. ✓

Type consistency check: `item_id` used consistently across QueueItem, _CaptureEventBase, route paths, and tests. `force_retry` stays bool throughout. `captured_breakdown: dict[str, int]` shape stable in model + helper + tests. `_inflight_paths` is `set[tuple[str, str]]` everywhere it's touched. ✓

Plan complete and saved to `docs/superpowers/plans/2026-05-22-capture-queue-backend.md`.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES FIXED | 6 issues found and inlined; 4 critical, 2 perf |

### Findings (all fixed inline before execution)

**F1 (P1, confidence 10/10)** — `hoga/inventory/trading_days.py` does **not exist**.
Task 7's import `from hoga.inventory.trading_days import iter_trading_days` would
have failed at import time. **Fix applied:** the trading-day expansion helper now
lives in `hoga/api/calendar.py` as `trading_days_in_range`, with a Task 7
placeholder stub upgraded by Task 15. No third sibling module added — the helper
has two consumers (captures.py enqueue + calendar.py month render) which justifies
a single shared location per the ADR-0006 / ADR-0007 two-adapters rule.

**F2 (P1, confidence 10/10)** — `HogaplayHTTPError` carries **no `.status` attribute**
(verified by grep at `hoga/collector/client.py:33` — class is just `RuntimeError`
with status only embedded in the message string). Task 11's 429 dispatch
`if exc.status != 429` would always be False (None != 429), so backoff would
never trigger and every 429 would propagate as `failed` after one attempt.
**Fix applied:** Task 11 now includes a small `client.py` edit adding
`status_code: int | None = None` as a typed field, and updates the three raise
sites to populate it.

**F3 (P1, confidence 9/10)** — Task 14's `_fetch_from_pykrx` called
`get_market_ticker_name` per ticker × ~6000 symbols = **~10 min boot time**.
**Fix applied:** swapped to `pykrx.stock.get_market_cap(date, market=...)` which
returns ticker+name in ONE DataFrame per market — two calls total, ~2 seconds.

**F4 (P1, confidence 9/10)** — Task 14's `_count_captured_states` was called per
symbol (~6000), each walking parquet/* (~100 dates) = ~600,000 stat calls per
cache rebuild. **Fix applied:** single-pass walk in `_build_all_captured_breakdowns`
builds `{code: breakdown}` once in O(total_stock_date_dirs); executor-thread to
keep the loop responsive.

**F5 (P1, confidence 9/10)** — Task 11 backoff `await asyncio.sleep(30)` did not
honor `cancel_token`. A cancel during a 30s 429 sleep would force the user to
wait the full 30s before the item terminated as cancelled. **Fix applied:**
introduced `_cancel_aware_sleep` which `asyncio.wait_for`s on the underlying
`asyncio.Event` (verified at orchestrator.py:61 — `CancelToken._event` is
`asyncio.Event`, `.cancelled` is a property reading `is_set()`). Cancel during
backoff now raises `CaptureCancelled` and unwinds to the worker exception
handler (which marks the item cancelled). Added the regression test
`test_cancel_during_429_backoff_aborts_immediately`.

**F6 (P2, confidence 8/10)** — Task 15's `_trading_days_for(year, month)` called
`pykrx.stock.get_market_ohlcv` (a heavy per-ticker query) on every calendar
GET request. **Fix applied:** module-level `_month_cache: dict[(year, month), set[str]]`
+ `reset_cache_for_tests()` helper. Past months are stable; current-month
24h staleness is acceptable (rare retroactive holiday changes).

### Architecture (no rewrites needed)

- ADR-0007 already covers `captures.py` growing past 700 lines as a single
  module; queue + workers + cookie pause stay co-located. No additional ADR.
- `disk_state.check_disk_state` (Plan A) has three distinct consumers (worker
  deciding, calendar cells, symbols breakdown) — the "horizontal seam" rationale
  in ADR-0007 holds and is reinforced by Plan B's actual call sites.
- The transitional `CaptureJob = QueueItem` alias is the right migration shim
  for the rename — coexists with `_latest` from Task 2 to Task 13, removed
  cleanly at Task 13.
- 18 KST today-lock has defense-in-depth (route guard + worker deciding phase
  re-check via `is_today_too_early`) — matches spec §11 Q14 intent.
- Q15 two-layer dedupe is implemented as designed: enqueue-time set diff
  (Layer 1, Task 7) + per-(code, date) inflight lock (Layer 2, Task 6).

### Test coverage (gaps closed by F5 fix)

- `test_cancel_during_429_backoff_aborts_immediately` added (was missing).
- All §7.1 spec tests appear in the plan with matching semantics.
- Plan A's 224-test baseline preserved through Task 12; tests for the removed
  `_latest` endpoints intentionally deleted at Task 13 alongside their endpoints.

### Style notes (P3 — not fixed, acceptable)

- `_data_dir_for_tests` / `_client_factory_for_tests` injection seams are
  module-globals. A cleaner approach would inject through worker pool init,
  but the current pattern matches the existing `set_bus` style and keeps
  diffs minimal. Acceptable for now; revisit if the queue surface needs more
  injection points.
- `_BACKOFF_DELAYS` is now a tuple (changed from list as part of F2 fix) so
  it's at least immutable; tests monkeypatch the whole module attr rather
  than mutating in place.

### CROSS-MODEL: not run (auto mode; outside voice deferred to subagent execution where each task's review naturally provides a second pass).

### UNRESOLVED: 0

### VERDICT: CLEARED — Eng Review passed with 6 inline fixes. Ready to implement via `/superpowers:subagent-driven-development`.


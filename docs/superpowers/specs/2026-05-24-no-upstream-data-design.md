# No-Upstream-Data State

**Date**: 2026-05-24
**Status**: Draft
**Type**: feature + bug fix
**Trigger case**: `003490` (대한항공) `20260319` — capture failed with
`internal_error: info row expects >=22 fields, got 0`. Root cause:
hogaplay returned HTTP 200 with an empty body because no data exists
for that (code, date). The error surfaced as a parser crash, masking
the fact that upstream simply had nothing to give.

## Problem

hogaplay's `info.php` endpoint signals "no data exists for this
(code, date)" by returning HTTP 200 with an empty response body —
not 404, not 5xx. Our collector writes the empty body to
`raw/{date}/{code}/info.tsv` (0 bytes) and proceeds; the parser
later crashes with `FieldCountError: info row expects >=22 fields,
got 0`, classified as `internal_error` in the queue UI.

This is a misclassification: "no upstream data" is a legitimate
external state, not a system bug, and the system should:

1. **Detect** the empty body at the collector boundary, before it
   pollutes the disk with zero-byte artifacts.
2. **Persist** the "no data" signal on disk so subsequent eligibility
   decisions can skip without re-calling hogaplay.
3. **Surface** the state as a distinct UI marker (calendar `–` glyph),
   not conflated with the existing `client_incomplete` (✕ "broken")
   state which means "collection started but interrupted."
4. **Allow override** via the existing `force_retry` flag, since
   hogaplay coverage gaps may close later.

## Goals

- Add a `NO_UPSTREAM_DATA` state to the five-layer status taxonomy
  (collector exception → worker skip_reason → DiskState → CalendarStatus → UI marker).
- Persist the state via a `.no_upstream_data` sentinel file in the
  raw directory.
- Calendar shows `–` marker, clickable (so `force_retry` re-tries
  work), distinct from `✕` (client_incomplete) and `⚠` (source_partial).
- Existing `force_retry` semantics apply: the flag bypasses the sentinel
  the same way it bypasses `source_partial`.

## Non-goals

- **Do not** treat empty responses from `first.php` or `chart.php` as
  `NO_UPSTREAM_DATA`. Only `info.php` is in scope for v1. The other
  endpoints may need their own classification, but that decision
  requires more real-world data and is deferred.
- **Do not** build a one-shot migration script for existing zero-byte
  `info.tsv` directories. The only confirmed case is `003490/20260319`;
  the user can clear it via `force_retry`, which the new code converts
  to the proper sentinel + `skipped/no_upstream_data` shape.
- **Do not** introduce a new `CapturePhase`. Reuse `skipped` with a new
  `skip_reason`.

## Status Taxonomy (after change)

```
[Backend Python]                          [Frontend TS]
─────────────────                         ─────────────

CapturePhase  (unchanged)                 CapturePhase  (unchanged)
  queued / deciding / capturing /           queued / deciding / capturing /
  parsing / done / failed /                 parsing / done / failed /
  cancelled / skipped                       cancelled / skipped

SkipReason                                SkipReason
  already_complete                          already_complete
  source_partial                            source_partial
  no_upstream_data       ★ NEW              no_upstream_data       ★ NEW

DiskState                                 (frontend does not consume DiskState
  NONE                                     directly — uses CalendarStatus)
  NO_UPSTREAM_DATA       ★ NEW
  CLIENT_INCOMPLETE                       CalendarStatus
  SOURCE_PARTIAL                            complete / source_partial /
  INVALID                                   client_incomplete / invalid /
  COMPLETE                                  none / weekend / holiday /
                                            future / today_locked /
                                            no_upstream_data       ★ NEW
```

## Persistence Model

```
data/raw/{date}/{code}/
  .no_upstream_data         ← 0 bytes, single signal file
                              (info.tsv, chart.tsv, _progress.json deleted
                              by _record_no_upstream_data)

data/parquet/{date}/{code}/
  (directory not created — no meaningful data to write)
```

**Invariant**: a Stock-Date directory is in exactly one of two
shapes — either `.no_upstream_data` exists alone in `raw_dir` (and
no `parquet_dir`), or `.no_upstream_data` does not exist (and the
existing `disk_state` rules apply). `force_retry` must delete the
sentinel before re-running `collect_stock_date` to maintain this
invariant.

## Data Flow (happy path)

```
1. captures.py worker calls collect_stock_date(...)
2. orchestrator: info_body = client.fetch_info(code, date)
3. orchestrator: if not info_body.strip():
                     raise UpstreamNoDataError(code, date)
4. captures.py _run_capture_inner catches the exception:
     - delete zero-byte info.tsv / chart.tsv / _progress.json
     - touch raw_dir/.no_upstream_data
     - state.phase = "skipped"
     - state.skip_reason = "no_upstream_data"
     - return (normal control flow — not an exception path)
5. _finalize_item publishes capture_finished, increments
   total_skipped in drained event.

Later, on calendar GET:
6. check_disk_state sees raw_dir/.no_upstream_data
     → Classification(state=DiskState.NO_UPSTREAM_DATA)
7. _disk_state_to_status: → "no_upstream_data"
8. Frontend renders cell:
     - marker "–"
     - tooltip "{date} · no upstream data (force to retry)"
     - cursor: pointer (clickable)
9. User clicks cell, checks force_retry, enqueues:
     - decide_capture sees NO_UPSTREAM_DATA + force_retry=True
       → deletes sentinel
       → returns CaptureDecision(skip_reason=None, resume=False)
     - collect_stock_date runs fresh
     - If still empty: sentinel re-created.
     - If data exists now: normal collection writes info.tsv +
       pages + chart.tsv, parser writes parquet/meta.json.
```

## Backend Changes

### 1. `hoga/collector/orchestrator.py`

Add exception class and empty-body detection.

```python
class UpstreamNoDataError(RuntimeError):
    """Raised when hogaplay returns an empty body for info.php — the
    upstream signal that no data exists for this (code, date)."""
    def __init__(self, code: str, date: str) -> None:
        super().__init__(f"hogaplay returned empty info.php for {code}/{date}")
        self.code = code
        self.date = date
```

In `collect_stock_date` (around the existing info.php block):

```python
info_path = raw_dir / "info.tsv"
if not (resume and info_path.exists()):
    info_body = client.fetch_info(code, date)
    if not info_body.strip():
        raise UpstreamNoDataError(code, date)
    info_path.write_text(info_body, encoding="utf-8")
    if rate_limit_s > 0:
        _time.sleep(rate_limit_s)
```

The check runs only in the non-resume branch. If `resume=True` and
`info.tsv` already exists, the function trusts the prior fetch
(unchanged behavior).

### 2. `hoga/api/captures.py`

Wrap the `collect_stock_date` call in `_run_capture_inner` with
`try/except UpstreamNoDataError`:

```python
from hoga.collector.orchestrator import UpstreamNoDataError

try:
    result = await loop.run_in_executor(None, lambda: collect_stock_date(...))
except UpstreamNoDataError:
    _record_no_upstream_data(data_dir, state.code, state.date)
    state.phase = "skipped"
    state.skip_reason = "no_upstream_data"
    state.estimate_pct = 100
    progress = state.to_progress()
    if progress is not None:
        _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))
    return
```

New helper:

```python
def _record_no_upstream_data(data_dir: Path, code: str, date: str) -> None:
    """Write the .no_upstream_data sentinel and remove zero-byte
    pre-collect artifacts so the directory is in canonical form
    for check_disk_state."""
    raw_dir = data_dir / "raw" / date / code
    raw_dir.mkdir(parents=True, exist_ok=True)
    for stale in ("info.tsv", "chart.tsv", "_progress.json"):
        (raw_dir / stale).unlink(missing_ok=True)
    (raw_dir / ".no_upstream_data").touch()
```

The outer worker loop's general exception handler does not need to
change — `UpstreamNoDataError` is caught inside `_run_capture_inner`
and converted to a normal `skipped` return.

### 3. `hoga/api/disk_state.py`

Extend `DiskState` enum:

```python
class DiskState(Enum):
    NONE = "none"
    NO_UPSTREAM_DATA = "no_upstream_data"   # ★ new
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    INVALID = "invalid"
    COMPLETE = "complete"
```

Add sentinel-first branch to `check_disk_state`:

```python
def check_disk_state(data_dir, code, date):
    raw_dir = data_dir / "raw" / date / code
    if (raw_dir / ".no_upstream_data").exists():
        return Classification(state=DiskState.NO_UPSTREAM_DATA)

    # ... existing logic (parquet/meta.json, raw/first_*.tsv, ...)
```

The sentinel takes precedence over both `parquet/meta.json` and
`raw/first_*.tsv` checks. By invariant the other artifacts should not
coexist with the sentinel, but the ordering makes the contract robust
to future bugs that might violate it.

### 4. `hoga/api/eligibility.py`

Extend `SkipReason` and add `decide_capture` branches:

```python
SkipReason = Literal["already_complete", "source_partial", "no_upstream_data"]

def decide_capture(*, data_dir, code, date, force_retry):
    disk = check_disk_state(data_dir, code, date).state
    if disk == DiskState.COMPLETE:
        return CaptureDecision(skip_reason="already_complete", resume=False)
    if disk == DiskState.NO_UPSTREAM_DATA:
        if not force_retry:
            return CaptureDecision(skip_reason="no_upstream_data", resume=False)
        # force_retry: clear sentinel and proceed with fresh capture
        (data_dir / "raw" / date / code / ".no_upstream_data").unlink(missing_ok=True)
        return CaptureDecision(skip_reason=None, resume=False)
    if disk == DiskState.SOURCE_PARTIAL and not force_retry:
        return CaptureDecision(skip_reason="source_partial", resume=False)
    resume_flag = (disk == DiskState.CLIENT_INCOMPLETE)
    return CaptureDecision(skip_reason=None, resume=resume_flag)
```

### 5. `hoga/api/calendar.py`

Extend `_disk_state_to_status` with one dict entry:

```python
def _disk_state_to_status(st: DiskState) -> str:
    return {
        DiskState.COMPLETE: "complete",
        DiskState.SOURCE_PARTIAL: "source_partial",
        DiskState.CLIENT_INCOMPLETE: "client_incomplete",
        DiskState.INVALID: "invalid",
        DiskState.NO_UPSTREAM_DATA: "no_upstream_data",   # ★ new
        DiskState.NONE: "none",
    }[st]
```

`_captured_at_ms` whitelist is unchanged: `no_upstream_data` cells
return `captured_at_ms=None` (no meaningful capture timestamp —
there was nothing to capture).

### 6. `hoga/api/models.py`

```python
SkipReason = Literal["already_complete", "source_partial", "no_upstream_data"]

CalendarStatus = Literal[
    "complete", "source_partial", "client_incomplete", "invalid", "none",
    "weekend", "holiday", "future", "today_locked",
    "no_upstream_data",   # ★ new
]
```

## Frontend Changes

### 1. `frontend/src/api/types.ts`

Mirror the backend enums:

```typescript
export type SkipReason = 'already_complete' | 'source_partial' | 'no_upstream_data';

export type CalendarStatus =
  | 'complete' | 'source_partial' | 'client_incomplete'
  | 'none' | 'weekend' | 'holiday' | 'future' | 'today_locked'
  | 'no_upstream_data';
```

### 2. `frontend/src/capture/useCalendar.ts`

Extend `markerFor`:

```typescript
export function markerFor(status: CalendarStatus): '✓' | '⚠' | '✕' | '🔒' | '–' | null {
  if (status === 'complete') return '✓';
  if (status === 'source_partial') return '⚠';
  if (status === 'client_incomplete') return '✕';
  if (status === 'today_locked') return '🔒';
  if (status === 'no_upstream_data') return '–';
  return null;
}
```

### 3. `frontend/src/capture/CalendarCell.tsx`

`DISABLED_STATUSES` is unchanged — `no_upstream_data` remains clickable.

Add badge color (gray, signaling absence):

```typescript
const STATUS_BADGE_COLOR: Partial<Record<CalendarStatus, string>> = {
  complete: 'var(--success)',
  source_partial: 'var(--warn)',
  client_incomplete: 'var(--error)',
  no_upstream_data: 'var(--fg-dimmer)',
};
```

Add tooltip and dimmed baseColor:

```typescript
case 'no_upstream_data': return `${date} · no upstream data (force to retry)`;

const baseColor: string =
  status === 'weekend' || status === 'holiday' || status === 'future' ? 'var(--fg-dimmer)'
  : status === 'today_locked' ? 'var(--fg-dim)'
  : status === 'no_upstream_data' ? 'var(--fg-dim)'
  : 'var(--fg)';
```

### 4. `frontend/src/capture/CaptureForm.tsx`

Legend text:

```jsx
Legend: ✓ complete · ⚠ partial · ✕ broken · – no upstream data · 🔒 today &lt; 18:00 KST
```

### 5. `frontend/src/capture/phase.ts`

Extend `phaseToCalendarStatus` to map the new `skip_reason`:

```typescript
export function phaseToCalendarStatus(
  phase: CapturePhase,
  skipReason: SkipReason | null,
): CalendarStatus | null {
  if (phase === 'done') return 'complete';
  if (phase === 'skipped') {
    if (skipReason === 'source_partial') return 'source_partial';
    if (skipReason === 'no_upstream_data') return 'no_upstream_data';
    return 'complete';
  }
  if (phase === 'failed' || phase === 'cancelled') return 'client_incomplete';
  return null;
}
```

This is the SSE patch path: a `capture_finished` event with
`phase="skipped"` + `skip_reason="no_upstream_data"` updates the
calendar cell immediately, without a server round-trip.

## Migration

No automated migration. Two affected surfaces, both with manual
resolutions:

1. **Queue `_done` rows with `failed/internal_error`**: the user
   clears them via the existing queue UI dismiss/clear action, or
   re-enqueues with `force_retry=True`. The re-enqueue path now
   converts the case into a clean `skipped/no_upstream_data` row.

2. **Zero-byte raw artifacts** (`raw/{date}/{code}/info.tsv` size 0):
   left in place until the user re-captures. On re-capture,
   `_record_no_upstream_data` deletes them and writes the sentinel.
   No harm in leaving them: `check_disk_state` falls through to
   `DiskState.NONE` for these directories (the existing branch
   requires `raw_dir.glob("first_*.tsv")` to match, which a
   zero-byte-info-only directory does not). `force_retry` cleans up.

Confirmed scope: `003490/20260319` is the only known case. If a future
sweep reveals more, a one-off script `tools/migrate_zero_byte_info_to_sentinel.py`
can be written then.

## Testing

### Backend (pytest)

| Test | File | Verifies |
|---|---|---|
| `test_collector_no_upstream_data` | `tests/test_collector_orchestrator.py` | FakeClient returns `""` from `fetch_info` → `UpstreamNoDataError` raised, `info.tsv` not written |
| `test_captures_worker_no_upstream_data` | `hoga/api/test_routes.py` | Worker receiving empty info → sentinel created, zero-byte files cleaned, `skipped/no_upstream_data` SSE published, `total_skipped` increments |
| `test_disk_state_no_upstream_data_sentinel` | `tests/test_api_disk_state.py` | Sentinel alone → `Classification(state=NO_UPSTREAM_DATA)`. Sentinel takes precedence over stray parquet/raw artifacts. |
| `test_eligibility_no_upstream_data` | `tests/test_eligibility.py` or equivalent | `force_retry=False` → skip. `force_retry=True` → sentinel file removed from disk, `CaptureDecision(skip_reason=None, resume=False)`. |
| `test_calendar_no_upstream_data_cell` | `tests/test_api_calendar.py` or equivalent | Sentinel directory present → `CalendarCell.status == "no_upstream_data"`, `captured_at_ms is None`. |

### Frontend (vitest)

| Test | File | Verifies |
|---|---|---|
| `markerFor returns '–'` | `frontend/src/capture/useCalendar.test.tsx` | `markerFor('no_upstream_data') === '–'` |
| CalendarCell tooltip + clickable | `frontend/src/capture/CalendarCell.test.tsx` | Marker `–` rendered, tooltip text matches, click handler invoked (not disabled). Badge color is `var(--fg-dimmer)`. |
| Legend text | `frontend/src/capture/CaptureForm.test.tsx` | Legend string contains `– no upstream data` |
| phaseToCalendarStatus branch | `frontend/src/capture/phase.test.ts` | `phaseToCalendarStatus('skipped', 'no_upstream_data') === 'no_upstream_data'` |

### E2E

Not in scope. The unit tests above cover each layer; end-to-end
verification is done manually by the user re-running `003490/20260319`
with `force_retry=True` after deployment.

## Risks and Open Questions

- **hogaplay behavior assumption**: this design treats an empty body
  as the definitive "no data" signal. If hogaplay also returns empty
  bodies on transient errors (auth, rate limit), legitimate failures
  would be silently sentineled. Mitigation: `force_retry` lets the
  user re-attempt. If this turns out to be a real false-positive
  pattern, future work could distinguish via response headers or a
  retry-on-empty heuristic.
- **Sentinel + meta.json coexistence**: the invariant says they never
  coexist, but `_record_no_upstream_data` does not explicitly delete
  any stale `parquet/{date}/{code}/meta.json`. In practice, `force_retry`
  fresh-captures from `resume=False` and the parser rewrites meta.json,
  so prior content is overwritten. Edge case: if a previous successful
  capture wrote meta.json and then a later force_retry got an empty
  response, the new code creates the sentinel but leaves the stale
  meta. `check_disk_state` returns `NO_UPSTREAM_DATA` (sentinel-first)
  so the UI is correct, but the parquet directory has unreachable
  meta. Acceptable: harmless, user-invisible.
- **`–` glyph vs. other "absence" markers**: weekend/holiday/future
  cells render with no marker at all, just dimmed text. Adding `–` for
  `no_upstream_data` introduces a third "absence" treatment (no marker,
  `–`, `🔒`). Acceptable: the user explicitly wanted a distinct marker;
  the dimmed gray color avoids confusion with `✕`.

## Decisions Log

Recording the choices made during brainstorming so future readers can
trace the rationale without re-litigating the design:

1. **Persistence = sentinel file** (vs meta.json flag or central ledger).
   Self-describing directory; minimal `disk_state` change; aligned with
   ADR-0020's archival-hook pattern.
2. **`force_retry` bypasses sentinel** (vs sentinel-is-permanent or TTL).
   Consistent with how `source_partial` is bypassed; lets users handle
   late-arriving upstream data without manual file deletion.
3. **Trigger = empty `info.php` only** (vs include first.php/chart.php).
   Conservative scope: only the confirmed signal pattern. Other empty-
   response cases need more data before they get a classification.
4. **Cell is clickable** (vs disabled like weekend/holiday).
   `force_retry` is the recovery path, so the click target must remain
   live. Gray tone + tooltip signal the state.
5. **Classification = `skipped` + `skip_reason`** (vs failed, vs new phase).
   Reuses existing wire shape with one enum value; "skip" semantics
   ("nothing to do") fit; avoids inflating `total_failed`.

## References

- Trigger case: `003490/20260319` (대한항공, captured 2026-05-24).
- Related code: [hoga/collector/orchestrator.py:441-447](../../../hoga/collector/orchestrator.py#L441-L447),
  [hoga/api/captures.py:449](../../../hoga/api/captures.py#L449),
  [hoga/api/disk_state.py:97-127](../../../hoga/api/disk_state.py#L97-L127),
  [hoga/api/eligibility.py:58-83](../../../hoga/api/eligibility.py#L58-L83),
  [hoga/api/calendar.py:138-145](../../../hoga/api/calendar.py#L138-L145),
  [frontend/src/api/types.ts:90](../../../frontend/src/api/types.ts#L90),
  [frontend/src/capture/useCalendar.ts:80](../../../frontend/src/capture/useCalendar.ts#L80),
  [frontend/src/capture/CalendarCell.tsx](../../../frontend/src/capture/CalendarCell.tsx),
  [frontend/src/capture/CaptureForm.tsx:107](../../../frontend/src/capture/CaptureForm.tsx#L107),
  [frontend/src/capture/phase.ts:61-69](../../../frontend/src/capture/phase.ts#L61-L69).
- Related memory: `project_hogaplay_empty_response.md` (this codebase's
  memory store) — establishes the upstream contract this design responds to.

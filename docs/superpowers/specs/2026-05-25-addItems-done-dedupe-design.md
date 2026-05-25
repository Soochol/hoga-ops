# addItems Dedupe Against `_done` (Phase-Aware)

**Status:** Draft
**Date:** 2026-05-25
**Owner:** capture queue UX

## Problem

`POST /api/captures/items` (`enqueue_items` in [hoga/api/captures.py:907-947](../../../hoga/api/captures.py#L907-L947)) currently dedupes only against `_queue ∪ _active ∪ _inflight_paths`. `_done` is ignored.

User scenario that breaks: a date range is submitted, some items end up in `_done` as `failed` / `cancelled` / `done` / `skipped`. The user later resubmits an overlapping range (intentionally or accidentally — for example, "I want to extend my capture to 20260530 so I'll just re-type the whole range 20260518-20260530"). The previously-terminal (code, date)s sail through dedupe and produce a *second* row for the same key. The queue list shows the new row in active and the old row in done — visually confusing exactly as [ADR-0031's predecessor spec](2026-05-25-retry-failed-bulk-design.md) called out as a Non-Goal.

[ADR-0031](../../adr/0031-capture-retry-endpoint-split.md) introduced `POST /items/retry` for *explicit* retry of failed items. This spec closes the loop for *implicit* re-submission via `addItems`.

## Terminology

This spec extends two existing CONTEXT.md terms:

- **Capture Queue** — adds two more `EnqueueDedupedRow.reason` values (`already_complete`, `already_skipped`) and adds **auto re-enqueue** semantics to `addItems`.
- **Retry** — the `attempt+1` increment, previously only triggered by the explicit `/items/retry` endpoint, is now also triggered by `addItems` when it auto re-enqueues an item from `_done`. Retry remains the *operation* of giving an item another try regardless of which endpoint initiated it.

## Goals

- Queue list contains no duplicate (code, date) rows even when the user resubmits an overlapping range.
- Re-submitting a range with `failed` / `cancelled` items in `_done` transparently retries them (the most common user intent).
- Re-submitting a range with `done` / `skipped` items in `_done` returns informative dedupe rows rather than silently re-capturing — protecting completed data unless `force_retry=true` makes intent explicit.
- Attempt history (`×N` badge) accumulates across both `/items` and `/items/retry` paths so the visual signal "this has failed before" works regardless of how the user retried.

## Non-Goals

- Changing the wire shape of `EnqueueResponse` beyond the `EnqueueDedupedRow.reason` Literal expansion.
- Touching `cancel_item` / `cancel_all` / `dismissDone` / `resumeQueue` — all unchanged.
- Replacing the explicit `/items/retry` endpoint. Both paths coexist; explicit retry remains the failed-only sanctioned button.
- Frontend UX changes. The user already sees the new behavior through the existing `capture_dismissed` SSE handler ([useCaptureQueue.ts](../../../frontend/src/capture/useCaptureQueue.ts)). No new buttons or labels.
- Bounding the size of an `addItems` batch.

## Behavior — phase-aware rules

For each candidate `(code, date)` pair in an `addItems` request, dedupe is checked in this precedence order:

1. **Active or inflight** (`pair ∈ _active.values() ∨ pair ∈ _inflight_paths`) → `already_running` (existing).
2. **Queued** (`pair ∈ _queue`, including pairs added by earlier iterations of *this* request) → `already_in_queue` (existing).
3. **Done** (`pair ∈ _done`) — new logic, branches by `old.phase` and `request.force_retry`:

   | `old.phase` | `force_retry=false` | `force_retry=true` |
   |---|---|---|
   | `failed`    | auto re-enqueue (attempt+1) | auto re-enqueue (attempt+1) |
   | `cancelled` | auto re-enqueue (attempt+1) | auto re-enqueue (attempt+1) |
   | `done`      | **`already_complete`**      | auto re-enqueue (attempt+1) |
   | `skipped`   | **`already_skipped`**       | auto re-enqueue (attempt+1) |

4. **Otherwise** — fresh `QueueItemState` with `attempt=1`, exactly as today.

**Unifying principle.** `force_retry=false` is the *gap-fill* mode: completed work (`done` / `skipped`) is preserved as a courtesy. `force_retry=true` is the *overwrite* mode: every terminal state is re-attempted. `failed` and `cancelled` are auto re-enqueued in both modes because their prior attempt produced nothing worth preserving.

**Auto re-enqueue mechanics** (per matched `_done` item):

- Construct a new `QueueItemState` with fresh `item_id` via `_make_item_id(code, date)`, fresh `enqueued_at_ms`, `attempt = old.attempt + 1`, `force_retry = request.force_retry` (the *request's* flag, not the old item's — see Edge Case #2).
- Mark the old `_done` index for removal; defer the actual `del _done[idx]` until after the loop (Edge Case #5).
- Append the new state to `_queue`. Update local `queue_pairs` so a duplicate (code, date) later in the same request is correctly deduped as `already_in_queue`.

After the loop releases `_lock`, publish:

1. `CaptureDismissedEvent(item_ids=removed_old_ids)` — if any items were auto-dismissed.
2. `CaptureQueuedEvent(items=[s.to_wire() for s in enqueued])` — same as today, including auto re-enqueued items.

In that order, so the frontend `capture_dismissed` handler removes the old rows from `_done` before the new rows appear.

## Wire model changes

**Backend** ([hoga/api/models.py:280-283](../../../hoga/api/models.py#L280-L283)):

```python
class EnqueueDedupedRow(BaseModel):
    code: str
    date: str
    reason: Literal[
        "already_in_queue",
        "already_running",
        "already_complete",   # NEW — done in _done, force_retry=false
        "already_skipped",    # NEW — skipped in _done, force_retry=false
    ]
```

**Frontend** ([frontend/src/api/types.ts:271-275](../../../frontend/src/api/types.ts#L271-L275)):

```ts
export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: 'already_in_queue' | 'already_running' | 'already_complete' | 'already_skipped';
}
```

Nothing else on the wire changes. `EnqueueResponse.enqueued` now also carries auto re-enqueued items (distinguishable by `attempt > 1`), but the type is unchanged.

## Edge Cases

1. **attempt counter consistency.** All auto re-enqueue paths use `attempt = old.attempt + 1`. The `×N` badge therefore counts every retry of the same (code, date) regardless of which endpoint triggered it. The Retry term in CONTEXT.md remains accurate.

2. **`force_retry` flag uses the request's value.** Unlike the explicit `/items/retry` flow (which preserves `old.force_retry` because the user is explicitly retrying the *original* item), `addItems` reflects a fresh intent. If a user previously enqueued with `force_retry=true` and now resubmits with `force_retry=false`, the new attempt runs with `force_retry=false`. The sentinel-delete behavior tracks the *current* request.

3. **Within-request duplicate (code, date).** Existing `seen_in_request` guard remains. Two same-pair entries in one request → first auto-retries (or freshly enqueues), second is deduped as `already_in_queue`.

4. **`pause_origin` carve-out (ADR-0019).** `_done` items with `pause_origin=True` and `phase="cancelled"` are the cookie-pause recovery list — `resume_queue` re-enqueues them on user resume. If `addItems` auto-dismisses one of these, the recovery mechanism silently breaks. Defense: in the dedupe loop, skip `_done` entries with `pause_origin=True` — let the new row enqueue normally (a temporary duplicate is acceptable; the original will be cleaned up by `resume_queue`).

5. **In-loop `_done` mutation.** Calling `del _done[idx]` while iterating breaks indices. Implementation: collect indices/states to remove during the loop, then delete after the loop in reverse-index order (or use `_done[:] = [s for s in _done if s not in dismissed_set]`). The exact mechanic is an implementation choice for the plan.

6. **Performance.** `_done` index built once as `dict[(code, date)] -> (idx, state)` at the top of the dedupe loop. Lookup is O(1) per candidate. Build cost is O(|_done|) — typically <200 because users dismiss done periodically.

7. **CaptureDismissedEvent payload size.** A 100-date range with all 100 in `_done` produces a single event with 100 `item_id` strings (~3KB). Fits comfortably in SSE message budget.

8. **Race: `_active` and `_done` for same pair simultaneously.** Cannot happen by construction — `_finalize_item` pops from `_active` and appends to `_done` atomically under `_lock`. The check order (`_active`/`_inflight_paths` before `_done`) ensures we never auto-dismiss something the worker is still finalizing.

## Testing

**Backend** ([tests/test_api_captures_queue.py](../../../tests/test_api_captures_queue.py)):

- `test_enqueue_dedupes_against_done_complete_with_force_false` — `done`-phase row + `force_retry=false` → `already_complete`; no `_done` mutation.
- `test_enqueue_re_enqueues_done_complete_with_force_true_attempt_increments` — `done`-phase row + `force_retry=true` → old removed, new in `_queue` with `attempt=2`.
- `test_enqueue_re_enqueues_failed_done_regardless_of_force_attempt_increments` — `failed` row, both `force_retry` values → auto re-enqueue.
- `test_enqueue_re_enqueues_cancelled_done_regardless_of_force` — `cancelled` row, both `force_retry` values → auto re-enqueue.
- `test_enqueue_dedupes_against_skipped_with_force_false` — `skipped` row + `force_retry=false` → `already_skipped`.
- `test_enqueue_re_enqueues_skipped_with_force_true` — `skipped` row + `force_retry=true` → auto re-enqueue.
- `test_enqueue_publishes_capture_dismissed_event_for_auto_reenqueued_items` — single event listing every old `item_id`, published before `CaptureQueuedEvent`.
- `test_enqueue_preserves_pause_origin_cancelled_skips_auto_dismiss` — `pause_origin=True` + `phase=cancelled` in `_done` is NOT auto-dismissed (carve-out).
- `test_enqueue_uses_request_force_retry_not_old_item_force_retry` — old had `force_retry=true`, request has `force_retry=false` → new state's `force_retry == false`.
- `test_enqueue_response_includes_auto_reenqueued_items_in_enqueued_list` — response body's `enqueued` array contains both fresh items and auto-retried items (with `attempt > 1`).

**Frontend** — no behavior tests needed. The wire-type expansion is mechanical; the existing `capture_dismissed` SSE handler (Task 7 of the retry-bulk plan) handles row removal. Optional sanity check: add `already_complete` / `already_skipped` to any existing `EnqueueDedupedRow.reason` tests for fixture completeness.

## Decision rationale (for ADR consideration)

This change *could* warrant an ADR because:

1. **Hard to reverse** — changes the wire contract (`reason` Literal grows by 2; new auto re-enqueue path).
2. **Surprising without context** — future readers will wonder why `addItems` looks like a hybrid of "new enqueue" and "retry."
3. **Result of a real trade-off** — alternatives were considered:
   - **Frontend-only confirmation dialog** (rejected: doesn't fix backend duplicates if user clicks Confirm).
   - **Always dedupe `_done` regardless of phase** (rejected: blocks the "I changed my mind after cancelling" flow and the explicit `force_retry=true` re-capture flow).
   - **Always dedupe with reason, never auto-retry** (rejected: forces the user to a 2-step flow — dismissDone + addItems — for the most common case of "I want my failed items to retry").

Recommend **ADR-0033** (or whatever the next number is) to record the per-phase decision table and the "gap-fill vs overwrite" framing. The Plan will create the ADR alongside the implementation commit.

## Open Questions

None — captured above as decisions.

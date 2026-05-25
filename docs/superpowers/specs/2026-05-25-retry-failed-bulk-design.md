# Retry Failed — Bulk Action + In-Place Replacement

**Status:** Draft
**Date:** 2026-05-25
**Owner:** capture queue UX

## Problem

Capturing 100 items with the current queue ([CaptureQueue.tsx](../../../frontend/src/capture/CaptureQueue.tsx)) produces a mix of `done` / `failed` / `skipped` rows. Two UX gaps make recovering from partial failure painful:

1. **No bulk retry.** The ↻ button is per-row only. Recovering 10 failures means 10 clicks scattered across the list.
2. **Duplicate rows on retry.** `addItems` enqueues a new `QueueItem` with a fresh `item_id`; the old `failed` row stays in the `done` bucket. The same (code, date) now appears twice — a new `capturing` row at the top, an old `failed` row at the bottom. Visually confusing at 100 items.

## Goals

- One click retries every failed item.
- The original failed row disappears the moment its retry starts. No duplicates.
- Attempt history is preserved on the new row (×2, ×3 badge) so repeat failures are visible.
- In-flight `active` / `queued` items are untouched by bulk retry.

## Non-Goals

- Filtering the queue list (All / Active / Failed). Header counter + bulk button are enough for the 100-item case.
- Retry policies (backoff, max attempts, scheduled retry). User decides when to retry; no cap.
- Migrating existing UI surfaces for `cancelled` or `skipped` rows.

## Design

### New backend endpoint: `POST /api/captures/items/retry`

Single entry point for both per-row ↻ and header "Retry Failed". Distinct from `POST /api/captures/items` so dedupe rules and attempt arithmetic stay in one place.

**Request:**

```python
class RetryRequest(BaseModel):
    item_ids: list[str]   # 1..500 item_ids from the done bucket
```

**Response:**

```python
class RetryResponse(BaseModel):
    enqueued: list[QueueItem]        # newly created retry items
    skipped: list[RetrySkippedRow]   # item_ids that couldn't be retried

class RetrySkippedRow(BaseModel):
    item_id: str
    reason: Literal[
        "not_found",         # item_id not in _done
        "not_failed",        # found but phase != "failed"
        "already_in_queue",  # (code, date) already in _queue
        "already_running",   # (code, date) already in _active
    ]
```

**Backend processing (per item_id, inside `_lock`):**

1. Look up the item in `_done`. Missing → skip `not_found`.
2. If `phase != "failed"` → skip `not_failed`. (Defends against retrying a `cancelled` or `done` row.)
3. Apply normal dedupe rule against `_queue ∪ _active ∪ _inflight_paths`. Hit → skip with the matching reason.
4. Remove the old failed item from `_done`.
5. Create a new `QueueItemState` with `attempt = old.attempt + 1`, `force_retry = old.force_retry`, fresh `item_id` and `enqueued_at_ms`.
6. Append to `_queue`.

After the loop (still under `_lock`): `_persist_queue_locked()`. After releasing the lock:

7. Publish `CaptureDismissedEvent(item_ids=[removed_ids])`.
8. Publish `CaptureQueuedEvent(items=[new_items])`.
9. Set `_wakeup` if anything was enqueued.

### New SSE event: `capture_dismissed`

```python
class CaptureDismissedEvent(BaseModel):
    type: Literal["capture_dismissed"] = "capture_dismissed"
    item_ids: list[str]
```

Tells the frontend to drop these item_ids from any bucket (almost always `done`). The existing `dismissDone` flow should publish this event too — currently it relies on the client-side `invalidateQueries` backstop in [useCaptureQueue.ts:96-99](../../../frontend/src/capture/useCaptureQueue.ts#L96-L99). Migrating it to the same event makes done-removal a single code path.

### Data model: `QueueItem.attempt`

Add to [hoga/api/models.py:152](../../../hoga/api/models.py#L152) `QueueItem`:

```python
attempt: int = 1   # 1 = first try; retry-enqueued items carry prior + 1
```

Default of `1` covers:

- Items created by `addItems` (the existing path doesn't pass an explicit `attempt`).
- Persisted queue snapshots ([ADR-0019](../../adr/)) loaded after this change — missing field defaults to 1.

Frontend [types.ts:156](../../../frontend/src/api/types.ts#L156) mirrors the new field. No migration script needed.

### Frontend changes

**[CaptureQueue.tsx:103-120](../../../frontend/src/capture/CaptureQueue.tsx#L103-L120) — header:**

Add a "Retry Failed" button next to Cancel All. Disabled (opacity 0.5, no click handler) when `summary.failed === 0`. Label is constant `Retry Failed` — the count already lives in the left summary, so a `(N)` suffix would be redundant.

```tsx
<button
  type="button"
  disabled={summary.failed === 0}
  onClick={handleRetryAllFailed}
  style={summary.failed === 0 ? ghostButtonDisabled() : ghostButton()}
>Retry Failed</button>
```

`handleRetryAllFailed` collects `queue.done.filter(i => i.phase === 'failed').map(i => i.item_id)` and calls the new mutation.

**[CaptureQueueRow.tsx:43-51](../../../frontend/src/capture/CaptureQueueRow.tsx#L43-L51) — attempt badge:**

Next to the existing ⚠ force badge, render `×N` when `attempt > 1`. Neutral color (`fg-dim`) — attempt count is information, not a warning.

```tsx
{item.attempt > 1 && (
  <span
    title={`Attempt ${item.attempt}`}
    className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--fg-dim)] text-fg-dim"
  >×{item.attempt}</span>
)}
```

**[CaptureQueueRow.tsx:75-82](../../../frontend/src/capture/CaptureQueueRow.tsx#L75-L82) — single-row ↻:**

`onRetry` now calls `retryItems.mutate({ item_ids: [item.item_id] })` instead of `addItems.mutate(...)`. The single-row path goes through the same backend endpoint as bulk.

**[useCaptureQueue.ts](../../../frontend/src/capture/useCaptureQueue.ts) — new mutation + SSE handler:**

```ts
const retryItemsM = useMutation({
  mutationFn: retryItems,   // new in api/captures.ts
  onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
});

// In the SSE subscriber:
} else if (e.type === 'capture_dismissed') {
  qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) => {
    if (!prev) return prev;
    const ids = new Set(e.item_ids);
    return {
      ...prev,
      active: prev.active.filter(i => !ids.has(i.item_id)),
      queued: prev.queued.filter(i => !ids.has(i.item_id)),
      done: prev.done.filter(i => !ids.has(i.item_id)),
    };
  });
}
```

### Retry flow (single + bulk, same code path)

1. User clicks ↻ on a row OR clicks "Retry Failed".
2. Frontend calls `retryItems.mutate({ item_ids: [...] })`.
3. Backend processes inside `_lock`, persists, emits events.
4. SSE `capture_dismissed` arrives → old failed rows vanish from `done` immediately.
5. SSE `capture_queued` arrives → new rows appear in the `queued` bucket → soon promoted to `active`.
6. Mutation `onSettled` runs `invalidateQueries` as backstop in case any SSE event was missed.

## Edge Cases

- **Cookie-expired pause during bulk retry.** New retry items land in `_queue`. The capture worker is paused, so they wait. Existing pause-alert UI ([CaptureQueue.tsx:127-134](../../../frontend/src/capture/CaptureQueue.tsx#L127-L134)) handles the resume; no extra work.
- **Force-retry items.** `force_retry` is copied from old to new — a force-retried failure stays force-retried on the next attempt. The ⚠ force badge persists alongside the new ×N badge.
- **Double-click on "Retry Failed".** Second call's `item_ids` reference already-removed `_done` entries → all `not_found`. Returns 200 with everything in `skipped`. No duplicate work, no error.
- **Retry after `dismissDone`.** Once an item is dismissed, its `item_id` is gone from `_done`. The ↻ button can't be clicked (row no longer rendered). Bulk action only sees current failed rows, which is correct.
- **Attempt count growing unbounded.** No cap. If a user retries the same row 50 times, the badge shows ×50. Cosmetic only — they meant to.

## Testing

**Backend ([hoga/api/captures.py](../../../hoga/api/captures.py)):**

- `POST /retry` with valid failed item_id → response has 1 enqueued, 0 skipped; item moves from `_done` to `_queue` with `attempt = prior + 1`.
- `POST /retry` with `not_found` item_id → response skip reason matches.
- `POST /retry` with a `done`-phase item_id → `not_failed`.
- `POST /retry` while same (code, date) is already in `_queue` (e.g. user just `addItems`d it manually) → `already_in_queue`.
- Concurrent bulk retry of 50 failed items → all 50 enqueued, single `CaptureQueuedEvent` published.
- `force_retry: true` failure retried → new item has `force_retry: true`.
- attempt: first enqueue=1, retry=2, retry again=3.
- Persisted queue file loaded without `attempt` field → defaults to 1, no error.

**Frontend ([frontend/src/capture/](../../../frontend/src/capture/)):**

- Header `Retry Failed` button disabled when failed=0, enabled when failed>0.
- Clicking `Retry Failed` calls `retryItems` with all failed item_ids.
- `×N` badge renders for `attempt > 1`, hidden for `attempt = 1`.
- `capture_dismissed` event removes matching item_ids from all three buckets in the React Query cache.
- Single-row ↻ click calls `retryItems` (not `addItems`) with just that item_id.

## Out of Scope

- Filtering the queue list view by phase.
- Per-attempt error history (only current attempt's error is shown via row-detail).
- Server-driven retry policies (backoff, automatic retry on transient errors).
- Visual treatment for `cancelled` rows — bulk retry only operates on `failed`.

## Open Questions

None — captured above as decisions.

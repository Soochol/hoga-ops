# Inventory Re-Capture — Selected & Bulk Abnormal-State Recovery

**Status:** Draft
**Date:** 2026-05-26
**Owner:** inventory UX

## Problem

The `/inventory` route ([pages/Inventory.tsx](../../../frontend/src/pages/Inventory.tsx)) surfaces captured **Stock-Date** rows grouped by **Code** and decorates each row with a **DiskStateBadge** ([inventory/DiskStateBadge.tsx](../../../frontend/src/inventory/DiskStateBadge.tsx)). When a row's state is anything other than `complete` (`source_partial`, `client_incomplete`, or `invalid`), the user has no in-page affordance to recover. Today the only path is:

1. Memorize the Code + date,
2. Navigate to the captures page,
3. Re-enter the symbol in **CaptureForm**,
4. Re-pick the same dates,
5. Submit — and remember to flip the "force re-capture source-partial" default if the abnormality is `source_partial`.

This is friction the inventory's own context could eliminate. The user already sees the broken row; the action should be at the row.

## Terminology

This spec does not introduce a new domain term. It composes three established compounds:

- **Abnormal Stock-Date** (introduced here, descriptive only) — a **Stock-Date** whose **DiskStateValue** is anything other than `complete`. Always derived, never persisted. Used in code as a one-line helper (`isAbnormal(state)`); never appears in API contracts. We deliberately avoid coining "AbnormalState" as a domain noun because the criterion is "not complete," not a positive identity — see CONTEXT.md guidance against negative-identity domain terms.
- **Retry** — the operation defined in [docs/superpowers/specs/2026-05-25-retry-failed-bulk-design.md](2026-05-25-retry-failed-bulk-design.md). Inventory re-capture is *not* a Retry. Retry operates on `_done`-bucket queue items via `POST /api/captures/items/retry`. Inventory re-capture operates on Stock-Dates on disk via the **Implicit Retry** path of `POST /api/captures/items` (ADR-0033). The two are siblings — different sources of truth (queue history vs. on-disk artifacts), one shared destination (a fresh queue item).
- **force_retry** — per CONTEXT.md, the flag that controls whether sentinels / partial raw artifacts are deleted before capture. This spec always sends `force_retry=true` from inventory; rationale below.

CONTEXT.md needs no update — all terms already exist.

## Goals

- One click re-captures every Abnormal Stock-Date in the visible Code's detail table.
- Checkbox selection allows the user to scope re-capture to a subset within the same Code.
- The row clears from inventory the moment its re-capture starts (SSE `inventory_removed`), reappears when it completes (`inventory_added`). No bespoke "re-capturing…" inventory UI.
- `complete` rows are never selectable (backend policy: `force_retry` does not bypass `COMPLETE` — [eligibility.py:76-77](../../../hoga/api/eligibility.py#L76-L77)).

## Non-Goals

- **Cross-Code bulk re-capture** from the left **StockDateGroupList** (e.g., "re-capture every abnormal row across every Code I've ever captured"). Separate spec; left-list selection model would be its own design.
- **Exposing a `force_retry` toggle** in the inventory action UI. Always-true is the only useful value here: `source_partial` *requires* it, and it is a no-op for `client_incomplete` (resume-mode capture deletes nothing) and `invalid` (fresh capture deletes the corrupt artifacts regardless of the flag's value, per `decide_capture`).
- **Re-capturing `complete` rows.** Backend policy disallows it today (per CONTEXT.md `Disk State Severity` and [eligibility.py:76-77](../../../hoga/api/eligibility.py#L76-L77)). If that policy ever changes, the UI change is "drop the abnormal-only filter" — one line.
- **New backend endpoints.** `POST /api/captures/items` with `dates: list[str]` and `force_retry: true` plus the ADR-0033 Implicit Retry path already does exactly what we need. Adding a new endpoint would duplicate dedupe/attempt logic.
- **Persisting selection across navigation.** Selection is ephemeral component state. Closing the detail panel, switching Codes, or reloading the page clears it.

## Design

### Backend

**No changes.** The flow uses existing primitives:

1. `POST /api/captures/items` with `{ code, dates, force_retry: true }`.
2. Each `(code, date)` collides with a `_done` row (the inventory artifact came from a prior `done` capture, otherwise no `meta.json`, otherwise no inventory row — see [api/types.ts:5](../../../frontend/src/api/types.ts#L5) comment on `DiskStateValue`).
3. ADR-0033 Implicit Retry branches on the existing `_done` row's `phase`:
   - `phase == 'done'` with `disk_state ∈ {source_partial, client_incomplete, invalid}` → backend dismisses the old `_done` row, enqueues a fresh attempt using the *request*'s `force_retry=true`. (See [captures.py:1112-1149](../../../hoga/api/captures.py#L1112-L1149).)
   - `phase == 'skipped'` with `skip_reason='source_partial'` and `force_retry=true` → same flow.
   - `phase == 'done'` with `disk_state == 'complete'` → deduped as `already_complete`. The frontend prevents this case by not surfacing checkboxes on `complete` rows, but the backend's defense-in-depth check still applies if a race lets a stale selection through.
4. SSE `capture_dismissed` removes the old `_done` row from any open queue view; SSE `capture_queued` adds the new attempt; eventually SSE `capture_finished` plus the existing `inventory_added` / `inventory_removed` events refresh `useStockDates` consumers.

The inventory page already subscribes to inventory SSE events: [api/sse.ts:78-79](../../../frontend/src/api/sse.ts#L78-L79) invalidates `STOCK_DATES_QUERY_KEY` on `inventory_added` / `inventory_removed`. No new subscriber is needed; the existing one re-fetches when rows arrive/depart.

### Frontend changes

#### New helper: `inventory/abnormal.ts`

```ts
import type { DiskStateValue } from '../api/types';

/** A Stock-Date is "abnormal" when its DiskState is anything other than complete.
 *  Used to gate inventory re-capture UI: only abnormal rows get a checkbox, and
 *  the bulk action operates only on these rows. Backend policy ([eligibility.py])
 *  disallows force_retry on COMPLETE, so the criterion is "not complete." */
export function isAbnormal(state: DiskStateValue): boolean {
  return state !== 'complete';
}
```

Tiny module with a clear domain hook. Keeps the predicate testable and lets consumers (the detail table, the action bar, possibly future cross-Code work) share one source of truth.

#### New component: `inventory/RecaptureActionBar.tsx`

A small presentation component that takes `{ abnormalCount, selectedCount, onRecaptureSelected, onRecaptureAll, onClearSelection, status }` and renders one of three states:

| Precondition | Rendered |
|---|---|
| `abnormalCount === 0` | nothing (caller renders the default header metadata) |
| `selectedCount === 0 && abnormalCount > 0` | `Re-capture all abnormal ({abnormalCount})` ghost button |
| `selectedCount > 0` | `{K} selected · [▶ Re-capture] [Clear]` |

The `status` slot renders an inline `Queued N capture(s) (M skipped)` success message or an `error` message under the bar; the parent owns the message lifecycle.

Visual style follows DESIGN.md tokens — `var(--accent)` for the primary action, `var(--fg-dim)` for the selection counter, `var(--error)` for failure. No new design tokens.

#### New hook: `inventory/useInventoryRecapture.ts`

Wraps `useCaptureQueue().addItems` to:

- Hold a small `status` state: `null | { kind: 'success', enqueued: number, skipped: number } | { kind: 'error', message: string }`.
- Auto-clear `status` 4 seconds after a success (timer reset on subsequent submits). On unmount, clear the timer.
- Provide `recapture(code, dates)` that calls `addItems.mutate({ code, dates, force_retry: true }, { onSuccess, onError })`.
- Map `EnqueueResponse.deduped` into the `skipped` count for the success message. The reasons (`already_in_queue` / `already_running` / `already_complete` / `already_skipped`) are not surfaced individually — a single "skipped" count is enough at the inventory grain.
- Map upstream-hint errors (the `enqueueErrorHints` already used by **CaptureForm**) into the same `inlineError` surface used elsewhere so the inventory error UI matches captures.

```ts
export function useInventoryRecapture() {
  const { addItems } = useCaptureQueue();
  const [status, setStatus] = useState<RecaptureStatus | null>(null);
  // ... timer management, recapture() implementation
  return { recapture, status, isPending: addItems.isPending };
}
```

#### Detail-panel changes: `StockDateGroupDetail.tsx`

Three additions, each scoped to one block:

1. **Selection state.** `const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())`. A `useEffect` on `selectedCode` clears the set. Selection survives sort changes (date keys are stable). On every render, the set is pruned for keys no longer present in `sortedDates.filter(isAbnormal)` — this handles the SSE-driven case where a previously-abnormal row becomes `complete` mid-selection.

2. **Checkbox column.** Add a leading `th` and `td`. The `td` for `complete` rows is an empty cell (no checkbox), preserving column alignment. The checkbox `onChange` toggles the date in the set; `e.stopPropagation()` keeps the existing row-click → /replay navigation intact.

3. **Header action bar.** Render `<RecaptureActionBar … />` in the existing header `<div>`, replacing the dates/vol/size metadata when selection is active and rendering alongside it otherwise. The metadata line is informational; the bar is action-oriented. Both compose in the same header without a layout overhaul.

A new `useInventoryRecapture()` invocation in the component wires the bar's callbacks:

- `onRecaptureSelected` → `recapture(group.code, [...selectedDates])`
- `onRecaptureAll` → `recapture(group.code, group.dates.filter(d => isAbnormal(d.disk_state)).map(d => d.date))`
- `onClearSelection` → `setSelectedDates(new Set())`

After a successful submit, the component clears the selection (`setSelectedDates(new Set())`). The status message stays for 4 seconds via the hook.

### Data flow

```
User selects rows or clicks "Re-capture all abnormal"
  └── StockDateGroupDetail
       └── useInventoryRecapture.recapture(code, dates)
            └── addItems.mutate({ code, dates, force_retry: true })
                 └── POST /api/captures/items
                      └── ADR-0033 Implicit Retry: dismiss old _done rows, enqueue new
                           ├── SSE capture_dismissed (queue page consumers update)
                           ├── SSE capture_queued (queue page consumers update)
                           ├── (eventually) SSE capture_finished
                           └── (eventually) SSE inventory_removed / inventory_added
                                └── useStockDates re-fetches; inventory rows update
```

The inventory page is a *consumer* of the SSE-driven inventory cache; it doesn't need to wire any new subscriber. We rely on `useStockDates`'s existing subscriber-as-source-of-truth. If that subscriber is missing, we are in an existing-bug state, not one this spec creates.

### Why `force_retry: true` always

Per `decide_capture` ([eligibility.py:74-89](../../../hoga/api/eligibility.py#L74-L89)):

| DiskState | `force_retry=true` | `force_retry=false` |
|---|---|---|
| `complete` | (filtered out by UI — backend would skip as `already_complete`) | same |
| `source_partial` | proceed (fresh capture) | skip with `source_partial` |
| `client_incomplete` | proceed (resume mode — flag is irrelevant) | same |
| `invalid` | proceed (fresh — flag is irrelevant) | same |
| `no_upstream_data` | (cannot appear in inventory — row would not exist) | same |

Always-true is the only value that recovers `source_partial` and is a no-op everywhere else we can reach. Exposing a toggle would invite a user to leave it off and quietly fail to recover their partial rows. We choose simplicity + correct default over fine-grained control.

## Edge Cases

- **User clicks "Re-capture all abnormal" while a previous batch is still pending.** The hook is not pending-guarded at the UI level (`addItems.isPending` is exposed). The bar disables its primary button when `isPending` is true; the React Query mutation queues nothing weird. Worst case: the second batch's `(code, date)` collide with the first batch's freshly-queued items and the backend returns them as `deduped: already_in_queue` — the success message surfaces the `skipped` count.

- **All abnormal rows in this Code are `source_partial` and the upstream is still partial.** The re-capture finishes as `source_partial` again. Inventory row reappears with the same badge. The user sees no progress; the next action is theirs. Out of scope to model "upstream-not-ready" as a separate inventory state.

- **A row's `disk_state` flips from `source_partial` to `complete` via SSE between selection and submit.** Two paths:
  - If the SSE arrives before submit, the prune-on-render logic drops the date from `selectedDates`. Submit excludes it.
  - If the SSE arrives during the in-flight POST, the backend hits the `already_complete` dedupe branch and returns it in `deduped`. The success message shows the skip count. No data corruption.

- **User navigates to another Code mid-pending.** `useEffect([selectedCode])` clears selection; in-flight mutation continues (React Query owns it). Status message is keyed to the *new* code's detail panel — the user might see a stale message on a new panel. Acceptable: the message is generic ("Queued 3 capture(s)") and the cost of routing it to the originating Code's view is disproportionate to the harm.

- **Empty `dates` array.** Bar callbacks compute the array; if the user managed to click `[▶ Re-capture]` with no selection (shouldn't be possible — the bar isn't rendered in that state) or if the "all" computation yields zero (shouldn't be possible — the bar isn't rendered when `abnormalCount === 0`), the hook guards by returning early. Backend would 400 anyway via the `missing_range` validator.

- **Concurrent re-captures from inventory and from CaptureForm for the same (code, date).** Whichever request hits the backend's `_lock` second sees the first in `_queue` or `_active` and is deduped. No corruption, expected behavior.

## Testing

### Unit

- `abnormal.test.ts` — `isAbnormal` returns `false` for `complete`, `true` for the other three.
- `useInventoryRecapture.test.tsx` —
  - On success with `deduped: []`, status becomes `{ kind: 'success', enqueued: N, skipped: 0 }`.
  - On success with `deduped: [...]`, status carries the correct `skipped` count.
  - On `enqueueErrorHints`-mapped API error, status is `{ kind: 'error', message: <hint> }`.
  - On generic error, status carries the error's `.message`.
  - Status auto-clears 4s after a success (use `vi.useFakeTimers`).
  - Timer is cancelled on unmount.

### Component

- `StockDateGroupDetail.test.tsx` extensions —
  - `complete` rows render no checkbox (assert by querying with the row's date as label).
  - Clicking a checkbox does not navigate (assert `useNavigate` mock not called).
  - With no selection and ≥1 abnormal row, header shows `Re-capture all abnormal ({N})`.
  - With ≥1 selection, header shows `{K} selected · ▶ Re-capture · Clear`.
  - Clicking `Re-capture all abnormal` calls `addItems` with `dates` equal to all abnormal dates in this group.
  - Clicking `Re-capture` with 2 selected dates calls `addItems` with those 2 dates.
  - After a successful submit, selection is cleared.
  - Changing `selectedCode` clears the selection.
  - When `disk_state` for a selected row flips to `complete` (simulate via prop change), the date is pruned from selection on next render.

- `RecaptureActionBar.test.tsx` — render branches for each of the three precondition cases; status slot renders success and error variants with correct token colors.

### Integration (manual smoke per [DESIGN.md])

1. Capture a known `source_partial` date (e.g., a Stock-Date you know is upstream-partial).
2. Open `/inventory`, select the Code, check the row.
3. Click `▶ Re-capture`. Confirm:
   - Inline `Queued 1 capture(s)` appears.
   - Within seconds, the row disappears (SSE `inventory_removed`).
   - When the capture finishes, the row reappears (`inventory_added`) — possibly with the same `source_partial` state if upstream is still partial.
4. Switch to a different Code; confirm selection is cleared.

## Out of Scope

- Cross-Code bulk action from the left `StockDateGroupList`.
- Selection persistence across navigation or page reloads.
- A `force_retry` toggle in inventory UI.
- Filtering the detail table to show only abnormal rows (sort by State already lets the user surface them).
- Per-row "re-capture this one" button. The checkbox + bar covers single-row submit (check one, click `[▶ Re-capture]`); a separate button would be one extra UI affordance for no new capability.
- An attempt counter / re-capture-attempts badge on inventory rows. The queue page's `×N` badge already shows attempts for the *queue item*. Inventory rows are the end state; attempts belong to the queue.
- Sorting by selection state. Sort is independent.

## Open Questions

None — captured above as decisions.

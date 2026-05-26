# Inventory Per-Row Re-Capture — Icon-Driven, In-Flight Aware

**Status:** Draft
**Date:** 2026-05-26
**Owner:** inventory UX
**Predecessor:** [2026-05-26-inventory-recapture-design.md](2026-05-26-inventory-recapture-design.md)

## Problem

The previous Inventory re-capture design shipped a multi-select checkbox model:
per-row checkboxes, a "K selected · ▶ Re-capture · Clear" action bar mode, plus
a header bulk action `Re-capture all incomplete (N)`. Field feedback after one
session of use:

1. **Checkboxes feel wrong for this task.** Users almost always re-capture *one
   broken row at a time* — the multi-select interaction overhead is borrowed
   from list-management UIs (mail, file picker), but here the natural verb is
   "fix this one." Two clicks (check + ▶) where one would do.

2. **Header bulk action looks passive.** Styled as a faint ghost link
   (`text-fg-dim`), it reads as a label, not an affordance. Users miss it.

3. **No in-flight feedback on the inventory page.** Once a re-capture is
   queued, the user has to navigate to `/capture` to see anything happen. The
   inventory row gives no signal that "work is now in progress for this row."

4. **No origin signal on the queue page.** `/capture` shows in-flight items
   but does not distinguish "I queued this from a CaptureForm date range"
   from "I clicked refresh on a single inventory row." Useful as the queue
   grows mixed.

5. **NIT carryover.** `RecaptureActionBar`'s tooltip
   `title="source partial · client incomplete · invalid"` is a hardcoded
   string that desyncs silently if a new `DiskStateValue` is added.

## Terminology

No new domain terms. UI labels:

- **Refresh icon** (`↻`) — the per-row affordance replacing the checkbox. UI verb is "re-capture this row." The icon is the established "retry/re-capture" glyph already used by `CaptureQueueRow`'s per-row retry button ([CaptureQueueRow.tsx:87](../../../frontend/src/capture/CaptureQueueRow.tsx#L87)) — same glyph, same semantics, different source of truth (inventory disk-state vs queue history).
- **Origin badge** — small UI marker on a `CaptureQueueRow` indicating the queue item was triggered from inventory rather than CaptureForm. Not a domain noun; lives entirely client-side.

## Goals

- One click re-captures one row. Refresh icon visible only for non-complete rows; complete rows have no affordance (backend policy).
- Header bulk button reads visually as an interactive primary affordance (uses an accent token, hover state, not a faint label).
- Inventory rows currently in-flight (their `(code, date)` matches a `queue.active ∪ queue.queued` entry) show a spin animation on the icon and disable the click — single SSOT for "is this in-flight?" via `useCaptureQueue`.
- Capture queue rows that came from inventory show a small `from inventory` badge next to the existing `force` / `×N` badges.
- Tooltip on the header bulk button is derived from `DiskStateValue` union via a single source-of-truth array, so adding a new state does not silently desync.

## Non-Goals

- **Multi-select.** Removed entirely — `useRecaptureSelection` hook, `RecaptureActionBar` selection mode, and all selection-mode tests deleted.
- **Backend `origin` field on `QueueItem`.** Origin tracking lives in the frontend (a small Zustand-style store keyed by `item_id`). Backend stays single-source-of-truth for the queue itself; origin is purely UI-side metadata. Trade-off accepted: page reload loses badges, which is fine for a single-user local tool.
- **Cancel-from-inventory UX.** The capture page's existing `✕` button cancels queue items. We don't duplicate that affordance on the inventory side.
- **Origin persistence.** No localStorage / IndexedDB. The badge lives for the session.
- **Per-row attempt counter on inventory.** The queue already shows `×N` on the queue row; replicating it on inventory adds noise.

## Design

### Backend

**No changes.** All capabilities are present from the previous spec + ADR-0035.

### Frontend changes — overview

| File | Change |
|---|---|
| [inventory/DiskStateBadge.tsx](../../../frontend/src/inventory/DiskStateBadge.tsx) | Export `RECAPTURABLE_DISK_STATES: readonly DiskStateValue[]` SSOT array. `isRecapturable` derived from it for consistency. |
| [inventory/StockDateGroupDetail.tsx](../../../frontend/src/inventory/StockDateGroupDetail.tsx) | Drop `useRecaptureSelection`. Per-row refresh-icon column replaces checkbox column. Reads `queue` from `useCaptureQueue` to derive per-row in-flight state. |
| [inventory/RecaptureActionBar.tsx](../../../frontend/src/inventory/RecaptureActionBar.tsx) | Remove selection mode. Bulk button restyled to accent affordance. Tooltip derived from `RECAPTURABLE_DISK_STATES` + a presentation-label mapping (no hardcoded string). |
| `inventory/useInventoryRecaptureOrigins.ts` (**new**) | Tiny Zustand store: `Set<string>` of item_ids, with `add(ids)`, `has(id)`, `clear()`. |
| [inventory/useInventoryRecapture.ts](../../../frontend/src/inventory/useInventoryRecapture.ts) | On successful `addItems` response, push `enqueued.map(i => i.item_id)` into the origins store. |
| [inventory/useRecaptureSelection.ts](../../../frontend/src/inventory/useRecaptureSelection.ts) | **DELETED** along with its tests. |
| [capture/CaptureQueueRow.tsx](../../../frontend/src/capture/CaptureQueueRow.tsx) | Read origin store; render `from inventory` badge next to `force` / `×N` when the item_id is in the set. |

### `RECAPTURABLE_DISK_STATES` SSOT

In `DiskStateBadge.tsx`, next to `STATE_SEVERITY`:

```ts
/** The non-complete DiskStates a user can re-capture. Order is presentational
 *  (used to build the tooltip "source partial · client incomplete · invalid").
 *  Single source of truth for both isRecapturable and the bar's tooltip. */
export const RECAPTURABLE_DISK_STATES: readonly DiskStateValue[] = [
  'source_partial',
  'client_incomplete',
  'invalid',
];

export function isRecapturable(state: DiskStateValue): boolean {
  return (RECAPTURABLE_DISK_STATES as readonly DiskStateValue[]).includes(state);
}
```

Adding a new `DiskStateValue` to `api/types.ts` no longer requires touching the bar's tooltip — the developer adds it to this array (or doesn't, if it shouldn't be recapturable) and both UI surfaces flow from there. The existing `PRESENTATION` mapping in `DiskStateBadge.tsx` provides the human label per state.

### Per-row refresh icon column

In `StockDateGroupDetail.tsx`, the leading column changes from a checkbox column to an icon column:

```tsx
<td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
  {isRecapturable(r.disk_state) ? (
    <RowRecaptureButton
      isInFlight={inFlightSet.has(`${r.code}|${r.date}`)}
      onClick={() => recapture(group.code, [r.date])}
    />
  ) : null}
</td>
```

`RowRecaptureButton` is a small in-file (or sibling-file) component:

```tsx
function RowRecaptureButton({ isInFlight, onClick }: { isInFlight: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={isInFlight ? 'Re-capturing…' : 'Re-capture this Stock-Date'}
      disabled={isInFlight}
      onClick={onClick}
      className={[
        'bg-transparent border-none cursor-pointer text-sm p-0',
        isInFlight
          ? 'text-fg-dim animate-spin cursor-not-allowed'
          : 'text-accent hover:text-fg',
      ].join(' ')}
    >
      ↻
    </button>
  );
}
```

`animate-spin` is a Tailwind utility (project already uses Tailwind — verify exists at implementation time; if not, define a small `@keyframes spin` in a CSS module).

### In-flight derivation

`StockDateGroupDetail` reads `queue` from `useCaptureQueue()`:

```ts
const { queue } = useCaptureQueue();
const inFlightSet = useMemo(() => {
  const s = new Set<string>();
  if (!queue) return s;
  for (const i of queue.active) s.add(`${i.code}|${i.date}`);
  for (const i of queue.queued) s.add(`${i.code}|${i.date}`);
  return s;
}, [queue]);
```

Note: `queue` updates via SSE-driven React Query invalidations (existing infrastructure from [useCaptureQueue.ts](../../../frontend/src/capture/useCaptureQueue.ts)). No new subscriber.

### Header bulk button restyle

Current ghost link → accent-tinted ghost button. Pattern:

```tsx
<button
  type="button"
  disabled={isPending}
  title={recapturableTooltip()}  // derived from RECAPTURABLE_DISK_STATES + PRESENTATION
  onClick={onRecaptureAll}
  className="rounded-md px-2.5 py-1 font-semibold cursor-pointer disabled:cursor-not-allowed border bg-bg-input border-accent text-accent hover:bg-accent hover:text-bg"
>
  ↻ Re-capture all incomplete ({recapturableCount})
</button>
```

`recapturableTooltip()` is a helper in `RecaptureActionBar.tsx`:

```ts
function recapturableTooltip(): string {
  return RECAPTURABLE_DISK_STATES.map(s => PRESENTATION_LABEL[s]).join(' · ');
}
```

`PRESENTATION_LABEL` exports the human-readable string per state from `DiskStateBadge.tsx` (extract from the existing `PRESENTATION` mapping's `label` field, or add a small re-export).

### `RecaptureActionBar` simplification

After removing selection mode, the component reduces to:

```tsx
export function RecaptureActionBar({
  recapturableCount,
  onRecaptureAll,
  status,
  isPending,
}: Props) {
  if (recapturableCount === 0 && status === null) return null;
  return (
    <div className="flex flex-col gap-1 text-xs">
      {recapturableCount > 0 && (
        <button … >↻ Re-capture all incomplete ({recapturableCount})</button>
      )}
      {status?.kind === 'success' && (
        <div className="text-fg-dim font-mono tabular-nums">
          Queued {status.enqueued} capture{status.enqueued === 1 ? '' : 's'}
          {status.skipped > 0 && ` (${status.skipped} skipped)`}
        </div>
      )}
      {status?.kind === 'error' && (
        <div role="alert" style={{ color: 'var(--error)' }}>{status.message}</div>
      )}
    </div>
  );
}
```

Removed props: `selectedCount`, `onRecaptureSelected`, `onClearSelection`. Caller updates accordingly.

### Origins store

`inventory/useInventoryRecaptureOrigins.ts`:

```ts
import { create } from 'zustand';

interface OriginsState {
  ids: Set<string>;
  add: (ids: string[]) => void;
  has: (id: string) => boolean;
  clear: () => void;
}

export const useInventoryRecaptureOrigins = create<OriginsState>((set, get) => ({
  ids: new Set(),
  add: (ids) => set((s) => {
    const next = new Set(s.ids);
    for (const id of ids) next.add(id);
    return { ids: next };
  }),
  has: (id) => get().ids.has(id),
  clear: () => set({ ids: new Set() }),
}));
```

Verify Zustand is already a dependency (CONTEXT.md mentions `useTabsStore` which is Zustand-based — should be present).

`useInventoryRecapture.ts` integration — after the existing success path:

```ts
const resp: EnqueueResponse = await addItems.mutateAsync({ … });
useInventoryRecaptureOrigins.getState().add(resp.enqueued.map(i => i.item_id));
setStatus({ kind: 'success', enqueued: resp.enqueued.length, skipped: resp.deduped.length });
```

### `CaptureQueueRow` origin badge

In `CaptureQueueRow.tsx`, next to the existing `force` and `×N` badges (around lines 45-57):

```tsx
const isFromInventory = useInventoryRecaptureOrigins((s) => s.ids.has(item.item_id));
// …
{isFromInventory && (
  <span
    title="Triggered from inventory re-capture"
    className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--fg-dim)] text-fg-dim"
  >📦 inventory</span>
)}
```

Tone: informational, not warning. Matches the `×N` attempt badge's visual weight.

## Data flow

```
User clicks ↻ on inventory row
  └── StockDateGroupDetail
       └── recapture(code, [row.date])
            └── useInventoryRecapture
                 ├── addItems.mutateAsync({force_retry: true})
                 │    └── POST /api/captures/items
                 │         └── ADR-0033/0035 Implicit Retry: enqueue with attempt+1
                 │              └── Response.enqueued: [{ item_id, … }]
                 ├── useInventoryRecaptureOrigins.add([item_id])  // origin marked
                 └── setStatus({ kind: 'success', … })

SSE capture_queued
  └── useCaptureQueue invalidates queue cache
       ├── queue.queued grows → inFlightSet recomputed → row icon spins
       └── CaptureQueueRow rendered (if /capture page open) with origin badge

SSE capture_progress / capture_phase
  └── queue.active updates → row icon keeps spinning

SSE capture_finished
  └── queue.active removes item → inFlightSet excludes → row icon stops spinning
  └── SSE inventory_added / inventory_removed → useStockDates invalidated
       └── row re-renders with new disk_state; if complete, icon disappears entirely
```

## Edge cases

- **Double-click on the icon.** Second click is no-op because the button is `disabled` while `isInFlight`. If somehow it slips through (e.g., before the queue cache updates), backend dedupe responds with `deduped: [{ reason: 'already_in_queue' }]` and status shows `(1 skipped)`. No corruption.

- **Multiple rapid refresh clicks across rows.** Each fires its own `recapture(code, [date])`. The store accumulates item_ids without bound; the queue advances at `HOGA_MAX_CONCURRENT`. Reasonable behavior — no rate limiting on inventory side.

- **A row's `disk_state` flips to `complete` while it's still in `queue.done`.** SSE removes the row from inventory; the icon disappears. The queue page may still show the origin badge for the just-finished item until the user clears the done bucket.

- **Page reload mid-flight.** Origin store empties. The queue itself persists (ADR-0019); the inventory row's in-flight derivation still works (it reads live queue state). Only the badge disappears. Documented as acceptable.

- **Origin store growth.** The store accumulates item_ids for the lifetime of the page tab. For a single-user local tool with hundreds-of-items-per-session max, this is bounded enough not to warrant cleanup. If a user runs hours-long sessions with thousands of inventory re-captures, the set is still ~50 bytes per id × N — negligible vs the React Query cache. `clear()` exists on the store but is not called automatically; could be wired to `dismissDone` (which empties `_done`) as a future tidy, intentionally deferred here.

- **CaptureForm submit collides with an in-flight inventory re-capture.** Same `(code, date)` is in `queue.active`. CaptureForm gets `deduped: 'already_running'`. No change for this spec.

- **`useCaptureQueue()` is now consumed by two distant components** (`CaptureQueue` and `StockDateGroupDetail`). React Query dedupes the underlying query, but the SSE subscriber in `useCaptureQueue`'s `useEffect` would now fire twice. Verify at implementation time: if double-subscription occurs, move the subscriber up the component tree (e.g., to `App.tsx` or a context provider) and have hook consumers read cache only. Documented as a watch-out, not a blocker — single-user local tool, two subscribers is benign for correctness, just wastes a connection.

## Testing

### Unit

- `DiskStateBadge.test.tsx` (extension) — `RECAPTURABLE_DISK_STATES` excludes `complete` and includes the other three. `isRecapturable` derived from it.
- `useInventoryRecapture.test.tsx` (extension) — successful submit pushes the returned item_ids into `useInventoryRecaptureOrigins`.
- `useInventoryRecaptureOrigins.test.ts` — new. `add`, `has`, `clear`. Multiple add calls accumulate without duplication.

### Component

- `StockDateGroupDetail.test.tsx` (extensive rewrite):
  - DELETE all selection-mode tests (no checkboxes anymore).
  - `complete` rows have no refresh icon.
  - Clicking the refresh icon calls `addItems` once with `{code, dates: [r.date], force_retry: true}`.
  - Clicking the icon does not trigger `useNavigate`.
  - When `useCaptureQueue` returns a queue containing `(code, date)` matching a row, the row's icon has `aria-label="Re-capturing…"`, is `disabled`, and has `animate-spin` class.
  - Header bulk button: visible when `recapturableCount > 0`, dispatches `addItems` with all recapturable dates.
- `RecaptureActionBar.test.tsx`:
  - Selection-mode tests REMOVED.
  - Bulk button renders with correct count and label `↻ Re-capture all incomplete ({N})`.
  - Bulk button tooltip equals `RECAPTURABLE_DISK_STATES` joined with the presentation labels.
  - `recapturableCount === 0 && status === null` → renders null.
- `CaptureQueueRow.test.tsx`:
  - When `item_id` is in the origins store, `from inventory` badge is rendered.
  - When `item_id` is not in the store, no badge.

### Integration (manual smoke)

1. Open `/inventory`, find a `source_partial` row, click ↻.
2. Confirm:
   - Icon immediately becomes a spinning ↻ (or `aria-disabled`).
   - Header inline message `Queued 1 capture` appears under the bulk button.
3. Navigate to `/capture`. The corresponding queue row shows `from inventory` badge.
4. Wait for `capture_finished`. Inventory row's icon stops spinning; if disk_state is now `complete`, row no longer has an icon (or the row is gone, depending on SSE behavior).
5. Reload `/inventory`. The `from inventory` badge on `/capture` is gone (acceptable). The queue row itself persists.

## Out of Scope

- Backend `origin` field on `QueueItem` (deferred indefinitely; single-user local tool).
- LocalStorage persistence of origin set.
- An "Inventory" filter on `/capture` page.
- Cancel-from-inventory UI.
- Per-row inline progress (the user navigates to `/capture` for detailed progress; the icon spin is the inventory-side signal that work is happening).
- Migration of `useCaptureQueue`'s SSE subscriber to a higher-level provider — flagged as a watch-out in Edge Cases, executed only if double-subscription causes observable problems.

## Open Questions

None — captured above as decisions.

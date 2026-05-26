# Inventory Per-Row Re-Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the checkbox+selection inventory re-capture UI with a per-row refresh icon (immediate trigger), restyle the bulk action to read as a primary affordance, surface in-flight state on inventory rows via `useCaptureQueue`, and tag inventory-triggered queue items with an `inventory` badge on the `/capture` page.

**Architecture:** All changes are frontend-only — backend already supports `force_retry=true` on `/api/captures/items` (ADR-0033 + ADR-0035). One new file (`useInventoryRecaptureOrigins.ts` — Zustand store for client-side origin tracking). One file deleted (`useRecaptureSelection.ts` — superseded by per-row trigger). Five existing files modified. In-flight detection is derived from `useCaptureQueue().queue` so SSE-driven updates are automatic.

**Tech Stack:** React 18 / TypeScript / Vitest / Testing Library / Zustand v4 / React Query (all already in the codebase).

**Spec:** [docs/superpowers/specs/2026-05-26-inventory-per-row-recapture-design.md](../specs/2026-05-26-inventory-per-row-recapture-design.md)

---

## File Map

**Modified:**
- `frontend/src/inventory/DiskStateBadge.tsx` — add `RECAPTURABLE_DISK_STATES` SSOT; rewrite `isRecapturable` as derived
- `frontend/src/inventory/DiskStateBadge.test.tsx` — assert SSOT + derived predicate
- `frontend/src/inventory/useInventoryRecapture.ts` — push enqueued item_ids into origins store
- `frontend/src/inventory/useInventoryRecapture.test.tsx` — extend with origin-store assertion
- `frontend/src/inventory/RecaptureActionBar.tsx` — drop selection mode, derive tooltip, restyle to accent
- `frontend/src/inventory/RecaptureActionBar.test.tsx` — remove selection-mode tests, add tooltip + restyle tests
- `frontend/src/inventory/StockDateGroupDetail.tsx` — refresh-icon column, in-flight derivation, drop selection prop wiring
- `frontend/src/inventory/StockDateGroupDetail.test.tsx` — remove selection tests, add icon + in-flight tests
- `frontend/src/capture/CaptureQueueRow.tsx` — render `inventory` badge from origins store
- `frontend/src/capture/CaptureQueueRow.test.tsx` (extend or create — verify in Task 7) — badge presence/absence

**Created:**
- `frontend/src/inventory/useInventoryRecaptureOrigins.ts` — Zustand store
- `frontend/src/inventory/useInventoryRecaptureOrigins.test.ts` — store unit tests

**Deleted:**
- `frontend/src/inventory/useRecaptureSelection.ts`
- `frontend/src/inventory/useRecaptureSelection.test.tsx`

---

## Task 1 — `RECAPTURABLE_DISK_STATES` SSOT + derived predicate

**Files:**
- Modify: `frontend/src/inventory/DiskStateBadge.tsx`
- Modify: `frontend/src/inventory/DiskStateBadge.test.tsx`

### Step 1.1: Extend the test to assert the new SSOT array

- [ ] **Step 1.1.1: Open `frontend/src/inventory/DiskStateBadge.test.tsx` and add to its imports**

Find the existing import line near the top:

```ts
import { aggregateDiskState, isRecapturable, STATE_SEVERITY } from './DiskStateBadge';
```

Replace with:

```ts
import {
  aggregateDiskState,
  isRecapturable,
  RECAPTURABLE_DISK_STATES,
  STATE_SEVERITY,
} from './DiskStateBadge';
```

- [ ] **Step 1.1.2: Append a new `describe` block at the end of the file**

```ts
describe('RECAPTURABLE_DISK_STATES', () => {
  it('excludes complete', () => {
    expect(RECAPTURABLE_DISK_STATES).not.toContain('complete');
  });
  it('includes source_partial, client_incomplete, invalid', () => {
    expect(RECAPTURABLE_DISK_STATES).toEqual(
      expect.arrayContaining(['source_partial', 'client_incomplete', 'invalid']),
    );
    expect(RECAPTURABLE_DISK_STATES).toHaveLength(3);
  });
  it('is the source of truth — isRecapturable derives from it', () => {
    for (const s of RECAPTURABLE_DISK_STATES) {
      expect(isRecapturable(s)).toBe(true);
    }
    expect(isRecapturable('complete')).toBe(false);
  });
});
```

- [ ] **Step 1.1.3: Run — expect FAIL**

```bash
cd frontend && npx vitest run src/inventory/DiskStateBadge.test.tsx
```

Expected: TS/import error — `RECAPTURABLE_DISK_STATES` not exported.

### Step 1.2: Add the SSOT array and rewrite `isRecapturable`

- [ ] **Step 1.2.1: Edit `frontend/src/inventory/DiskStateBadge.tsx`**

Find the current `isRecapturable` block (added in the previous spec's Task 2). It currently reads:

```tsx
/** A captured Stock-Date is recapturable when its DiskState is anything other
 *  than complete. ... */
export function isRecapturable(state: DiskStateValue): boolean {
  return state !== 'complete';
}
```

Replace with:

```tsx
/** The non-complete DiskStates a user can re-capture. Order is presentational
 *  (used to build tooltips like "source partial · client incomplete · invalid").
 *  Single source of truth: both `isRecapturable` and `RecaptureActionBar`'s
 *  tooltip flow from this list. Adding a new non-complete DiskStateValue means
 *  adding it here once. */
export const RECAPTURABLE_DISK_STATES: readonly DiskStateValue[] = [
  'source_partial',
  'client_incomplete',
  'invalid',
];

/** A captured Stock-Date is recapturable when its DiskState appears in
 *  RECAPTURABLE_DISK_STATES (everything except complete). Backend policy
 *  (eligibility.py:76-77) skips COMPLETE even with force_retry=true. */
export function isRecapturable(state: DiskStateValue): boolean {
  return (RECAPTURABLE_DISK_STATES as readonly DiskStateValue[]).includes(state);
}
```

- [ ] **Step 1.2.2: Run — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/DiskStateBadge.test.tsx
```

Expected: all tests pass (existing + new `RECAPTURABLE_DISK_STATES` block).

### Step 1.3: Commit

- [ ] **Step 1.3.1: Stage and commit**

```bash
git add frontend/src/inventory/DiskStateBadge.tsx frontend/src/inventory/DiskStateBadge.test.tsx
git commit -m "feat(inventory): RECAPTURABLE_DISK_STATES SSOT for predicate + tooltip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Origins store (Zustand)

**Files:**
- Create: `frontend/src/inventory/useInventoryRecaptureOrigins.ts`
- Create: `frontend/src/inventory/useInventoryRecaptureOrigins.test.ts`

### Step 2.1: Write the failing tests

- [ ] **Step 2.1.1: Create `frontend/src/inventory/useInventoryRecaptureOrigins.test.ts`**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useInventoryRecaptureOrigins } from './useInventoryRecaptureOrigins';

beforeEach(() => {
  useInventoryRecaptureOrigins.getState().clear();
});

describe('useInventoryRecaptureOrigins', () => {
  it('starts empty', () => {
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(0);
  });

  it('add() inserts ids into the set', () => {
    useInventoryRecaptureOrigins.getState().add(['a', 'b']);
    const { ids, has } = useInventoryRecaptureOrigins.getState();
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
    expect(has('a')).toBe(true);
    expect(has('c')).toBe(false);
  });

  it('add() preserves prior ids (accumulates)', () => {
    useInventoryRecaptureOrigins.getState().add(['a']);
    useInventoryRecaptureOrigins.getState().add(['b']);
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(2);
  });

  it('add() is idempotent for duplicate ids', () => {
    useInventoryRecaptureOrigins.getState().add(['a', 'a', 'b']);
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(2);
  });

  it('clear() empties the set', () => {
    useInventoryRecaptureOrigins.getState().add(['a', 'b']);
    useInventoryRecaptureOrigins.getState().clear();
    expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(0);
  });

  it('add() with empty array is a no-op (does not create a new ids reference)', () => {
    const before = useInventoryRecaptureOrigins.getState().ids;
    useInventoryRecaptureOrigins.getState().add([]);
    const after = useInventoryRecaptureOrigins.getState().ids;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2.1.2: Run — expect FAIL (module does not exist)**

```bash
cd frontend && npx vitest run src/inventory/useInventoryRecaptureOrigins.test.ts
```

Expected: cannot resolve module.

### Step 2.2: Implement the store

- [ ] **Step 2.2.1: Create `frontend/src/inventory/useInventoryRecaptureOrigins.ts`**

```ts
import { create } from 'zustand';

/** Client-side set of QueueItem ids that were enqueued via inventory
 *  re-capture (vs. CaptureForm). Drives the `inventory` badge on
 *  CaptureQueueRow. Per the spec, this lives entirely in memory — page
 *  reload loses the set, which is acceptable for a single-user local tool. */
export interface OriginsState {
  ids: Set<string>;
  add: (newIds: string[]) => void;
  has: (id: string) => boolean;
  clear: () => void;
}

export const useInventoryRecaptureOrigins = create<OriginsState>((set, get) => ({
  ids: new Set(),
  add: (newIds) => {
    if (newIds.length === 0) return;
    set((s) => {
      const next = new Set(s.ids);
      for (const id of newIds) next.add(id);
      return { ids: next };
    });
  },
  has: (id) => get().ids.has(id),
  clear: () => set({ ids: new Set() }),
}));
```

- [ ] **Step 2.2.2: Run — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/useInventoryRecaptureOrigins.test.ts
```

Expected: all 6 tests pass.

### Step 2.3: Commit

- [ ] **Step 2.3.1: Stage and commit**

```bash
git add frontend/src/inventory/useInventoryRecaptureOrigins.ts frontend/src/inventory/useInventoryRecaptureOrigins.test.ts
git commit -m "feat(inventory): client-side origins store for inventory-triggered queue items

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Wire `useInventoryRecapture` to the origins store

**Files:**
- Modify: `frontend/src/inventory/useInventoryRecapture.ts`
- Modify: `frontend/src/inventory/useInventoryRecapture.test.tsx`

### Step 3.1: Add the failing assertion

- [ ] **Step 3.1.1: Open `frontend/src/inventory/useInventoryRecapture.test.tsx`. Add this import near the top**

```ts
import { useInventoryRecaptureOrigins } from './useInventoryRecaptureOrigins';
```

- [ ] **Step 3.1.2: Add to the existing `beforeEach`**

The file already has a `beforeEach(() => { vi.restoreAllMocks(); })`. Replace with:

```ts
beforeEach(() => {
  vi.restoreAllMocks();
  useInventoryRecaptureOrigins.getState().clear();
});
```

- [ ] **Step 3.1.3: Append a new test at the end of the `describe('useInventoryRecapture', () => {...})` block**

```ts
it('pushes enqueued item_ids into the origins store on success', async () => {
  setupFetch({
    enqueued: [{ item_id: 'item-a' }, { item_id: 'item-b' }],
    deduped: [],
  });
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

  await act(async () => { await result.current.recapture('005930', ['20260520']); });

  const ids = useInventoryRecaptureOrigins.getState().ids;
  expect(ids.has('item-a')).toBe(true);
  expect(ids.has('item-b')).toBe(true);
});

it('does not push to origins store on error', async () => {
  setupFetch({ detail: { code: 'krx_credentials_missing', message: 'no creds' } }, 503);
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const { result } = renderHook(() => useInventoryRecapture(), { wrapper: wrapper(qc) });

  await act(async () => {
    try { await result.current.recapture('005930', ['20260520']); }
    catch { /* status reflects the error; we read the store */ }
  });

  expect(useInventoryRecaptureOrigins.getState().ids.size).toBe(0);
});
```

- [ ] **Step 3.1.4: Run — expect FAIL on the new test**

```bash
cd frontend && npx vitest run src/inventory/useInventoryRecapture.test.tsx
```

Expected: first new test fails (`ids.has('item-a')` is `false` because hook doesn't push yet).

### Step 3.2: Wire the hook

- [ ] **Step 3.2.1: Edit `frontend/src/inventory/useInventoryRecapture.ts`**

Add import near the top:

```ts
import { useInventoryRecaptureOrigins } from './useInventoryRecaptureOrigins';
```

In the `recapture` callback, find this block:

```ts
const resp: EnqueueResponse = await addItems.mutateAsync({
  code,
  dates,
  force_retry: true,
});
setStatus({
  kind: 'success',
  enqueued: resp.enqueued.length,
  skipped: resp.deduped.length,
});
```

Insert one line between the mutateAsync and the setStatus:

```ts
const resp: EnqueueResponse = await addItems.mutateAsync({
  code,
  dates,
  force_retry: true,
});
useInventoryRecaptureOrigins.getState().add(resp.enqueued.map((i) => i.item_id));
setStatus({
  kind: 'success',
  enqueued: resp.enqueued.length,
  skipped: resp.deduped.length,
});
```

- [ ] **Step 3.2.2: Run — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/useInventoryRecapture.test.tsx
```

Expected: all tests pass.

### Step 3.3: Commit

- [ ] **Step 3.3.1: Stage and commit**

```bash
git add frontend/src/inventory/useInventoryRecapture.ts frontend/src/inventory/useInventoryRecapture.test.tsx
git commit -m "feat(inventory): record inventory-triggered queue items in origins store

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Simplify `RecaptureActionBar` (drop selection, derived tooltip, accent restyle)

**Files:**
- Modify: `frontend/src/inventory/RecaptureActionBar.tsx`
- Modify: `frontend/src/inventory/RecaptureActionBar.test.tsx`

### Step 4.1: Rewrite the test file

- [ ] **Step 4.1.1: REPLACE the entire contents of `frontend/src/inventory/RecaptureActionBar.test.tsx`**

The old file tests selection mode; that's gone. Full replacement:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecaptureActionBar } from './RecaptureActionBar';
import { RECAPTURABLE_DISK_STATES } from './DiskStateBadge';

const baseProps = {
  recapturableCount: 3,
  onRecaptureAll: () => {},
  status: null,
  isPending: false,
};

describe('RecaptureActionBar', () => {
  it('renders nothing when count is 0 and no status', () => {
    const { container } = render(
      <RecaptureActionBar {...baseProps} recapturableCount={0} status={null} />,
    );
    expect(container.textContent).toBe('');
  });

  it('shows "Re-capture all incomplete (N)" with refresh icon when count > 0', () => {
    render(<RecaptureActionBar {...baseProps} recapturableCount={3} />);
    expect(screen.getByRole('button', { name: /Re-capture all incomplete \(3\)/i })).toBeTruthy();
  });

  it('button tooltip is derived from RECAPTURABLE_DISK_STATES (no hardcoded string)', () => {
    render(<RecaptureActionBar {...baseProps} recapturableCount={3} />);
    const btn = screen.getByRole('button', { name: /Re-capture all incomplete/i });
    const expected = RECAPTURABLE_DISK_STATES.map((s) => s.replace(/_/g, ' ')).join(' · ');
    expect(btn.getAttribute('title')).toBe(expected);
  });

  it('clicking the button calls onRecaptureAll', () => {
    const onAll = vi.fn();
    render(<RecaptureActionBar {...baseProps} onRecaptureAll={onAll} />);
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete/i }));
    expect(onAll).toHaveBeenCalledTimes(1);
  });

  it('button is disabled while isPending', () => {
    render(<RecaptureActionBar {...baseProps} isPending={true} />);
    const btn = screen.getByRole('button', { name: /Re-capture all incomplete/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('renders success status when present', () => {
    render(
      <RecaptureActionBar
        {...baseProps}
        status={{ kind: 'success', enqueued: 2, skipped: 1 }}
      />,
    );
    expect(screen.getByText(/Queued 2 capture/)).toBeTruthy();
    expect(screen.getByText(/1 skipped/)).toBeTruthy();
  });

  it('renders error status with role=alert', () => {
    render(
      <RecaptureActionBar
        {...baseProps}
        status={{ kind: 'error', message: 'something broke' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('something broke');
  });

  it('renders ONLY status when count is 0 but status is present', () => {
    render(
      <RecaptureActionBar
        {...baseProps}
        recapturableCount={0}
        status={{ kind: 'success', enqueued: 1, skipped: 0 }}
      />,
    );
    // button is gone, but the status is rendered.
    expect(screen.queryByRole('button', { name: /Re-capture all incomplete/i })).toBeNull();
    expect(screen.getByText(/Queued 1 capture/)).toBeTruthy();
  });
});
```

- [ ] **Step 4.1.2: Run — expect FAIL (component still has old shape)**

```bash
cd frontend && npx vitest run src/inventory/RecaptureActionBar.test.tsx
```

Expected: type errors (props mismatch — old component still expects `selectedCount`, etc.).

### Step 4.2: Rewrite the component

- [ ] **Step 4.2.1: REPLACE the entire contents of `frontend/src/inventory/RecaptureActionBar.tsx`**

```tsx
import type { RecaptureStatus } from './useInventoryRecapture';
import { RECAPTURABLE_DISK_STATES } from './DiskStateBadge';

export type { RecaptureStatus };

type Props = {
  recapturableCount: number;
  onRecaptureAll: () => void;
  status: RecaptureStatus | null;
  isPending: boolean;
};

/** Short tooltip derived from the DiskStateValue strings themselves —
 *  "source partial · client incomplete · invalid". Per the spec, this avoids
 *  the verbose PRESENTATION labels (which include em-dash explanations) and
 *  the hardcoded-string footgun. */
function recapturableTooltip(): string {
  return RECAPTURABLE_DISK_STATES.map((s) => s.replace(/_/g, ' ')).join(' · ');
}

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
        <button
          type="button"
          disabled={isPending}
          title={recapturableTooltip()}
          onClick={onRecaptureAll}
          className="rounded-md px-2.5 py-1 font-semibold cursor-pointer disabled:cursor-not-allowed border bg-bg-input border-accent text-accent hover:bg-accent hover:text-bg"
        >
          ↻ Re-capture all incomplete ({recapturableCount})
        </button>
      )}
      {status?.kind === 'success' && (
        <div className="text-fg-dim font-mono tabular-nums">
          Queued {status.enqueued} capture{status.enqueued === 1 ? '' : 's'}
          {status.skipped > 0 && ` (${status.skipped} skipped)`}
        </div>
      )}
      {status?.kind === 'error' && (
        <div role="alert" style={{ color: 'var(--error)' }}>
          {status.message}
        </div>
      )}
    </div>
  );
}
```

Notes for the implementer:
- This component no longer needs `selectedCount`, `onRecaptureSelected`, or `onClearSelection`. The selection mode is removed.
- Tailwind classes `bg-bg-input border-accent text-accent hover:bg-accent hover:text-bg` follow the project's existing design-token convention (see [DiskStateBadge.tsx](../../../frontend/src/inventory/DiskStateBadge.tsx) and [StockDateGroupListItem.tsx](../../../frontend/src/inventory/StockDateGroupListItem.tsx)).

- [ ] **Step 4.2.2: Run — expect PASS**

```bash
cd frontend && npx vitest run src/inventory/RecaptureActionBar.test.tsx
```

Expected: all 8 tests pass.

### Step 4.3: Commit (no commit yet — `StockDateGroupDetail` is the only caller and would now have a compile error; Task 5 will resolve. Commit ONLY after Task 5 to keep the tree green.)

Skip — proceed directly to Task 5.

---

## Task 5 — Refactor `StockDateGroupDetail` (icon column + in-flight + drop selection)

**Files:**
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx`
- Modify: `frontend/src/inventory/StockDateGroupDetail.test.tsx`
- Delete: `frontend/src/inventory/useRecaptureSelection.ts`
- Delete: `frontend/src/inventory/useRecaptureSelection.test.tsx`

### Step 5.1: Rewrite the component

- [ ] **Step 5.1.1: REPLACE the entire contents of `frontend/src/inventory/StockDateGroupDetail.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { StockDate } from '../api/types';
import { useTabsStore } from '../state/tabs';
import { useStockDateGroups } from './useStockDateGroups';
import { fmtDate, fmtTime, fmtSize, fmtOHLC, fmtVolume } from './format';
import { DiskStateBadge, isRecapturable } from './DiskStateBadge';
import { sortDates, nextSortState, type SortKey, type SortState } from './sortDates';
import { useInventoryRecapture } from './useInventoryRecapture';
import { RecaptureActionBar } from './RecaptureActionBar';
import { useCaptureQueue } from '../capture/useCaptureQueue';

type Props = {
  rows: StockDate[];
  selectedCode: string | null;
};

export function StockDateGroupDetail({ rows, selectedCode }: Props) {
  const navigate = useNavigate();
  const groups = useStockDateGroups(rows, '');
  const group = useMemo(() => {
    if (selectedCode === null) return null;
    return groups.find((g) => g.code === selectedCode) ?? groups[0] ?? null;
  }, [groups, selectedCode]);

  const [sort, setSort] = useState<SortState>(null);
  const sortedDates = useMemo(
    () => (group ? sortDates(group.dates, sort) : []),
    [group, sort],
  );

  const { recapture, status, isPending } = useInventoryRecapture();
  const { queue } = useCaptureQueue();

  // In-flight set: any (code, date) currently in queue.active ∪ queue.queued.
  // SSE updates from capture_queued / capture_progress / capture_finished
  // invalidate the queue cache (see useCaptureQueue), so this Set tracks live.
  const inFlightSet = useMemo(() => {
    const s = new Set<string>();
    if (!queue) return s;
    for (const i of queue.active) s.add(`${i.code}|${i.date}`);
    for (const i of queue.queued) s.add(`${i.code}|${i.date}`);
    return s;
  }, [queue]);

  if (group === null) {
    return (
      <section className="bg-bg-card border rounded-lg p-md text-fg-dim">
        종목을 선택하세요
      </section>
    );
  }

  const totalVolume = group.dates.reduce((s, d) => s + d.total_volume, 0);
  const recapturableCount = sortedDates.filter((r) => isRecapturable(r.disk_state)).length;

  const onRowClick = (r: StockDate) => {
    const tabId = useTabsStore.getState().newTab();
    useTabsStore.getState().setSelection(tabId, {
      code: r.code,
      fromDate: r.date,
      toDate: r.date,
      timeframe: '1m',
    });
    navigate('/replay');
  };

  const onSort = (column: SortKey) => setSort((prev) => nextSortState(prev, column));

  const handleRecaptureRow = (date: string) => recapture(group.code, [date]);
  const handleRecaptureAll = () =>
    recapture(
      group.code,
      sortedDates.filter((r) => isRecapturable(r.disk_state)).map((r) => r.date),
    );

  return (
    <section className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <header className="px-4 py-3 border-b flex items-baseline justify-between gap-4">
        <h2 className="text-md font-semibold shrink-0">
          <span className="text-accent font-mono">{group.code}</span>{' '}
          <span className="text-fg">{group.name}</span>
        </h2>
        <div className="flex flex-col items-end gap-1 min-w-0">
          <span className="text-xs text-fg-dim font-mono tabular-nums">
            {group.dates.length} dates · {fmtVolume(totalVolume)} vol · {fmtSize(group.totalSizeBytes)}
          </span>
          <RecaptureActionBar
            recapturableCount={recapturableCount}
            onRecaptureAll={handleRecaptureAll}
            status={status}
            isPending={isPending}
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full border-collapse font-mono text-sm tabular-nums">
          <thead className="bg-bg-subtle sticky top-0">
            <tr>
              <th className="px-2 py-2 border-b w-8" aria-label="re-capture" />
              <SortableTh column="state"    sort={sort} onSort={onSort}>State</SortableTh>
              <SortableTh column="date"     sort={sort} onSort={onSort}>Date</SortableTh>
              <SortableTh column="captured" sort={sort} onSort={onSort}>Captured</SortableTh>
              <SortableTh column="volume"   sort={sort} onSort={onSort} right>Volume</SortableTh>
              <SortableTh column="pages"    sort={sort} onSort={onSort} right>Pages</SortableTh>
              <SortableTh column="size"     sort={sort} onSort={onSort} right>Size</SortableTh>
              <SortableTh column="ohlc"     sort={sort} onSort={onSort} right title="종가 기준 정렬">OHLC</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedDates.map((r) => {
              const recap = isRecapturable(r.disk_state);
              const inFlight = inFlightSet.has(`${r.code}|${r.date}`);
              return (
                <tr
                  key={`${r.code}-${r.date}`}
                  onClick={() => onRowClick(r)}
                  className="border-b hover:bg-bg-input-hover cursor-pointer"
                >
                  <td
                    className="px-2 py-1.5 text-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {recap ? (
                      <RowRecaptureButton
                        isInFlight={inFlight}
                        onClick={() => handleRecaptureRow(r.date)}
                      />
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 text-center"><DiskStateBadge state={r.disk_state} /></td>
                  <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
                  <td className="px-3 py-1.5 text-fg-dim">{fmtTime(r.captured_at)}</td>
                  <td className="px-3 py-1.5 text-right">{r.total_volume.toLocaleString('ko-KR')}</td>
                  <td className="px-3 py-1.5 text-right text-fg-dim">{r.pages_collected}</td>
                  <td className="px-3 py-1.5 text-right text-fg-dim">{fmtSize(r.file_size_bytes)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtOHLC(r.today_open, r.today_close)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RowRecaptureButton({
  isInFlight,
  onClick,
}: {
  isInFlight: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={isInFlight ? 'Re-capturing…' : 'Re-capture this Stock-Date'}
      disabled={isInFlight}
      onClick={onClick}
      className={[
        'bg-transparent border-none p-0 text-sm',
        isInFlight
          ? 'text-fg-dim animate-spin cursor-not-allowed'
          : 'text-accent hover:text-fg cursor-pointer',
      ].join(' ')}
    >
      ↻
    </button>
  );
}

type SortableThProps = {
  column: SortKey;
  sort: SortState;
  onSort: (column: SortKey) => void;
  right?: boolean;
  title?: string;
  children: React.ReactNode;
};

function SortableTh({ column, sort, onSort, right, title, children }: SortableThProps) {
  const active = sort?.key === column;
  const dir = active ? sort.dir : null;
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
  const indicator = dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '▾';
  const indicatorClass = active ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-30';
  const labelClass = active ? 'text-fg' : 'text-fg-dimmer';

  return (
    <th
      aria-sort={ariaSort}
      className={`px-3 py-2 border-b text-xs uppercase tracking-wider font-semibold ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        title={title}
        onClick={() => onSort(column)}
        className={`group inline-flex items-center gap-1 select-none ${labelClass} ${
          right ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        <span>{children}</span>
        <span className={`font-mono ${indicatorClass}`} aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
```

Important changes vs. the previous version:
- Drops `useRecaptureSelection`, `selectedDates`, all selection state.
- Imports `useCaptureQueue` to derive `inFlightSet`.
- Header bar wires only `recapturableCount`, `onRecaptureAll`, `status`, `isPending`.
- Per-row checkbox replaced with `<RowRecaptureButton />` that calls `handleRecaptureRow(r.date)`.
- `complete` rows render an empty cell (no button).

### Step 5.2: Rewrite the test file

- [ ] **Step 5.2.1: REPLACE the entire contents of `frontend/src/inventory/StockDateGroupDetail.test.tsx`**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StockDateGroupDetail } from './StockDateGroupDetail';
import { useTabsStore } from '../state/tabs';
import type { StockDate, QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

const navigateMock = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

// SSE stub — useCaptureQueue subscribes on mount; jsdom has no EventSource.
vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

const row = (code: string, name: string, date: string,
             disk_state: StockDate['disk_state'] = 'complete'): StockDate => ({
  date, code, name,
  regular_session_open_ms: 0, regular_session_close_ms: 0,
  data_window_first_ms: 0, data_window_last_ms: 0,
  price_min: 0, price_max: 0,
  captured_at: 1000,
  total_volume: 52_100_000, pages_collected: 1240, file_size_bytes: 13_200_000,
  today_open: 70_000, today_high: 73_000, today_low: 69_000, today_close: 72_400,
  disk_state,
});

const EMPTY_QUEUE: QueueSnapshot = {
  active: [], queued: [], done: [], paused: false, max_concurrent: 3,
};

function setupFetch(opts: { queue?: QueueSnapshot } = {}) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
    const s = String(url);
    if (s.includes('/api/captures/queue')) {
      return { ok: true, status: 200, json: async () => (opts.queue ?? EMPTY_QUEUE) } as Response;
    }
    if (s.includes('/api/captures/items') && !s.includes('/retry')) {
      return { ok: true, status: 201, json: async () => ({
        enqueued: [{ item_id: 'new-1' }], deduped: [],
      })} as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  );
}

function renderDetail(rows: StockDate[], selectedCode: string | null, qc: QueryClient) {
  return render(<StockDateGroupDetail rows={rows} selectedCode={selectedCode} />, { wrapper: W(qc) });
}

beforeEach(() => {
  navigateMock.mockReset();
  useTabsStore.setState({ tabs: [] });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('StockDateGroupDetail — header and existing behavior', () => {
  it('renders the selected group header (code + name + summary)', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [row('005930', '삼성전자', '20260522'), row('005930', '삼성전자', '20260521')],
      '005930', qc,
    );
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText(/2 dates/)).toBeTruthy();
  });

  it('renders one row per date sorted desc', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [row('005930', '삼성전자', '20260522'), row('005930', '삼성전자', '20260521')],
      '005930', qc,
    );
    const dateCells = screen.getAllByText(/2026-05-\d{2}/);
    expect(dateCells.map((el) => el.textContent)).toEqual(['2026-05-22', '2026-05-21']);
  });

  it('shows placeholder when selectedCode is null', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260522')], null, qc);
    expect(screen.getByText('종목을 선택하세요')).toBeTruthy();
  });

  it('clicking a row navigates to /replay via useTabsStore', async () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260522')], '005930', qc);
    // The whole row is clickable. Click the date cell.
    fireEvent.click(screen.getByText('2026-05-22'));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/replay'));
  });
});

describe('StockDateGroupDetail — per-row re-capture', () => {
  it('complete rows render no refresh icon', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [
        row('005930', '삼성전자', '20260520', 'complete'),
        row('005930', '삼성전자', '20260521', 'source_partial'),
      ],
      '005930', qc,
    );
    const buttons = screen.queryAllByRole('button', { name: /Re-capture this Stock-Date/i });
    expect(buttons.length).toBe(1);  // only the source_partial row
  });

  it('clicking the row icon POSTs force_retry=true with that date and does NOT navigate', async () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'source_partial')], '005930', qc);
    const btn = screen.getByRole('button', { name: /Re-capture this Stock-Date/i });
    fireEvent.click(btn);
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find((c) =>
        String(c[0]).includes('/api/captures/items') &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toEqual({ code: '005930', dates: ['20260520'], force_retry: true });
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('row is in-flight when its (code, date) appears in queue.queued: icon disabled + animate-spin', async () => {
    setupFetch({
      queue: {
        ...EMPTY_QUEUE,
        queued: [{ item_id: 'q1', code: '005930', date: '20260520',
                   phase: 'queued', force_retry: true, pause_origin: false,
                   enqueued_at_ms: 0, started_at_ms: null, progress: null,
                   result: null, error: null, skip_reason: null, attempt: 1 }],
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'source_partial')], '005930', qc);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Re-capturing…/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.className).toContain('animate-spin');
    });
  });

  it('header bulk button POSTs force_retry=true with all recapturable dates', async () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail(
      [
        row('005930', '삼성전자', '20260520', 'source_partial'),
        row('005930', '삼성전자', '20260521', 'complete'),
        row('005930', '삼성전자', '20260522', 'invalid'),
      ],
      '005930', qc,
    );
    fireEvent.click(screen.getByRole('button', { name: /Re-capture all incomplete \(2\)/i }));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find((c) =>
        String(c[0]).includes('/api/captures/items') &&
        (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.code).toBe('005930');
      expect(body.dates.sort()).toEqual(['20260520', '20260522']);
      expect(body.force_retry).toBe(true);
    });
  });

  it('does not render the header bulk button when no recapturable rows', () => {
    setupFetch();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderDetail([row('005930', '삼성전자', '20260520', 'complete')], '005930', qc);
    expect(screen.queryByRole('button', { name: /Re-capture all incomplete/i })).toBeNull();
  });
});
```

- [ ] **Step 5.2.2: Run — expect FAIL (`useRecaptureSelection` import still exists in old component code path? No, we rewrote it; expect lint/type errors instead)**

```bash
cd frontend && npx vitest run src/inventory/StockDateGroupDetail.test.tsx
```

Expected: the tests run against the new component. They should now PASS — the rewrite in Step 5.1.1 already matches the test expectations. If any test fails, fix the component-test alignment before continuing.

### Step 5.3: Delete the no-longer-used selection hook

- [ ] **Step 5.3.1: Delete the two files**

```bash
rm frontend/src/inventory/useRecaptureSelection.ts
rm frontend/src/inventory/useRecaptureSelection.test.tsx
```

- [ ] **Step 5.3.2: Verify no references remain**

```bash
cd /home/dev/code/hoga-ops.worktrees/feat+frontend4 && grep -rn "useRecaptureSelection" frontend/src/
```

Expected: no output. If `StockDateGroupDetail.tsx` still references it, fix the import before continuing.

### Step 5.4: Verify the inventory test suite is green

- [ ] **Step 5.4.1: Run the entire inventory test directory**

```bash
cd frontend && npx vitest run src/inventory
```

Expected: all pass.

- [ ] **Step 5.4.2: TypeScript check**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean (exit 0).

### Step 5.5: Commit the combined refactor

- [ ] **Step 5.5.1: Stage and commit**

```bash
git add \
  frontend/src/inventory/RecaptureActionBar.tsx \
  frontend/src/inventory/RecaptureActionBar.test.tsx \
  frontend/src/inventory/StockDateGroupDetail.tsx \
  frontend/src/inventory/StockDateGroupDetail.test.tsx
git add -u frontend/src/inventory/useRecaptureSelection.ts frontend/src/inventory/useRecaptureSelection.test.tsx
git commit -m "$(cat <<'EOF'
refactor(inventory): per-row refresh icon + in-flight indicator; drop multi-select

Replaces the checkbox-based multi-select inventory re-capture with a
per-row ↻ icon (immediate trigger), restyles the header bulk button to
read as an accent affordance with derived tooltip, and surfaces in-flight
state on each row by reading queue.active ∪ queue.queued from
useCaptureQueue.

- RecaptureActionBar: selection mode removed; tooltip derived from
  RECAPTURABLE_DISK_STATES (no hardcoded string); restyled accent ghost
  button.
- StockDateGroupDetail: checkbox column → RowRecaptureButton column;
  reads queue from useCaptureQueue to spin the icon while in-flight.
- useRecaptureSelection (hook + tests): DELETED — no longer needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — `inventory` badge on `CaptureQueueRow`

**Files:**
- Modify: `frontend/src/capture/CaptureQueueRow.tsx`
- Modify or Create: `frontend/src/capture/CaptureQueueRow.test.tsx`

### Step 6.1: Determine whether a test file already exists

- [ ] **Step 6.1.1: Check**

```bash
ls frontend/src/capture/CaptureQueueRow.test.tsx 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

If `MISSING`, the test file will be created in Step 6.2.1. If `EXISTS`, append the new test cases to it (preserving any existing scaffolding).

### Step 6.2: Write the failing test

- [ ] **Step 6.2.1: Create OR extend `frontend/src/capture/CaptureQueueRow.test.tsx`**

If creating new, write the entire file. If extending, add ONLY the imports and the new `describe('CaptureQueueRow — inventory badge', () => {...})` block.

For a new file:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaptureQueueRow } from './CaptureQueueRow';
import { useInventoryRecaptureOrigins } from '../inventory/useInventoryRecaptureOrigins';
import type { QueueItem } from '../api/types';

const baseItem: QueueItem = {
  item_id: 'item-1',
  code: '005930',
  date: '20260520',
  phase: 'queued',
  force_retry: false,
  pause_origin: false,
  enqueued_at_ms: 0,
  started_at_ms: null,
  progress: null,
  result: null,
  error: null,
  skip_reason: null,
  attempt: 1,
};

beforeEach(() => {
  useInventoryRecaptureOrigins.getState().clear();
});

afterEach(() => { vi.restoreAllMocks(); });

describe('CaptureQueueRow — inventory badge', () => {
  it('renders the "inventory" badge when item_id is in the origins store', () => {
    useInventoryRecaptureOrigins.getState().add(['item-1']);
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTitle(/Triggered from inventory re-capture/i)).toBeTruthy();
    expect(screen.getByText('inventory')).toBeTruthy();
  });

  it('does not render the badge when item_id is NOT in the store', () => {
    render(
      <CaptureQueueRow
        item={baseItem}
        symbolName="삼성전자"
        onCancel={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByText('inventory')).toBeNull();
  });
});
```

- [ ] **Step 6.2.2: Run — expect FAIL**

```bash
cd frontend && npx vitest run src/capture/CaptureQueueRow.test.tsx
```

Expected: assertions on `inventory` text fail (component doesn't render the badge yet).

### Step 6.3: Wire the badge into the component

- [ ] **Step 6.3.1: Edit `frontend/src/capture/CaptureQueueRow.tsx`**

Add an import near the top:

```ts
import { useInventoryRecaptureOrigins } from '../inventory/useInventoryRecaptureOrigins';
```

In the component body, near the top (alongside the `useState` for `expanded`), add a selector hook call:

```ts
const isFromInventory = useInventoryRecaptureOrigins((s) => s.ids.has(item.item_id));
```

Then locate the existing block that renders the `force` and `×N` badges (around lines 45-56 of the current file):

```tsx
{item.force_retry && (
  <span
    title="Force re-capture"
    className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--warn)] text-[var(--warn)]"
  >⚠ force</span>
)}
{item.attempt > 1 && (
  <span
    title={`Attempt ${item.attempt}`}
    className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--fg-dim)] text-fg-dim"
  >×{item.attempt}</span>
)}
```

Append the `inventory` badge AFTER the `×N` one (so the order reads `⚠ force · ×2 · inventory`):

```tsx
{isFromInventory && (
  <span
    title="Triggered from inventory re-capture"
    className="ml-1.5 text-badge rounded-md px-[0.15rem] border border-[var(--fg-dim)] text-fg-dim"
  >inventory</span>
)}
```

- [ ] **Step 6.3.2: Run — expect PASS**

```bash
cd frontend && npx vitest run src/capture/CaptureQueueRow.test.tsx
```

Expected: both tests pass.

### Step 6.4: Commit

- [ ] **Step 6.4.1: Stage and commit**

```bash
git add frontend/src/capture/CaptureQueueRow.tsx frontend/src/capture/CaptureQueueRow.test.tsx
git commit -m "feat(capture): 'inventory' badge on queue rows triggered from inventory

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Full smoke + typecheck

**Files:** none modified.

### Step 7.1: Run the entire frontend test suite

- [ ] **Step 7.1.1: Frontend**

```bash
cd frontend && npx vitest run 2>&1 | tail -10
```

Expected: all pass. If failures exist that pre-existed in the parallel watchlist/other work on this branch, document them (do not auto-fix outside your scope).

### Step 7.2: Backend test suites (no backend changes, but pin)

- [ ] **Step 7.2.1: Backend captures + eligibility**

```bash
cd /home/dev/code/hoga-ops.worktrees/feat+frontend4 && uv run pytest tests/test_api_captures_queue.py tests/test_api_eligibility.py 2>&1 | tail -5
```

Expected: all pass (no regression — this plan touches no backend).

### Step 7.3: TypeScript

- [ ] **Step 7.3.1: tsc --noEmit**

```bash
cd frontend && npx tsc --noEmit 2>&1 | tail -10 ; echo "exit=$?"
```

Expected: exit 0.

### Step 7.4: Manual smoke (user-driven; not automated)

These steps are for the human implementer to perform after all automated checks pass. Document outcomes in the PR / hand-off, but do not block the plan.

- [ ] **Step 7.4.1: Start dev servers per CLAUDE.md `Dev servers`**

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga
```

```bash
cd frontend && npm run dev
```

- [ ] **Step 7.4.2: Verify the flow against a known `source_partial` Stock-Date**

1. Open <http://localhost:5173/inventory>.
2. Find a Code with a non-complete row. Confirm:
   - That row has a `↻` icon in the leading column; `complete` rows have an empty cell.
   - The icon is rendered in `var(--accent)` color.
3. Click the icon. Confirm:
   - It immediately becomes a spinning ↻ (Tailwind `animate-spin` class).
   - The row click → /replay is not triggered.
   - Status message `Queued 1 capture` appears in the header.
4. Navigate to <http://localhost:5173/capture>. Confirm:
   - The corresponding queue row shows an `inventory` badge next to the `force` / `×N` badges.
5. Wait for the capture to finish. Confirm:
   - Inventory icon stops spinning.
   - If the row's `disk_state` becomes `complete`, the row no longer has an icon.
6. Click the header `↻ Re-capture all incomplete (N)` button (now with strong accent styling). Confirm:
   - Tooltip shows `source partial · client incomplete · invalid`.
   - All abnormal rows for that Code are queued; their icons spin.
7. Reload `/inventory`. Confirm:
   - The `inventory` badge on `/capture` is gone (origins store cleared by design).
   - The queue items themselves persist (ADR-0019).

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task / step |
|---|---|
| `RECAPTURABLE_DISK_STATES` SSOT in DiskStateBadge | Task 1 |
| `isRecapturable` derived from SSOT | Task 1 |
| Origins Zustand store (`add`, `has`, `clear`) | Task 2 |
| Hook pushes enqueued ids to origins store | Task 3 |
| RecaptureActionBar drops selection mode | Task 4, 5 |
| Bulk button accent restyle | Task 4 |
| Tooltip derived from SSOT, not hardcoded | Task 4 |
| Per-row refresh icon, complete = empty cell | Task 5 (Step 5.1.1, `RowRecaptureButton`) |
| Click icon → immediate `recapture(code, [r.date])` | Task 5 |
| `stopPropagation` on icon to preserve /replay nav | Task 5 (Step 5.1.1, `td onClick={(e) => e.stopPropagation()}`) |
| In-flight derivation from `useCaptureQueue` | Task 5 (Step 5.1.1, `inFlightSet`) |
| Icon spins + disabled while in-flight | Task 5 (Step 5.1.1, `RowRecaptureButton`) |
| Delete `useRecaptureSelection` | Task 5 |
| `inventory` badge on CaptureQueueRow | Task 6 |
| Manual smoke flow | Task 7 |

**Placeholder scan:** no TBD/TODO/incomplete code blocks. Every step contains full code or full commands.

**Type consistency checks:**
- `RECAPTURABLE_DISK_STATES: readonly DiskStateValue[]` — consistent in Task 1 (define) and Task 4 (consume in tooltip).
- `isRecapturable(state: DiskStateValue): boolean` — unchanged signature; consumers in Task 5 (`StockDateGroupDetail`) and the existing `aggregateDiskState` consumer continue to work.
- `RecaptureStatus` re-exported from `useInventoryRecapture` (Task 3 already did this in the previous shipped feature); `RecaptureActionBar` imports it (Task 4).
- `OriginsState` interface in Task 2 matches usage in Task 3 (`getState().add(...)`) and Task 6 (selector `s => s.ids.has(...)`).
- `useCaptureQueue` returns `{ queue, ... }`; the consumer in Task 5 destructures `{ queue }`. Verified against [useCaptureQueue.ts:134](../../../frontend/src/capture/useCaptureQueue.ts#L134).

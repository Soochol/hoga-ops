# Watchlist Change Rate Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a watchlist panel sort control next to the header menu so users can choose `기본`, `등락률 오름차순`, or `등락률 내림차순`.

**Architecture:** This is a client-side view sort only. `기본` preserves the existing watchlist folder/order contract and drag reorder behavior; the two change-rate modes keep folder grouping intact and sort entries inside each visible group by live quote `change_pct`, without mutating backend order.

**Tech Stack:** React 18, TypeScript, TanStack Query, Vitest, Testing Library, existing watchlist/right-rail components.

---

## Plan-Eng Review Decisions

This section records the plan review questions and the recommended answer for each. These are settled recommendations unless the implementer intentionally reopens them.

### Q1. Should sorting flatten all Watchlist folders or sort inside each folder?

**Recommended answer:** Sort inside each **Watchlist Folder** only.

**Why:** ADR-0070 defines Watchlist membership and order through folders, and a Code may appear in multiple folders. Flattening would hide group context, make duplicate Code rows ambiguous, and fight the current row context menu and folder collapse model. Folder-local sorting keeps the feature reversible and preserves the user's curated organisation.

**Implementation impact:** Keep `groups.map(...)` as the outer loop. Compute `displayEntries` per group and never merge groups into one list.

### Q2. Should Watchlist support a `미분류` group in this feature?

**Recommended answer:** No. Treat Watchlist `folder_id: null` as legacy/defensive code only; new sort tests and examples must use real folder ids.

**Why:** `docs/adr/0070-watchlist-v3-multi-membership.md` states `folder_id=null` rows do not exist in the Watchlist v3 wire model. `frontend/src/api/watchlist.ts` already documents that `null` is for the heatmap/shared type path, not normal Watchlist data. The current `groupByFolder` null branch is existing compatibility debt, not a domain path this feature should make more official.

**Implementation impact:** Do not use `folder_id: null` in new Watchlist sort fixtures. Leave the existing null handling untouched unless a separate cleanup task is opened.

### Q3. Should we create a new `watchlist/sortEntries.ts` helper?

**Recommended answer:** No. Generalize or reuse the existing Heatmap sorting helper instead of duplicating the same `LiveQuote.change_pct` policy.

**Why:** `frontend/src/heatmap/heat.ts` already has `makePctOf(...)` and `sortEntries(...)` with null-last behaviour and manual-vs-live-sort semantics. The original plan's new helper would create a second policy for the same thing, inviting drift. The right-sized change is to extract a shared helper under `frontend/src/rightrail/quoteSort.ts` or extend the existing helper so both Heatmap and Watchlist call one implementation.

**Implementation impact:** Replace Task 1 with "Extract shared quote change sort helper" and update Heatmap tests plus Watchlist tests against the same helper.

### Q4. Should the three user-facing modes be `기본`, `등락률 오름차순`, `등락률 내림차순`?

**Recommended answer:** Yes, but name the internal type after the user-facing concept: `manual`, `change_asc`, `change_desc` or `default`, `change_pct_asc`, `change_pct_desc`. Keep labels exactly as requested.

**Why:** The requested UI has three modes. Heatmap currently has only `manual` and `change` where `change` means descending. Watchlist needs both directions, so the shared helper should support a direction rather than hard-code Heatmap's descending mode.

**Implementation impact:** `기본` maps to existing `entry.order`; ascending/descending use `quote.change_pct`; missing values sort last in both directions.

### Q5. Should sort mode persist across panel remount/reload?

**Recommended answer:** Do not persist in this first change.

**Why:** Heatmap persists because it is a full-page board where sort mode is part of the workspace. Watchlist Panel is a compact right-rail navigator/editor with drag reorder and destructive quick-remove. Resetting to `기본` keeps the user's saved order obvious and avoids hidden state where drag appears "broken" after reload because a live-sort mode was restored.

**Implementation impact:** Use component-local state in `WatchlistDrawer`, not a new Zustand store or localStorage key.

### Q6. What happens to drag reorder in non-default sort modes?

**Recommended answer:** Disable row drag reorder in change-rate modes, while keeping row click, right-click menu, Delete key, collection badge, and chart drop behaviour in `기본`.

**Why:** A live quote sort updates every 10 seconds. Persisting a manual reorder while the list is visually sorted by change rate is misleading. Heatmap already uses this pattern: manual mode is draggable, change mode is static.

**Implementation impact:** In sorted modes, do not attach `useSortable` row listeners/refs. Add a regression test that selecting `등락률 내림차순` prevents `reorderEntries` from being called by row drag wiring.

### Q7. Should the sort icon be a custom SVG or an icon library?

**Recommended answer:** Use the existing local SVG style unless the repo already has a production icon package for this surface.

**Why:** `WatchlistDrawer.tsx` already has local `ChevronIcon`; `TrashIcon` is a local UI component. The repo does not currently depend on lucide. Adding a package for one 14px control is not a good trade.

**Implementation impact:** Keep the icon small, token-coloured, and button-sized (`h-6 w-6`). Use `aria-label="관심종목 정렬"` and `aria-haspopup="menu"`.

### Q8. How should missing quotes or `change_pct: null` sort?

**Recommended answer:** Always last for both ascending and descending. Stable order by `entry.order` among missing values.

**Why:** Missing live data is not "0%". Sorting it into the middle would imply a real neutral move. Bottom placement matches Heatmap precedent and keeps actionable live movers first.

**Implementation impact:** Tests must cover map miss, present quote with `change_pct: null`, and equal values.

### Q9. Should the plan add group-level sorting by average change?

**Recommended answer:** No. Defer.

**Why:** The user's request is row sorting in the Watchlist list. Group sorting changes navigation semantics, interacts with folder drag order, and already has a Heatmap-specific implementation for market scanning. Watchlist is a right-rail navigator/editor, not the market temperature board.

**Implementation impact:** Add to `NOT in scope`, not `TODOS.md`, unless later user demand appears.

### Q10. Does this need backend/API work?

**Recommended answer:** No.

**Why:** `/api/live/quotes` already supplies `change_pct`; `useQuoteByCode(codes)` already deduplicates multi-folder Codes. Backend order remains the persisted manual order.

**Implementation impact:** No Python/API/model changes. Verification stays in frontend unit/integration tests plus build.

### Q11. Does the plan need an ADR?

**Recommended answer:** No ADR.

**Why:** This is reversible UI behaviour, uses existing live quote and panel patterns, and does not change persisted data. The ADR threshold is not met.

**Implementation impact:** Record the decision in this plan review report only.

### Q12. What tests are mandatory?

**Recommended answer:** Cover the shared helper, menu a11y/selection, row ordering, null-last, real-folder v3 fixtures, default reset, and drag-disabled-in-sorted-mode.

**Why:** The main failure modes are semantic drift from ADR-0070, duplicated sort policy, and a misleading manual drag affordance in live-sort mode. These are cheap to test and prevent regressions.

**Implementation impact:** Add/adjust tests in `frontend/src/heatmap/heat.test.ts` or the new shared helper test, `frontend/src/watchlist/WatchlistDrawer.test.tsx`, and `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx`.

---

## File Structure

- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
  - Own sort-mode state and menu UI.
  - Apply sorted display entries before rendering each group.
  - Disable row drag reorder in non-default sort mode to avoid implying persisted order changes.
- Create or modify: `frontend/src/rightrail/quoteSort.ts` or `frontend/src/heatmap/heat.ts`
  - One shared helper for sorting `WatchlistEntry[]` by live quote `change_pct`.
  - Supports manual/default, ascending, and descending directions.
  - Keeps null/missing `change_pct` at the bottom for both ascending and descending modes.
- Modify: `frontend/src/heatmap/heat.test.ts` or create the matching shared-helper test file
  - Preserve Heatmap's existing `manual` and descending change behaviour while adding ascending coverage for Watchlist.
- Modify: `frontend/src/watchlist/WatchlistDrawer.test.tsx`
  - Integration tests for the sort menu, row order, default reset, and sort button placement.
- Modify: `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx`
  - Regression test that row drag reorder is unavailable in change-rate sort modes.

## Behavior Decisions

- Sort modes:
  - `default`: existing order from `groupByFolder(...)`, which is already folder order plus entry order.
  - `change_pct_asc`: lower `change_pct` first. Example: `-2.5%`, `0.1%`, `3.0%`, missing.
  - `change_pct_desc`: higher `change_pct` first. Example: `3.0%`, `0.1%`, `-2.5%`, missing.
- Sorting scope: inside each folder group only. The feature does not flatten folders because current UI has sticky group headers, collapse state, folder drag, row context menus, and folder-specific reorder semantics.
- Tie-breaker: preserve the existing group entry order when two rows have the same sortable value.
- Missing live quote or `change_pct: null`: render at the bottom in both sorted modes. `기본` ignores quote availability.
- Persistence: no localStorage in the first implementation. Sort mode resets to `기본` on remount, matching a lightweight view control and avoiding hidden state that can interfere with manual drag order.
- Drag behavior: row drag reorder remains active only in `기본`. In sorted modes, row drag listeners are not attached and dropping a row cannot call `reorderEntries`.
- Watchlist v3 fixtures: new tests use real `folder_id` values, not `folder_id: null`. `미분류` is Heatmap/v2 compatibility language, not a normal Watchlist path.

---

### Task 1: Extract Shared Quote Change Sort Helper

**Files:**
- Create: `frontend/src/rightrail/quoteSort.ts`
- Modify: `frontend/src/heatmap/heat.ts`
- Modify: `frontend/src/heatmap/heat.test.ts`
- Create: `frontend/src/rightrail/quoteSort.test.ts`

- [x] **Step 1: Write failing unit tests**

Create `frontend/src/rightrail/quoteSort.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { WatchlistEntry } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';
import { makeChangePctOf, sortEntriesByChangePct, type QuoteSortMode } from './quoteSort';

const entries: WatchlistEntry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
  { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 2 },
  { code: '051910', name: 'LG화학', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 3 },
];

function quotes(items: Array<Pick<LiveQuote, 'code' | 'change_pct'>>): Map<string, LiveQuote> {
  return new Map(items.map((x) => [x.code, {
    code: x.code,
    price: 1000,
    change_pct: x.change_pct,
    change_won: null,
  }]));
}

function codes(mode: QuoteSortMode, q = quotes([
  { code: '005930', change_pct: 1.2 },
  { code: '000660', change_pct: -0.8 },
  { code: '035420', change_pct: 3.4 },
  { code: '051910', change_pct: null },
])) {
  return sortEntriesByChangePct(entries, makeChangePctOf(q), mode).map((e) => e.code);
}

describe('sortEntriesByChangePct', () => {
  it('keeps existing order in default mode', () => {
    expect(codes('default')).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('sorts by change_pct ascending and keeps missing values last', () => {
    expect(codes('change_pct_asc')).toEqual(['000660', '005930', '035420', '051910']);
  });

  it('sorts by change_pct descending and keeps missing values last', () => {
    expect(codes('change_pct_desc')).toEqual(['035420', '005930', '000660', '051910']);
  });

  it('preserves original order for equal change_pct values', () => {
    const tied = quotes([
      { code: '005930', change_pct: 1.2 },
      { code: '000660', change_pct: 1.2 },
      { code: '035420', change_pct: 1.2 },
      { code: '051910', change_pct: 1.2 },
    ]);
    expect(sortEntriesByChangePct(entries, makeChangePctOf(tied), 'change_pct_desc').map((e) => e.code))
      .toEqual(['005930', '000660', '035420', '051910']);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/rightrail/quoteSort.test.ts
```

Expected: FAIL because `frontend/src/rightrail/quoteSort.ts` does not exist.

- [x] **Step 3: Implement the helper**

Create `frontend/src/rightrail/quoteSort.ts`:

```ts
import type { WatchlistEntry } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';

export type QuoteSortMode = 'default' | 'change_pct_asc' | 'change_pct_desc';

export function makeChangePctOf(quoteByCode: Map<string, LiveQuote>): (code: string) => number | null {
  return (code) => {
    const pct = quoteByCode.get(code)?.change_pct;
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
  };
}

export function sortEntriesByChangePct(
  entries: WatchlistEntry[],
  pctOf: (code: string) => number | null,
  mode: QuoteSortMode,
): WatchlistEntry[] {
  if (mode === 'default') return [...entries].sort((a, b) => a.order - b.order);

  const dir = mode === 'change_pct_asc' ? 1 : -1;
  return entries
    .map((entry) => ({ entry, pct: pctOf(entry.code) }))
    .sort((a, b) => {
      if (a.pct == null && b.pct == null) return a.entry.order - b.entry.order;
      if (a.pct == null) return 1;
      if (b.pct == null) return -1;
      const byPct = (a.pct - b.pct) * dir;
      return byPct === 0 ? a.entry.order - b.entry.order : byPct;
    })
    .map((x) => x.entry);
}
```

- [x] **Step 4: Update Heatmap to reuse the shared helper**

In `frontend/src/heatmap/heat.ts`, replace `makePctOf` and `sortEntries` internals with wrappers around `quoteSort.ts` so Heatmap keeps its existing public API:

```ts
import { makeChangePctOf, sortEntriesByChangePct } from '../rightrail/quoteSort';

export function makePctOf(quoteByCode: Map<string, LiveQuote>): (code: string) => number | null {
  return makeChangePctOf(quoteByCode);
}

export function sortEntries(
  entries: WatchlistEntry[],
  mode: SortMode,
  pctOf: (code: string) => number | null,
): WatchlistEntry[] {
  return sortEntriesByChangePct(entries, pctOf, mode === 'manual' ? 'default' : 'change_pct_desc');
}
```

Keep `avgPct`, `heatBg`, `heatHeaderBg`, and group sorting unchanged.

- [x] **Step 5: Run tests to verify they pass**

Run:

```bash
cd frontend && npx vitest run src/rightrail/quoteSort.test.ts src/heatmap/heat.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add frontend/src/rightrail/quoteSort.ts frontend/src/rightrail/quoteSort.test.ts frontend/src/heatmap/heat.ts frontend/src/heatmap/heat.test.ts
git commit -m "feat: share quote change sorting"
```

---

### Task 2: Add Header Sort Menu UI

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Modify: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [x] **Step 1: Write failing integration test for the sort menu**

Append this test inside `describe('WatchlistDrawer', ...)` in `frontend/src/watchlist/WatchlistDrawer.test.tsx`:

```tsx
it('opens a sort menu next to the edit menu with default, ascending, and descending choices', async () => {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(DATA);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

  await waitFor(() => expect(screen.getByLabelText('관심종목 정렬')).toBeInTheDocument());
  expect(screen.getByLabelText('관심종목 편집 메뉴')).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText('관심종목 정렬'));

  expect(await screen.findByRole('menu', { name: '정렬' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemradio', { name: '기본' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('menuitemradio', { name: '등락률 오름차순' })).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByRole('menuitemradio', { name: '등락률 내림차순' })).toHaveAttribute('aria-checked', 'false');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t "opens a sort menu"
```

Expected: FAIL because the sort button is not rendered.

- [x] **Step 3: Add sort state and menu UI**

In `frontend/src/watchlist/WatchlistDrawer.tsx`, add import:

```ts
import { makeChangePctOf, sortEntriesByChangePct, type QuoteSortMode } from '../rightrail/quoteSort';
```

Add this helper near `ChevronIcon`:

```tsx
function SortIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h10" />
      <path d="M4 12h7" />
      <path d="M4 17h4" />
      <path d="M17 6v12" />
      <path d={active ? 'M14 9l3-3 3 3' : 'M14 15l3 3 3-3'} />
    </svg>
  );
}
```

Inside `WatchlistDrawer`, add state next to the existing edit menu state:

```tsx
const [sortMode, setSortMode] = useState<QuoteSortMode>('default');
const [sortMenu, setSortMenu] = useState(false);
const sortMenuRef = useRef<HTMLDivElement>(null);
useDismissablePopover(sortMenu, sortMenuRef, () => setSortMenu(false));
```

Add this local render helper before `return`:

```tsx
const sortItemClass =
  'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2';
const chooseSortMode = (mode: QuoteSortMode) => {
  setSortMode(mode);
  setSortMenu(false);
};
```

Replace the current header right-side `<div className="relative" ref={editMenuRef}>...</div>` with:

```tsx
<div className="flex items-center gap-1">
  <div className="relative" ref={sortMenuRef}>
    <button type="button" aria-label="관심종목 정렬" aria-haspopup="menu" aria-expanded={sortMenu}
            onClick={() => setSortMenu((v) => !v)}
            className={`grid h-6 w-6 place-items-center text-xs ${sortMode === 'default' ? 'text-fg-dim' : 'text-accent'} hover:text-accent`}>
      <SortIcon active={sortMode !== 'default'} />
    </button>
    {sortMenu && (
      <AnchoredMenu label="정렬">
        <button type="button" role="menuitemradio" aria-checked={sortMode === 'default'}
                onClick={() => chooseSortMode('default')}
                className={sortItemClass}>
          <span className="w-4 text-center">{sortMode === 'default' ? '✓' : ''}</span> 기본
        </button>
        <button type="button" role="menuitemradio" aria-checked={sortMode === 'change_pct_asc'}
                onClick={() => chooseSortMode('change_pct_asc')}
                className={sortItemClass}>
          <span className="w-4 text-center">{sortMode === 'change_pct_asc' ? '✓' : ''}</span> 등락률 오름차순
        </button>
        <button type="button" role="menuitemradio" aria-checked={sortMode === 'change_pct_desc'}
                onClick={() => chooseSortMode('change_pct_desc')}
                className={sortItemClass}>
          <span className="w-4 text-center">{sortMode === 'change_pct_desc' ? '✓' : ''}</span> 등락률 내림차순
        </button>
      </AnchoredMenu>
    )}
  </div>
  <div className="relative" ref={editMenuRef}>
    <button type="button" aria-label="관심종목 편집 메뉴" aria-haspopup="menu" aria-expanded={editMenu}
            onClick={() => setEditMenu((v) => !v)}
            className="text-fg-dim hover:text-accent text-xs">편집</button>
    {editMenu && (
      <AnchoredMenu label="관심">
        <button type="button" role="menuitem"
                onClick={() => { setEditMenu(false); setEditOpen(true); }}
                className="block w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover">
          관심 편집
        </button>
        <button type="button" role="menuitem"
                onClick={() => { setEditMenu(false); setAddGroupOpen(true); }}
                className="block w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover">
          새 그룹 만들기
        </button>
      </AnchoredMenu>
    )}
  </div>
</div>
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t "opens a sort menu"
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat: add watchlist sort menu"
```

---

### Task 3: Apply Sorting to Rendered Rows

**Files:**
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`
- Modify: `frontend/src/watchlist/WatchlistDrawer.test.tsx`

- [x] **Step 1: Write failing integration test for ascending, descending, and default reset**

Append this test inside `describe('WatchlistDrawer', ...)`:

```tsx
it('sorts visible watchlist rows by live change rate and resets to default order', async () => {
  const folder = { id: 'f_0000000a', name: '기본', order: 0 };
  const threeEntries = {
    folders: [folder],
    entries: [
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 0 },
      { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 1 },
      { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: folder.id, order: 2 },
    ],
    next_run_at_ms: 0,
  };
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(threeEntries);
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    phase: 'open',
    quotes: [
      { code: '005930', price: 72400, change_pct: 1.2, change_won: 850 },
      { code: '000660', price: 183500, change_pct: -0.8, change_won: -1500 },
      { code: '035420', price: 211000, change_pct: 3.4, change_won: 6900 },
    ],
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });

  await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());

  const rowCodes = () => screen.getAllByTestId(/^watchlist-row-/).map((el) =>
    el.getAttribute('data-testid')?.replace('watchlist-row-', ''));

  expect(rowCodes()).toEqual(['005930', '000660', '035420']);

  fireEvent.click(screen.getByLabelText('관심종목 정렬'));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '등락률 오름차순' }));
  expect(rowCodes()).toEqual(['000660', '005930', '035420']);

  fireEvent.click(screen.getByLabelText('관심종목 정렬'));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '등락률 내림차순' }));
  expect(rowCodes()).toEqual(['035420', '005930', '000660']);

  fireEvent.click(screen.getByLabelText('관심종목 정렬'));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: '기본' }));
  expect(rowCodes()).toEqual(['005930', '000660', '035420']);
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t "sorts visible watchlist rows"
```

Expected: FAIL because selecting sort mode does not affect `g.entries.map(...)`.

- [x] **Step 3: Apply helper in `WatchlistDrawer` render**

Inside the `groups.map((g, gi) => { ... })` block, before `entriesList`, add:

```tsx
const pctOf = makeChangePctOf(quoteByCode);
const displayEntries = sortEntriesByChangePct(g.entries, pctOf, sortMode);
const rowDragEnabled = sortMode === 'default';
```

Then replace the two `g.entries` usages inside the row list:

```tsx
<SortableContext items={displayEntries.map((e) => entrySortableId(e.folder_id, e.code))} strategy={verticalListSortingStrategy}>
  {displayEntries.map((entry) => {
```

When rendering `SortableQuoteRow`, pass:

```tsx
dragEnabled={rowDragEnabled}
```

- [x] **Step 4: Add `dragEnabled` to `SortableQuoteRow`**

In `SortableQuoteRow` props, add:

```ts
dragEnabled?: boolean;
```

Inside the returned `QuoteRow`, change drag props to:

```tsx
sortableRef={props.dragEnabled === false ? undefined : setNodeRef}
sortableStyle={props.dragEnabled === false ? undefined : { transform: CSS.Transform.toString(transform), transition }}
dragListeners={props.dragEnabled === false ? undefined : listeners}
dragging={props.dragEnabled === false ? false : isDragging}
```

Keep `onClick`, `onContextMenu`, `onDelete`, and the collection badge unchanged.

- [x] **Step 5: Run test to verify it passes**

Run:

```bash
cd frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx -t "sorts visible watchlist rows"
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git commit -m "feat: sort watchlist rows by change rate"
```

---

### Task 4: Regression Checks and Polish

**Files:**
- Modify only if tests reveal a concrete issue:
  - `frontend/src/watchlist/WatchlistDrawer.tsx`
  - `frontend/src/watchlist/WatchlistDrawer.test.tsx`
  - `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx`
  - `frontend/src/rightrail/quoteSort.ts`
  - `frontend/src/heatmap/heat.ts`

- [x] **Step 1: Run targeted watchlist tests**

Run:

```bash
cd frontend && npx vitest run src/rightrail/quoteSort.test.ts src/heatmap/heat.test.ts src/watchlist/WatchlistDrawer.test.tsx src/watchlist/WatchlistDrawer.drag.test.ts
```

Expected: PASS.

- [x] **Step 2: Run type check/build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [x] **Step 3: Manual QA**

Start the app:

```bash
cd frontend && npm run dev
```

Check:

- Open the right rail watchlist panel.
- Confirm the sort icon is immediately next to the existing header menu/control.
- Click sort icon, choose `등락률 오름차순`, and verify negative/low change rates appear before high change rates inside each group.
- Choose `등락률 내림차순`, and verify high change rates appear first.
- Choose `기본`, and verify the original manual/folder order returns.
- In `기본`, drag a row and verify reorder still works.
- In either change-rate sort mode, try dragging a row and verify it does not reorder or persist order.
- Right-click row menu, Delete key remove, group collapse, group menu, and collection badges still work.

- [x] **Step 4: Commit final fixes if any**

```bash
git add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx frontend/src/watchlist/WatchlistDrawer.drag.test.tsx frontend/src/rightrail/quoteSort.ts frontend/src/rightrail/quoteSort.test.ts frontend/src/heatmap/heat.ts frontend/src/heatmap/heat.test.ts
git commit -m "test: cover watchlist sort interactions"
```

---

## Self-Review

- Spec coverage: The plan adds a sort icon next to the existing watchlist header control and provides exactly three choices: `기본`, `등락률 오름차순`, `등락률 내림차순`.
- Existing contracts preserved: backend watchlist order, folder grouping, collapse state, context menu, collection badge, and live quote polling remain unchanged.
- Main risk: users may expect sorting across all folders, but the current grouped UI makes cross-folder flattening a larger UX/behavior change. This plan intentionally sorts within groups first.
- Test coverage: pure sorting behavior plus panel-level menu/order behavior are covered; drag regression is covered by the existing drag test file and manual QA.

## GSTACK REVIEW REPORT

### Runs / Status / Findings

| Run | Status | Findings |
|---|---|---|
| Scope challenge | DONE_WITH_CONCERNS | Small feature, but original plan duplicated existing Heatmap sort policy and used Watchlist `folder_id:null` fixtures against ADR-0070. |
| Architecture review | DONE | Keep sort client-side, folder-local, non-persistent; no API/backend changes. |
| Code quality review | DONE | Replace new Watchlist-only helper with shared `rightrail/quoteSort.ts` to prevent `change_pct` policy drift. |
| Test review | DONE_WITH_CONCERNS | Add drag-disabled regression coverage and use v3 real-folder fixtures. |
| Performance review | DONE | O(n log n) per visible group per quote refresh is acceptable for panel-scale lists; no caching layer needed. |
| Outside voice | NOT_RUN | Codex CLI exists, but this environment has restricted network/home writes. Local code/docs review used instead. |

### Verified Evidence

- `docs/adr/0070-watchlist-v3-multi-membership.md:17` says Watchlist v3 removed `folder_id=null` "미분류".
- `docs/adr/0070-watchlist-v3-multi-membership.md:30` says the wire model still exposes folder-expanded entries with `folder_id, order`, but no null rows.
- `frontend/src/api/watchlist.ts:17` says Watchlist v3 wire normally has real folders and `null` is only for the shared Heatmap/v2 path.
- `frontend/src/heatmap/heat.ts:31` already provides quote-to-`change_pct` access policy.
- `frontend/src/heatmap/heat.ts:38` already provides folder-entry sorting by manual order or change-rate descending.
- `frontend/src/heatmap/HeatmapFolder.tsx:38` already disables drag in live change sort mode because polling would overwrite manual reorder.
- `frontend/src/watchlist/WatchlistDrawer.tsx:263` already deduplicates Codes before quote polling, so no backend/API change is needed.
- `frontend/src/watchlist/WatchlistDrawer.tsx:419` is the render point where `g.entries` must be replaced with `displayEntries`.

### All Review Questions And Optimal Answers

1. **Flatten folders or sort inside each folder?** Sort inside each folder. Flattening breaks Watchlist Folder semantics and duplicate-Code multi-membership clarity.
2. **Treat Watchlist `미분류` as normal?** No. Keep it as existing defensive debt only; new fixtures use real folder ids.
3. **Create `watchlist/sortEntries.ts`?** No. Extract shared `rightrail/quoteSort.ts` and wrap Heatmap through it.
4. **Keep exactly three labels?** Yes: `기본`, `등락률 오름차순`, `등락률 내림차순`.
5. **Persist sort mode?** No. Component-local state only for v1.
6. **Drag in sorted modes?** Disable row drag reorder outside `기본`; keep it in `기본`.
7. **Icon source?** Use small local SVG, not a new dependency.
8. **Missing quotes/null pct?** Always last, stable by `entry.order`.
9. **Group sorting by average pct?** Not in scope.
10. **Backend/API changes?** Not needed.
11. **ADR needed?** No. Reversible UI behaviour only.
12. **Mandatory tests?** Shared helper, menu a11y/selection, row order both directions, null-last, v3 fixtures, default reset, drag-disabled regression.

### What Already Exists

- `useQuoteByCode(codes)` already polls live quotes and exposes `change_pct`; reused.
- `WatchlistDrawer` already groups rows and renders `QuoteRow`; reused.
- `AnchoredMenu` and `useDismissablePopover` already implement header menu behaviour; reused.
- Heatmap already has manual-vs-change sorting semantics; refactored into shared helper instead of rebuilding.
- Watchlist drag wiring tests already mock `DndContext`; extend them for non-default sort mode.

### NOT In Scope

- Backend/API sorting: not needed because this is display-only.
- Persisted Watchlist sort preference: deferred to avoid hidden panel state.
- Cross-folder flattening: rejected because Watchlist Folder context is load-bearing.
- Group-level average-change sorting: Heatmap owns market-scanning behaviour; Watchlist remains a navigator/editor.
- Watchlist v3 cleanup of existing `folder_id:null` compatibility code: real debt, but unrelated to this feature's user-visible goal.
- New icon dependency: one local SVG is cheaper and consistent with current panel code.

### Coverage Diagram

```text
CODE PATHS                                                     USER FLOWS
[+] rightrail/quoteSort.ts                                     [+] Watchlist sort menu
  ├── [★★★ planned] default/manual -> entry.order                ├── [★★ planned] open menu, see 3 radio items
  ├── [★★★ planned] asc -> low change_pct first                  ├── [★★ planned] choose asc, rows reorder in group
  ├── [★★★ planned] desc -> high change_pct first                ├── [★★ planned] choose desc, rows reorder in group
  ├── [★★★ planned] null/missing -> bottom                       └── [★★ planned] choose default, manual order returns
  └── [★★★ planned] ties -> entry.order

[+] heatmap/heat.ts wrapper                                    [+] Existing Heatmap behaviour
  ├── [★★★ planned] manual still sorts by order                  ├── [★★★ planned] existing heat tests stay green
  └── [★★★ planned] change still maps to desc                    └── [★★ planned] no user-visible Heatmap regression

[+] watchlist/WatchlistDrawer.tsx                              [+] Drag and row actions
  ├── [★★ planned] local sortMode state                          ├── [★★★ planned] default mode row drag still reorders
  ├── [★★ planned] sort menu radio selection                     ├── [★★★ planned] sorted mode row drag cannot reorder
  ├── [★★★ planned] displayEntries per folder                    ├── [★★ planned] row click still opens /live
  ├── [★★ planned] sorted modes disable row drag listeners       ├── [★★ planned] right-click menu still opens
  └── [★★ planned] collection badge unaffected                   └── [★★ planned] Delete key still removes row
```

Legend: `★★★` behaviour + edge cases, `★★` happy path + key regression.

### Failure Modes

| Codepath | Realistic failure | Test/error handling |
|---|---|---|
| Shared sort helper | Missing quote is treated as 0% and appears among neutral movers. | Covered by null/missing-last unit tests. |
| Watchlist v3 fixture path | New tests bless `folder_id:null` and reintroduce Watchlist-미분류 semantics. | Covered by plan requirement to use real folder ids. |
| Sorted-mode drag | User drags in `등락률 내림차순`, backend persists a reorder that the screen does not visually show. | Covered by `WatchlistDrawer.drag.test.tsx` regression. |
| Heatmap wrapper | Refactor changes Heatmap `change` from descending to another direction. | Covered by existing `heat.test.ts` plus shared helper tests. |
| Sort menu | Menu opens but selected state is not accessible to screen readers. | Covered by `menuitemradio`/`aria-checked` integration tests. |
| Quote polling update | Rows jump every 10 seconds while sorted by live pct. | Intended behaviour in sorted modes; no persistence, no error state. |

No silent critical gap remains if the drag-disabled regression test is added.

### Architecture Verdict

`[P1] (confidence: 9/10) docs/adr/0070-watchlist-v3-multi-membership.md:17 — Original plan used `folder_id:null` test fixtures, contradicting Watchlist v3's no-unfiled model. Fix: use real folder fixtures and keep null as existing compatibility debt only.`

`[P2] (confidence: 9/10) frontend/src/heatmap/heat.ts:31 — Original plan duplicated live quote change sorting instead of reusing Heatmap's existing change_pct policy. Fix: shared helper under rightrail.`

`[P2] (confidence: 8/10) frontend/src/heatmap/HeatmapFolder.tsx:38 — Original plan said to disable drag in sorted mode but did not require a drag regression test. Fix: add it to WatchlistDrawer.drag.test.tsx.`

### Test Plan

Run:

```bash
cd frontend && npx vitest run src/rightrail/quoteSort.test.ts src/heatmap/heat.test.ts src/watchlist/WatchlistDrawer.test.tsx src/watchlist/WatchlistDrawer.drag.test.ts
cd frontend && npm run build
```

Manual QA:

- Open Watchlist Panel.
- Verify sort icon is next to the existing `편집` control.
- Verify all three choices render and `aria-checked` tracks the selected mode.
- Verify asc/desc/default order inside each real folder.
- Verify `기본` drag reorder still works.
- Verify sorted-mode row drag cannot call reorder.
- Verify row click, context menu, Delete key, collapse, group menu, and collection badges still work.

### Worktree Parallelization Strategy

Sequential implementation, no parallelization opportunity. The change is small and all meaningful work touches the same frontend modules and tests.

### Implementation Tasks

- [x] **T1 (P1, human: ~30min / CC: ~5min)** — Watchlist fixtures — Replace new Watchlist sort fixtures with real `folder_id` values
  - Surfaced by: Architecture review — ADR-0070 mismatch
  - Files: `frontend/src/watchlist/WatchlistDrawer.test.tsx`
  - Verify: targeted WatchlistDrawer sort test

- [x] **T2 (P2, human: ~1h / CC: ~10min)** — Quote sorting — Extract shared `change_pct` sorting helper and wrap Heatmap through it
  - Surfaced by: Code quality review — duplicate sort policy risk
  - Files: `frontend/src/rightrail/quoteSort.ts`, `frontend/src/rightrail/quoteSort.test.ts`, `frontend/src/heatmap/heat.ts`, `frontend/src/heatmap/heat.test.ts`
  - Verify: `cd frontend && npx vitest run src/rightrail/quoteSort.test.ts src/heatmap/heat.test.ts`

- [x] **T3 (P2, human: ~45min / CC: ~10min)** — Watchlist Panel — Add local sort menu and apply per-folder display sorting
  - Surfaced by: Architecture review — folder-local display sort
  - Files: `frontend/src/watchlist/WatchlistDrawer.tsx`, `frontend/src/watchlist/WatchlistDrawer.test.tsx`
  - Verify: WatchlistDrawer sort/menu tests

- [x] **T4 (P2, human: ~30min / CC: ~5min)** — Drag regression — Prove sorted modes do not persist row reorder
  - Surfaced by: Test review — misleading drag affordance risk
  - Files: `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx`
  - Verify: `cd frontend && npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx`

### Artifacts

- Test-plan artifact under `~/.gstack/projects/...` was not written because the managed environment reported `~/.gstack` as read-only during preflight.
- `gstack-review-log` / `gstack-review-read` were not run for the same home-directory write constraint.

VERDICT: REVISE_PLAN_THEN_BUILD. The feature is correctly scoped, but the original plan needed three corrections before implementation: v3 real-folder fixtures, shared quote sorting, and drag-disabled regression coverage.

NO UNRESOLVED DECISIONS

# Screener Change-Percent Result Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit default/ascending/descending change-percent sorting to both screener result surfaces.

**Architecture:** Reuse the existing Watchlist change-percent sort vocabulary and comparison behavior. Add a screener-specific pure wrapper for rows without an `order` field, a compact three-button control, then wire that control into `/screener` and the right-rail Screener Panel with transient per-surface state.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, React Testing Library, Zustand, TanStack Query, dnd-kit.

## Global Constraints

- No backend sort parameter or API contract change.
- Sort after `useScreenerRowsLive`, using the displayed `change_pct`.
- `default` means original `/api/screener/scan` row order.
- `null`, `undefined`, and non-finite `change_pct` values sort last in ascending and descending modes.
- Equal change-percent values preserve original scan order.
- Do not persist screener sort mode in localStorage or `screenerPanel`.
- Do not change Watchlist sorting behavior.
- Do not add an icon dependency; use local SVG with `currentColor`.
- Keep `QuoteRow` static and panel-owned; do not add sort/table/drag concerns to it.

---

## File Structure

- Modify `frontend/src/rightrail/quoteSort.ts`: keep the existing `QuoteSortMode`, `QuoteSortableEntry`, `makeChangePctOf`, and `sortEntriesByChangePct` contract.
- Create `frontend/src/rightrail/QuoteSortIcon.tsx`: shared icon and accessible description helper extracted from `WatchlistDrawer`.
- Modify `frontend/src/watchlist/WatchlistDrawer.tsx`: import `QuoteSortIcon` and `quoteSortModeDescription`; remove local duplicated icon/description functions.
- Create `frontend/src/screener/sortResults.ts`: `ScreenerResultSortMode` alias and `sortScreenerRows(...)` wrapper around `sortEntriesByChangePct`.
- Create `frontend/src/screener/ScreenerResultSortControl.tsx`: reusable three-button sort control for `/screener` and `ScreenerDrawer`.
- Modify `frontend/src/pages/Screener.tsx`: own transient sort state, reset on successful scan, pass sorted rows and control props to `ResultTable`.
- Modify `frontend/src/screener/ResultTable.tsx`: render `ScreenerResultSortControl` in the `등락률` header cell.
- Modify `frontend/src/screener/ScreenerDrawer.tsx`: own transient sort state, reset on successful scan, sort `liveRows`, and render the control in the result summary header.
- Add/modify tests:
  - `frontend/src/rightrail/QuoteSortIcon.test.tsx`
  - `frontend/src/screener/sortResults.test.ts`
  - `frontend/src/screener/ScreenerResultSortControl.test.tsx`
  - `frontend/src/pages/Screener.test.tsx`
  - `frontend/src/screener/ScreenerDrawer.test.tsx`

---

### Task 1: Extract Shared Quote Sort Icon

**Files:**
- Create: `frontend/src/rightrail/QuoteSortIcon.tsx`
- Create: `frontend/src/rightrail/QuoteSortIcon.test.tsx`
- Modify: `frontend/src/watchlist/WatchlistDrawer.tsx`

**Interfaces:**
- Consumes: `QuoteSortMode` from `frontend/src/rightrail/quoteSort.ts`.
- Produces:
  - `QuoteSortIcon({ mode }: { mode: QuoteSortMode | undefined }): JSX.Element`
  - `quoteSortModeDescription(mode: QuoteSortMode | undefined): string`

- [ ] **Step 1: Write the shared icon test**

Create `frontend/src/rightrail/QuoteSortIcon.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuoteSortIcon, quoteSortModeDescription } from './QuoteSortIcon';

describe('QuoteSortIcon', () => {
  it('renders distinct icons for default, ascending, and descending modes', () => {
    const { rerender } = render(<QuoteSortIcon mode="default" />);
    expect(screen.getByTestId('sort-icon-default')).toBeInTheDocument();

    rerender(<QuoteSortIcon mode="change_pct_asc" />);
    expect(screen.getByTestId('sort-icon-asc')).toBeInTheDocument();

    rerender(<QuoteSortIcon mode="change_pct_desc" />);
    expect(screen.getByTestId('sort-icon-desc')).toBeInTheDocument();
  });

  it('describes the current cycle state for the existing Watchlist one-button control', () => {
    expect(quoteSortModeDescription('default')).toBe('현재 기본 정렬, 클릭하면 등락률 오름차순');
    expect(quoteSortModeDescription('change_pct_asc')).toBe('현재 등락률 오름차순, 클릭하면 등락률 내림차순');
    expect(quoteSortModeDescription('change_pct_desc')).toBe('현재 등락률 내림차순, 클릭하면 기본 정렬');
    expect(quoteSortModeDescription(undefined)).toBe('현재 기본 정렬, 클릭하면 등락률 오름차순');
  });
});
```

- [ ] **Step 2: Run the new icon test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/rightrail/QuoteSortIcon.test.tsx
```

Expected: FAIL because `./QuoteSortIcon` does not exist.

- [ ] **Step 3: Create the shared icon module**

Create `frontend/src/rightrail/QuoteSortIcon.tsx`:

```tsx
import type { QuoteSortMode } from './quoteSort';

export function QuoteSortIcon({ mode }: { mode: QuoteSortMode | undefined }) {
  const iconMode = mode ?? 'default';
  return (
    <svg
      data-testid={`sort-icon-${iconMode === 'change_pct_asc' ? 'asc' : iconMode === 'change_pct_desc' ? 'desc' : 'default'}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconMode === 'default' ? (
        <>
          <path d="M5 7h14" />
          <path d="M5 12h14" />
          <path d="M5 17h14" />
        </>
      ) : (
        <>
          <path d="M4 7h10" />
          <path d="M4 12h7" />
          <path d="M4 17h4" />
          <path d="M17 6v12" />
          <path d={iconMode === 'change_pct_asc' ? 'M14 9l3-3 3 3' : 'M14 15l3 3 3-3'} />
        </>
      )}
    </svg>
  );
}

export function quoteSortModeDescription(mode: QuoteSortMode | undefined): string {
  if (mode === 'change_pct_asc') return '현재 등락률 오름차순, 클릭하면 등락률 내림차순';
  if (mode === 'change_pct_desc') return '현재 등락률 내림차순, 클릭하면 기본 정렬';
  return '현재 기본 정렬, 클릭하면 등락률 오름차순';
}
```

- [ ] **Step 4: Replace the local Watchlist icon**

Modify `frontend/src/watchlist/WatchlistDrawer.tsx`:

```tsx
import { QuoteSortIcon, quoteSortModeDescription } from '../rightrail/QuoteSortIcon';
```

Delete the local `SortIcon` and `sortModeDescription` functions. Replace this call:

```tsx
<SortIcon mode={props.sortMode} />
```

with:

```tsx
<QuoteSortIcon mode={props.sortMode} />
```

Replace this call:

```tsx
{sortModeDescription(props.sortMode)}
```

with:

```tsx
{quoteSortModeDescription(props.sortMode)}
```

- [ ] **Step 5: Run icon and Watchlist sort tests**

Run:

```bash
cd frontend && npx vitest run src/rightrail/QuoteSortIcon.test.tsx src/watchlist/WatchlistDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add frontend/src/rightrail/QuoteSortIcon.tsx frontend/src/rightrail/QuoteSortIcon.test.tsx frontend/src/watchlist/WatchlistDrawer.tsx
git commit -m "refactor: share quote sort icon"
```

---

### Task 2: Add Screener Sort Helper And Three-Button Control

**Files:**
- Create: `frontend/src/screener/sortResults.ts`
- Create: `frontend/src/screener/sortResults.test.ts`
- Create: `frontend/src/screener/ScreenerResultSortControl.tsx`
- Create: `frontend/src/screener/ScreenerResultSortControl.test.tsx`

**Interfaces:**
- Consumes:
  - `QuoteSortMode` and `sortEntriesByChangePct` from `frontend/src/rightrail/quoteSort.ts`.
  - `QuoteSortIcon` from `frontend/src/rightrail/QuoteSortIcon.tsx`.
- Produces:
  - `type ScreenerResultSortMode = QuoteSortMode`
  - `sortScreenerRows<T extends { code: string; change_pct: number | null | undefined }>(rows: readonly T[], mode: ScreenerResultSortMode): T[]`
  - `ScreenerResultSortControl({ mode, onChange, disabled }: Props): JSX.Element`

- [ ] **Step 1: Write the pure sort helper tests**

Create `frontend/src/screener/sortResults.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sortScreenerRows, type ScreenerResultSortMode } from './sortResults';

const rows = [
  { code: '005930', name: '삼성전자', change_pct: 1.2 },
  { code: '000660', name: 'SK하이닉스', change_pct: -0.8 },
  { code: '035420', name: 'NAVER', change_pct: 3.4 },
  { code: '051910', name: 'LG화학', change_pct: null },
];

function codes(mode: ScreenerResultSortMode, input = rows) {
  return sortScreenerRows(input, mode).map((r) => r.code);
}

describe('sortScreenerRows', () => {
  it('keeps scan order in default mode', () => {
    expect(codes('default')).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('sorts by displayed change_pct ascending and keeps missing values last', () => {
    expect(codes('change_pct_asc')).toEqual(['000660', '005930', '035420', '051910']);
  });

  it('sorts by displayed change_pct descending and keeps missing values last', () => {
    expect(codes('change_pct_desc')).toEqual(['035420', '005930', '000660', '051910']);
  });

  it('preserves scan order for equal change_pct values', () => {
    const tied = rows.map((r) => ({ ...r, change_pct: 1.2 }));
    expect(codes('change_pct_desc', tied)).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('treats undefined and non-finite values as missing and does not mutate input', () => {
    const input = [
      { code: 'A', change_pct: Number.NaN },
      { code: 'B', change_pct: undefined },
      { code: 'C', change_pct: 2 },
    ];
    const before = input.map((r) => ({ ...r }));
    expect(sortScreenerRows(input, 'change_pct_desc').map((r) => r.code)).toEqual(['C', 'A', 'B']);
    expect(input).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the sort helper test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/screener/sortResults.test.ts
```

Expected: FAIL because `./sortResults` does not exist.

- [ ] **Step 3: Implement the pure sort helper**

Create `frontend/src/screener/sortResults.ts`:

```ts
import { sortEntriesByChangePct, type QuoteSortMode } from '../rightrail/quoteSort';

export type ScreenerResultSortMode = QuoteSortMode;

type SortableScreenerRow = {
  code: string;
  change_pct: number | null | undefined;
};

export function sortScreenerRows<T extends SortableScreenerRow>(
  rows: readonly T[],
  mode: ScreenerResultSortMode,
): T[] {
  const sortable = rows.map((row, order) => ({ row, code: row.code, order }));
  return sortEntriesByChangePct(
    sortable,
    (code) => {
      const pct = rows.find((row) => row.code === code)?.change_pct;
      return typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
    },
    mode,
  ).map((item) => item.row);
}
```

- [ ] **Step 4: Improve the helper lookup to avoid repeated `find`**

Replace `sortScreenerRows` with this implementation:

```ts
export function sortScreenerRows<T extends SortableScreenerRow>(
  rows: readonly T[],
  mode: ScreenerResultSortMode,
): T[] {
  const pctByCode = new Map<string, number | null>();
  const sortable = rows.map((row, order) => {
    const pct = row.change_pct;
    pctByCode.set(row.code, typeof pct === 'number' && Number.isFinite(pct) ? pct : null);
    return { row, code: row.code, order };
  });
  return sortEntriesByChangePct(sortable, (code) => pctByCode.get(code) ?? null, mode)
    .map((item) => item.row);
}
```

- [ ] **Step 5: Run the sort helper test and verify it passes**

Run:

```bash
cd frontend && npx vitest run src/screener/sortResults.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write the sort control tests**

Create `frontend/src/screener/ScreenerResultSortControl.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';

describe('ScreenerResultSortControl', () => {
  it('renders three explicit sort buttons and marks the active mode', () => {
    render(<ScreenerResultSortControl mode="default" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: '기본 순서' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '등락률 낮은 순' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '등락률 높은 순' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(screen.getByRole('button', { name: '기본 순서' })).getByTestId('sort-icon-default')).toBeInTheDocument();
  });

  it('calls onChange with the requested mode', () => {
    const onChange = vi.fn();
    render(<ScreenerResultSortControl mode="default" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '등락률 낮은 순' }));
    fireEvent.click(screen.getByRole('button', { name: '등락률 높은 순' }));
    fireEvent.click(screen.getByRole('button', { name: '기본 순서' }));

    expect(onChange).toHaveBeenNthCalledWith(1, 'change_pct_asc');
    expect(onChange).toHaveBeenNthCalledWith(2, 'change_pct_desc');
    expect(onChange).toHaveBeenNthCalledWith(3, 'default');
  });

  it('disables all buttons when disabled', () => {
    render(<ScreenerResultSortControl mode="change_pct_desc" onChange={vi.fn()} disabled />);

    expect(screen.getByRole('button', { name: '기본 순서' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '등락률 낮은 순' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '등락률 높은 순' })).toBeDisabled();
  });
});
```

- [ ] **Step 7: Run the control test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/screener/ScreenerResultSortControl.test.tsx
```

Expected: FAIL because `./ScreenerResultSortControl` does not exist.

- [ ] **Step 8: Implement the sort control**

Create `frontend/src/screener/ScreenerResultSortControl.tsx`:

```tsx
import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import type { ScreenerResultSortMode } from './sortResults';

interface Props {
  mode: ScreenerResultSortMode;
  onChange: (mode: ScreenerResultSortMode) => void;
  disabled?: boolean;
}

const OPTIONS: Array<{ mode: ScreenerResultSortMode; label: string }> = [
  { mode: 'default', label: '기본 순서' },
  { mode: 'change_pct_asc', label: '등락률 낮은 순' },
  { mode: 'change_pct_desc', label: '등락률 높은 순' },
];

export function ScreenerResultSortControl({ mode, onChange, disabled = false }: Props) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg-input" role="group" aria-label="스크리너 결과 정렬">
      {OPTIONS.map((option) => {
        const active = mode === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            aria-label={option.label}
            title={option.label}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            className={`grid h-6 w-6 place-items-center border-r border-border last:border-r-0 disabled:cursor-not-allowed disabled:opacity-50 ${
              active ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
            }`}
          >
            <QuoteSortIcon mode={option.mode} />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 9: Run all Task 2 tests**

Run:

```bash
cd frontend && npx vitest run src/screener/sortResults.test.ts src/screener/ScreenerResultSortControl.test.tsx src/rightrail/quoteSort.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add frontend/src/screener/sortResults.ts frontend/src/screener/sortResults.test.ts frontend/src/screener/ScreenerResultSortControl.tsx frontend/src/screener/ScreenerResultSortControl.test.tsx
git commit -m "feat: add screener result sort control"
```

---

### Task 3: Wire Sorting Into The Full `/screener` Page

**Files:**
- Modify: `frontend/src/pages/Screener.tsx`
- Modify: `frontend/src/screener/ResultTable.tsx`
- Modify: `frontend/src/pages/Screener.test.tsx`

**Interfaces:**
- Consumes:
  - `sortScreenerRows` and `ScreenerResultSortMode`.
  - `ScreenerResultSortControl`.
- Produces:
  - `ResultTable` props: `sortMode: ScreenerResultSortMode`, `onSortModeChange: (mode: ScreenerResultSortMode) => void`.

- [ ] **Step 1: Add page-level sorting tests**

Modify the `runScan` mock rows near the top of `frontend/src/pages/Screener.test.tsx` so it returns three rows:

```tsx
runScan: vi.fn(() => Promise.resolve({ status: 'ok', warnings: [], rows: [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8 },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 180000, trade_value_won: 600_000_000_000, change_pct: -1.2 },
  { code: '035420', name: 'NAVER', market: 'KOSPI', price: 210000, trade_value_won: 300_000_000_000, change_pct: 2.4 },
] })),
```

Add these helpers and tests near the existing scan/result tests:

```tsx
function resultNames() {
  return screen.getAllByRole('button', { name: /호가창 열기/ })
    .map((row) => row.getAttribute('aria-label'));
}

it('sorts full-page screener results by displayed change rate and resets to default', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await screen.findByText('삼성전자');

  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);

  fireEvent.click(screen.getByRole('button', { name: '등락률 높은 순' }));
  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'NAVER 035420 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
  ]);

  fireEvent.click(screen.getByRole('button', { name: '등락률 낮은 순' }));
  expect(resultNames()).toEqual([
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
    '삼성전자 005930 호가창 열기',
  ]);

  fireEvent.click(screen.getByRole('button', { name: '기본 순서' }));
  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);
});

it('resets full-page result sort to default after a new successful scan', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await screen.findByText('삼성전자');
  fireEvent.click(screen.getByRole('button', { name: '등락률 낮은 순' }));
  expect(screen.getByRole('button', { name: '등락률 낮은 순' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '기본 순서' })).toHaveAttribute('aria-pressed', 'true'));
  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);
});
```

- [ ] **Step 2: Run the page tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/pages/Screener.test.tsx
```

Expected: FAIL because the sort buttons are not rendered.

- [ ] **Step 3: Extend `ResultTable` props and header**

Modify `frontend/src/screener/ResultTable.tsx` imports:

```tsx
import type { ScreenerResultSortMode } from './sortResults';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';
```

Modify `Props`:

```tsx
interface Props {
  /** Live Quote 가 이미 머지된 결과 행(useScreenerRowsLive). 표시만 하면 된다. */
  rows: ScreenerRowLive[];
  sortMode: ScreenerResultSortMode;
  onSortModeChange: (mode: ScreenerResultSortMode) => void;
  onActivate: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
}
```

Modify `COLS` so the `등락률` header has enough room:

```tsx
const COLS = 'grid-cols-[3.5rem_1fr_4rem_6rem_7.25rem_6rem_2.4rem]';
```

Modify the function signature:

```tsx
export function ResultTable({ rows, sortMode, onSortModeChange, onActivate }: Props) {
```

Replace the header `등락률` span:

```tsx
<span className="flex items-center justify-end gap-1">
  <span>등락률</span>
  <ScreenerResultSortControl mode={sortMode} onChange={onSortModeChange} disabled={rows.length === 0} />
</span>
```

- [ ] **Step 4: Own and apply sort state in `/screener`**

Modify `frontend/src/pages/Screener.tsx` imports:

```tsx
import { sortScreenerRows, type ScreenerResultSortMode } from '../screener/sortResults';
```

Add state after `lastScanKey`:

```tsx
const [sortMode, setSortMode] = useState<ScreenerResultSortMode>('default');
```

Add sorted rows after `liveRows`:

```tsx
const sortedLiveRows = useMemo(() => sortScreenerRows(liveRows, sortMode), [liveRows, sortMode]);
```

Replace `runScan`:

```tsx
const runScan = () => screener.mutate(scanBody, {
  onSuccess: () => {
    setLastScanKey(scanKey);
    setSortMode('default');
  },
});
```

Replace the `ResultTable` call:

```tsx
<ResultTable rows={sortedLiveRows} sortMode={sortMode} onSortModeChange={setSortMode} onActivate={openLive} />
```

- [ ] **Step 5: Run the page tests**

Run:

```bash
cd frontend && npx vitest run src/pages/Screener.test.tsx src/screener/ScreenerResultSortControl.test.tsx src/screener/sortResults.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add frontend/src/pages/Screener.tsx frontend/src/screener/ResultTable.tsx frontend/src/pages/Screener.test.tsx
git commit -m "feat: sort screener page results"
```

---

### Task 4: Wire Sorting Into The Right-Rail Screener Drawer

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Modify: `frontend/src/screener/ScreenerDrawer.test.tsx`

**Interfaces:**
- Consumes:
  - `sortScreenerRows` and `ScreenerResultSortMode`.
  - `ScreenerResultSortControl`.
- Produces: Drawer-local transient `sortMode` state and sorted list rendering.

- [ ] **Step 1: Add drawer sorting tests**

Add these tests to `frontend/src/screener/ScreenerDrawer.test.tsx` near existing result-row tests:

```tsx
it('sorts drawer screener results by displayed change rate and resets to default', async () => {
  vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
  const rows = [
    { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 2.1 },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: -1.2 },
    { code: '035420', name: 'NAVER', market: 'KOSPI' as const, price: 210000, trade_value_won: 3e11, change_pct: 4.4 },
  ];
  const scan = vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows, warnings: [] });
  render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
  await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));

  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await waitFor(() => expect(scan).toHaveBeenCalled());
  expect(screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid)).toEqual([
    'screener-row-005930',
    'screener-row-000660',
    'screener-row-035420',
  ]);

  fireEvent.click(screen.getByRole('button', { name: '등락률 높은 순' }));
  expect(screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid)).toEqual([
    'screener-row-035420',
    'screener-row-005930',
    'screener-row-000660',
  ]);

  fireEvent.click(screen.getByRole('button', { name: '등락률 낮은 순' }));
  expect(screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid)).toEqual([
    'screener-row-000660',
    'screener-row-005930',
    'screener-row-035420',
  ]);

  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '기본 순서' })).toHaveAttribute('aria-pressed', 'true'));
});

it('keeps chart-drop behavior after drawer results are sorted', async () => {
  vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
  useScreenerPanelStore.setState({
    selectedSavedId: 's1',
    lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
  });
  const hitTest = () => true;
  useEntryDragStore.getState().registerChartTarget(hitTest);
  try {
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '등락률 낮은 순' }));

    dnd.onDragStart!({
      active: { id: 'screener-entry:000660', data: { current: { type: 'screener-entry', code: '000660', name: 'SK하이닉스' } } },
    });
    dnd.onDragEnd!({
      active: { id: 'screener-entry:000660', data: { current: { type: 'screener-entry', code: '000660', name: 'SK하이닉스' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: -500, y: 0 },
    });

    expect(useLivePageStore.getState().activeCode).toBe('000660');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  } finally {
    useEntryDragStore.getState().clearChartTarget(hitTest);
  }
});
```

- [ ] **Step 2: Run drawer tests and verify they fail**

Run:

```bash
cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx
```

Expected: FAIL because the sort buttons are not rendered.

- [ ] **Step 3: Own and apply sort state in `ScreenerDrawer`**

Modify `frontend/src/screener/ScreenerDrawer.tsx` imports:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { sortScreenerRows, type ScreenerResultSortMode } from './sortResults';
import { ScreenerResultSortControl } from './ScreenerResultSortControl';
```

Add state after `setLastScan`:

```tsx
const [sortMode, setSortMode] = useState<ScreenerResultSortMode>('default');
```

Modify the `onSuccess` body in `runScan`:

```tsx
onSuccess: (res) => {
  setLastScan({
    savedId: selected.id, savedName: selected.name,
    rows: res.rows, scanStatus: res.status, warnings: res.warnings,
  });
  setSortMode('default');
},
```

Add sorted rows after `liveRows`:

```tsx
const sortedLiveRows = useMemo(() => sortScreenerRows(liveRows, sortMode), [liveRows, sortMode]);
```

- [ ] **Step 4: Render the drawer control and sorted list**

Replace the result summary header:

```tsx
<div className="px-md pt-sm pb-1 text-xs uppercase tracking-[0.08em] text-fg-dimmer">
  결과 {lastScan.rows.length} · {lastScan.savedName}
  {selectedSavedId !== lastScan.savedId && (
    <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
      · 선택한 조건과 다름 — 조회로 갱신
    </span>
  )}
</div>
```

with:

```tsx
<div className="px-md pt-sm pb-1 flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-fg-dimmer">
  <div className="min-w-0 flex-1 truncate">
    결과 {lastScan.rows.length} · {lastScan.savedName}
    {selectedSavedId !== lastScan.savedId && (
      <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
        · 선택한 조건과 다름 — 조회로 갱신
      </span>
    )}
  </div>
  <ScreenerResultSortControl mode={sortMode} onChange={setSortMode} disabled={lastScan.rows.length === 0} />
</div>
```

Replace the list map:

```tsx
{liveRows.map((r) => (
```

with:

```tsx
{sortedLiveRows.map((r) => (
```

- [ ] **Step 5: Run drawer tests**

Run:

```bash
cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx src/screener/ScreenerResultSortControl.test.tsx src/screener/sortResults.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run focused full feature tests**

Run:

```bash
cd frontend && npx vitest run src/rightrail/QuoteSortIcon.test.tsx src/rightrail/quoteSort.test.ts src/watchlist/WatchlistDrawer.test.tsx src/screener/sortResults.test.ts src/screener/ScreenerResultSortControl.test.tsx src/pages/Screener.test.tsx src/screener/ScreenerDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Run typecheck/build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "feat: sort screener drawer results"
```

---

## Self-Review

**Spec coverage:** Covered both result surfaces, default/asc/desc states, live-overlay-after-sort data flow, null-last behavior, original-order tie-breaking, no persistence, no backend change, no icon dependency, and `QuoteRow` boundary preservation.

**Placeholder scan:** No `TBD`, `TODO`, "implement later", or vague "write tests" instructions remain.

**Type consistency:** `ScreenerResultSortMode` aliases `QuoteSortMode`; `sortScreenerRows` returns copied row arrays; `ResultTable` receives sorted rows and table-scoped control props; `ScreenerDrawer` sorts after `useScreenerRowsLive`.

**NOT in scope:** Backend sorting, persisted sort preferences, Watchlist behavior changes, multi-column sorting, keyboard shortcuts, and adding an icon library.

**What already exists:** Watchlist `QuoteSortMode`, `sortEntriesByChangePct`, and sort icon shapes already solve the core comparison/icon problem. The plan reuses those contracts instead of inventing a parallel screener algorithm.

**Sequential implementation, no parallelization opportunity:** The tasks touch shared frontend sort assets first, then both screener surfaces. Task 1 and Task 2 are prerequisites for the page/drawer wiring, and Tasks 3/4 both touch the screener module, so sequential work avoids churn.

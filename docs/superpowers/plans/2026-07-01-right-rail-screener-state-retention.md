# Right Rail Screener State Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the right-rail screener's recent scan, sort, and update status stable across route changes, panel remounts, and short reloads without presenting stale price snapshots as fresh.

**Architecture:** Move the right-rail screener view session from component-local mutation state into the existing `useScreenerPanelStore`, and persist only bounded, validated snapshot data. Restore saved scan results with a TTL and stale markers; keep backend saved screener definitions as the source of truth for conditions.

**Tech Stack:** TypeScript, React 18, React Router, React Query, Zustand, localStorage, Vitest, Testing Library.

## Global Constraints

- Scope is the right-rail `ScreenerDrawer`; do not change the full `/screener` page persistence in this plan.
- Preserve existing saved screener CRUD behavior and `/api/screener/scan` request shape.
- Persist restored scan rows only with a bounded TTL so old market snapshots do not look fresh after restart.
- Do not add a backend "recent scan" endpoint unless a future requirement needs cross-device restoration.
- Keep corruption handling strict: invalid localStorage fields must be ignored instead of leaking into UI state.
- Keep `selectedSavedId` migration compatibility for existing `screenerPanel.v1` storage.

---

## Architecture Review

### Current Behavior

- `ScreenerDrawer` stores `sortMode` in component-local `useState`, so it resets when the drawer remounts.
- `lastScan` lives in `useScreenerPanelStore`, but it is memory-only and explicitly excluded from localStorage.
- `useScreener` and `useScreenerUpdate` expose React Query mutation state local to the mounted component.
- `App` owns the right rail above the route `Outlet`, so normal SPA navigation should keep the active drawer mounted. Resets observed during navigation are therefore most likely remount, reload, HMR, or state policy mismatches rather than the router intentionally clearing the state.

### Options Considered

#### Option A: Keep Memory-Only Store, Fix Only Local `sortMode`

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| Data freshness | Safe |
| User experience | Partial fix only |
| Maintenance | Low |

**Pros:** Minimal code, no stale snapshot risk.

**Cons:** Does not fix reload-like navigation or dev HMR resets; scan results still disappear by design.

#### Option B: Persist Bounded Right-Rail View Session

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| Data freshness | Safe with TTL and stale badges |
| User experience | Fixes scan/sort restoration for the right rail |
| Maintenance | Fits existing `state/*` persistence pattern |

**Pros:** Local, testable, no backend schema; aligns with right rail as app-wide UI chrome.

**Cons:** localStorage size grows with result rows; must validate rows and expire snapshots.

#### Option C: Backend Recent Scan Resource

| Dimension | Assessment |
|-----------|------------|
| Complexity | High |
| Data freshness | Strong if server versioned |
| User experience | Cross-device/session restoration |
| Maintenance | Adds API, disk model, invalidation rules |

**Pros:** Durable and shareable; can centralize scan history.

**Cons:** Overbuilt for a right-rail UI state issue; backend currently models saved conditions, not transient result views.

### Decision

Use Option B. The right-rail screener state is a local view session, so keep it in the frontend store, persist the minimum needed snapshot, and make freshness explicit. Add backend persistence later only if users need scan history across devices or audited research records.

### Consequences

- Route changes, panel toggles, drawer remounts, and short reloads can restore the last visible right-rail scan.
- Old restored scans are either dropped by TTL or marked stale when data/saved conditions changed.
- Full `/screener` remains intentionally route-local until a separate plan changes it.

---

## File Structure

- Modify: `frontend/src/state/screenerPanel.ts`
  - Owns persisted right-rail screener view session.
  - Validates and hydrates `selectedSavedId`, `lastScan`, and `sortMode`.
  - Keeps update mutation display state in memory.
  - Exports helper predicates for testable staleness and sort validation.

- Modify: `frontend/src/state/screenerPanel.test.ts`
  - Covers persistence, hydration, corruption rejection, TTL expiry, sort mode validation, and update-state transitions.

- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
  - Reads and writes sort/update/scan state through `useScreenerPanelStore`.
  - Stamps scans with `scannedAtMs`, `savedUpdatedAtMs`, and `basis`.
  - Marks last scan stale after a data update succeeds.
  - Shows stale reasons in the result summary.

- Modify: `frontend/src/screener/ScreenerDrawer.test.tsx`
  - Replaces the old "sort not persisted" assertion with "sort restores".
  - Adds remount/navigation-style restoration tests.
  - Adds update success/failure state tests.
  - Adds saved-screener-updated stale warning tests.

- Optional Modify: `frontend/src/App.test.tsx`
  - Add an integration smoke test only if existing App mocks can exercise route changes without excessive setup.

---

### Task 1: Persist and Validate Right-Rail Screener Session State

**Files:**
- Modify: `frontend/src/state/screenerPanel.ts`
- Test: `frontend/src/state/screenerPanel.test.ts`

**Interfaces:**
- Consumes:
  - `ScreenerRow`, `ScreenerResponse`, `ScanBasis` from `frontend/src/api/screener.ts`
  - `ScreenerResultSortMode` from `frontend/src/screener/sortResults.ts`
- Produces:
  - `SCREENER_PANEL_SCAN_TTL_MS: number`
  - `PanelScan` with `scannedAtMs`, `savedUpdatedAtMs`, `basis`, and `dataStale`
  - `PanelUpdateState`
  - `isPanelScanFresh(scan: PanelScan, nowMs?: number): boolean`
  - Store methods: `setSortMode`, `setLastScan`, `markLastScanDataStale`, `clearExpiredScan`, `setUpdatePending`, `setUpdateSuccess`, `setUpdateError`

- [ ] **Step 1: Write failing persistence and validation tests**

Replace `frontend/src/state/screenerPanel.test.ts` with tests that pin the new contract:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SCREENER_PANEL_SCAN_TTL_MS,
  isPanelScanFresh,
  useScreenerPanelStore,
  type PanelScan,
} from './screenerPanel';

const NOW = 1_800_000_000_000;

const SCAN: PanelScan = {
  savedId: 's1',
  savedName: '돌파',
  savedUpdatedAtMs: 10,
  rows: [
    {
      code: '005930',
      name: '삼성전자',
      market: 'KOSPI',
      price: 70000,
      trade_value_won: 100_000_000_000,
      change_pct: 2.1,
    },
  ],
  scanStatus: 'ok',
  warnings: [],
  scannedAtMs: NOW,
  basis: 'intraday',
  dataStale: false,
};

describe('screenerPanel store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useScreenerPanelStore.setState({
      selectedSavedId: null,
      lastScan: null,
      sortMode: 'default',
      updateState: { status: 'idle' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists selected save, last scan, and sort mode', () => {
    useScreenerPanelStore.getState().setSelectedSavedId('s1');
    useScreenerPanelStore.getState().setLastScan(SCAN);
    useScreenerPanelStore.getState().setSortMode({ field: 'change_pct', direction: 'desc' });

    const persisted = JSON.parse(localStorage.getItem('screenerPanel.v1')!);
    expect(persisted.selectedSavedId).toBe('s1');
    expect(persisted.lastScan).toMatchObject({
      savedId: 's1',
      savedUpdatedAtMs: 10,
      scannedAtMs: NOW,
      basis: 'intraday',
      dataStale: false,
    });
    expect(persisted.sortMode).toEqual({ field: 'change_pct', direction: 'desc' });
  });

  it('hydrates a fresh saved scan and sort mode from storage', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: SCAN,
      sortMode: { field: 'price', direction: 'asc' },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toEqual(SCAN);
    expect(fresh.getState().sortMode).toEqual({ field: 'price', direction: 'asc' });
    expect(fresh.getState().updateState).toEqual({ status: 'idle' });
  });

  it('drops expired saved scans during hydration but keeps selectedSavedId', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: { ...SCAN, scannedAtMs: NOW - SCREENER_PANEL_SCAN_TTL_MS - 1 },
      sortMode: { field: 'price', direction: 'asc' },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toBeNull();
    expect(fresh.getState().sortMode).toEqual({ field: 'price', direction: 'asc' });
  });

  it('rejects corrupt scan rows and corrupt sort mode', async () => {
    localStorage.setItem('screenerPanel.v1', JSON.stringify({
      selectedSavedId: 's1',
      lastScan: { ...SCAN, rows: [{ code: 5930 }] },
      sortMode: { field: 'bad', direction: 'sideways' },
    }));
    vi.resetModules();
    vi.setSystemTime(NOW);

    const { useScreenerPanelStore: fresh } = await import('./screenerPanel');

    expect(fresh.getState().selectedSavedId).toBe('s1');
    expect(fresh.getState().lastScan).toBeNull();
    expect(fresh.getState().sortMode).toBe('default');
  });

  it('marks the last scan stale after data update succeeds', () => {
    useScreenerPanelStore.getState().setLastScan(SCAN);
    useScreenerPanelStore.getState().markLastScanDataStale();
    expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(true);
  });

  it('tracks update status in memory without persisting it', () => {
    useScreenerPanelStore.getState().setSelectedSavedId('s1');
    useScreenerPanelStore.getState().setUpdatePending(NOW);
    useScreenerPanelStore.getState().setUpdateError('boom', NOW + 5);

    expect(useScreenerPanelStore.getState().updateState).toEqual({
      status: 'error',
      startedAtMs: NOW,
      finishedAtMs: NOW + 5,
      message: 'boom',
    });
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1')!)).not.toHaveProperty('updateState');
  });

  it('classifies scan freshness by ttl', () => {
    expect(isPanelScanFresh(SCAN, NOW + SCREENER_PANEL_SCAN_TTL_MS)).toBe(true);
    expect(isPanelScanFresh(SCAN, NOW + SCREENER_PANEL_SCAN_TTL_MS + 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the state tests to verify they fail**

Run:

```bash
cd frontend
npm test -- src/state/screenerPanel.test.ts --run
```

Expected: FAIL with missing exports such as `SCREENER_PANEL_SCAN_TTL_MS`, `setSortMode`, or `updateState`.

- [ ] **Step 3: Implement the store contract**

Modify `frontend/src/state/screenerPanel.ts` around the existing store:

```ts
import { create } from 'zustand';
import type { ScanBasis, ScreenerResponse, ScreenerRow } from '../api/screener';
import type {
  ScreenerResultSortDirection,
  ScreenerResultSortField,
  ScreenerResultSortMode,
} from '../screener/sortResults';
import { persistJson, readJsonObject } from './persist';

const STORAGE_KEY = 'screenerPanel.v1';
export const SCREENER_PANEL_SCAN_TTL_MS = 30 * 60 * 1000;

const SORT_FIELDS: readonly ScreenerResultSortField[] = [
  'code',
  'name',
  'market',
  'price',
  'change_pct',
  'trade_value_won',
];
const SORT_DIRECTIONS: readonly ScreenerResultSortDirection[] = ['asc', 'desc'];

export interface PanelScan {
  savedId: string;
  savedName: string;
  savedUpdatedAtMs: number;
  rows: ScreenerRow[];
  scanStatus: ScreenerResponse['status'];
  warnings: string[];
  scannedAtMs: number;
  basis: ScanBasis;
  dataStale: boolean;
}

export type PanelUpdateState =
  | { status: 'idle' }
  | { status: 'pending'; startedAtMs: number }
  | { status: 'success'; startedAtMs: number | null; finishedAtMs: number }
  | { status: 'error'; startedAtMs: number | null; finishedAtMs: number; message: string };

type Persisted = {
  selectedSavedId: string | null;
  lastScan: PanelScan | null;
  sortMode: ScreenerResultSortMode;
};

type Store = Persisted & {
  updateState: PanelUpdateState;
  setSelectedSavedId: (id: string | null) => void;
  setSortMode: (mode: ScreenerResultSortMode) => void;
  setLastScan: (scan: PanelScan) => void;
  markLastScanDataStale: () => void;
  clearExpiredScan: (nowMs?: number) => void;
  setUpdatePending: (startedAtMs: number) => void;
  setUpdateSuccess: (finishedAtMs: number) => void;
  setUpdateError: (message: string, finishedAtMs: number) => void;
};

const DEFAULTS: Persisted = { selectedSavedId: null, lastScan: null, sortMode: 'default' };

function persist(state: Persisted): void {
  persistJson(STORAGE_KEY, state);
}

function persistFromState(state: Store): void {
  persist({
    selectedSavedId: state.selectedSavedId,
    lastScan: state.lastScan,
    sortMode: state.sortMode,
  });
}

function isSortMode(value: unknown): value is ScreenerResultSortMode {
  if (value === 'default') return true;
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.field === 'string'
    && (SORT_FIELDS as readonly string[]).includes(raw.field)
    && typeof raw.direction === 'string'
    && (SORT_DIRECTIONS as readonly string[]).includes(raw.direction)
  );
}

function isMarket(value: unknown): value is ScreenerRow['market'] {
  return value === 'KOSPI' || value === 'KOSDAQ';
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isScreenerRow(value: unknown): value is ScreenerRow {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.code === 'string'
    && typeof raw.name === 'string'
    && isMarket(raw.market)
    && typeof raw.price === 'number'
    && Number.isFinite(raw.price)
    && typeof raw.trade_value_won === 'number'
    && Number.isFinite(raw.trade_value_won)
    && isNumberOrNull(raw.change_pct)
  );
}

function isPanelScan(value: unknown, nowMs = Date.now()): value is PanelScan {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw.scanStatus !== 'ok' && raw.scanStatus !== 'not_seeded' && raw.scanStatus !== 'building') return false;
  if (raw.basis !== 'intraday' && raw.basis !== 'eod') return false;
  if (!Array.isArray(raw.rows) || !raw.rows.every(isScreenerRow)) return false;
  if (!Array.isArray(raw.warnings) || !raw.warnings.every((w) => typeof w === 'string')) return false;
  const scan = raw as Partial<PanelScan>;
  return (
    typeof scan.savedId === 'string'
    && typeof scan.savedName === 'string'
    && typeof scan.savedUpdatedAtMs === 'number'
    && Number.isFinite(scan.savedUpdatedAtMs)
    && typeof scan.scannedAtMs === 'number'
    && Number.isFinite(scan.scannedAtMs)
    && typeof scan.dataStale === 'boolean'
    && isPanelScanFresh(scan as PanelScan, nowMs)
  );
}

export function isPanelScanFresh(scan: PanelScan, nowMs = Date.now()): boolean {
  return nowMs - scan.scannedAtMs <= SCREENER_PANEL_SCAN_TTL_MS;
}

function readStorage(nowMs = Date.now()): Partial<Persisted> {
  const parsed = readJsonObject(STORAGE_KEY);
  const out: Partial<Persisted> = {};
  if (parsed.selectedSavedId === null) out.selectedSavedId = null;
  else if (typeof parsed.selectedSavedId === 'string') out.selectedSavedId = parsed.selectedSavedId;
  if (isPanelScan(parsed.lastScan, nowMs)) out.lastScan = parsed.lastScan;
  if (isSortMode(parsed.sortMode)) out.sortMode = parsed.sortMode;
  return out;
}

const hydrated = readStorage();

export const useScreenerPanelStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...hydrated,
  updateState: { status: 'idle' },

  setSelectedSavedId: (id) => {
    set({ selectedSavedId: id });
    persistFromState(get());
  },

  setSortMode: (sortMode) => {
    set({ sortMode });
    persistFromState(get());
  },

  setLastScan: (scan) => {
    set({ lastScan: scan });
    persistFromState(get());
  },

  markLastScanDataStale: () => {
    const { lastScan } = get();
    if (!lastScan) return;
    set({ lastScan: { ...lastScan, dataStale: true } });
    persistFromState(get());
  },

  clearExpiredScan: (nowMs = Date.now()) => {
    const { lastScan } = get();
    if (!lastScan || isPanelScanFresh(lastScan, nowMs)) return;
    set({ lastScan: null });
    persistFromState(get());
  },

  setUpdatePending: (startedAtMs) => set({ updateState: { status: 'pending', startedAtMs } }),

  setUpdateSuccess: (finishedAtMs) => {
    const prev = get().updateState;
    set({
      updateState: {
        status: 'success',
        startedAtMs: prev.status === 'pending' ? prev.startedAtMs : null,
        finishedAtMs,
      },
    });
  },

  setUpdateError: (message, finishedAtMs) => {
    const prev = get().updateState;
    set({
      updateState: {
        status: 'error',
        startedAtMs: prev.status === 'pending' ? prev.startedAtMs : null,
        finishedAtMs,
        message,
      },
    });
  },
}));
```

- [ ] **Step 4: Run the state tests to verify they pass**

Run:

```bash
cd frontend
npm test -- src/state/screenerPanel.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add frontend/src/state/screenerPanel.ts frontend/src/state/screenerPanel.test.ts
git commit -m "feat: persist right rail screener session state"
```

---

### Task 2: Wire `ScreenerDrawer` to the Session Store

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Test: `frontend/src/screener/ScreenerDrawer.test.tsx`

**Interfaces:**
- Consumes:
  - `useScreenerPanelStore.sortMode`
  - `useScreenerPanelStore.updateState`
  - `useScreenerPanelStore.setSortMode`
  - `useScreenerPanelStore.markLastScanDataStale`
- Produces:
  - Scan snapshots stamped with `savedUpdatedAtMs`, `scannedAtMs`, `basis`, and `dataStale`
  - Stale result summary text for data update and saved definition changes

- [ ] **Step 1: Update drawer tests for persisted sort and remount restoration**

In `frontend/src/screener/ScreenerDrawer.test.tsx`, replace the old `sorts drawer results by displayed change_pct without persisting sort mode` test name and storage expectations with this behavior:

```ts
  it('sorts drawer results by displayed change_pct and restores sort after remount', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    const rows = [
      { code: '005930', name: '삼성전자', market: 'KOSPI' as const, price: 70000, trade_value_won: 1e11, change_pct: 0.1 },
      { code: '000660', name: 'SK하이닉스', market: 'KOSPI' as const, price: 180000, trade_value_won: 2e11, change_pct: 0.2 },
      { code: '035420', name: 'NAVER', market: 'KOSPI' as const, price: 210000, trade_value_won: 3e11, change_pct: 0.3 },
    ];
    vi.spyOn(screenerApi, 'runScan').mockResolvedValue({ status: 'ok', rows, warnings: [] });
    vi.spyOn(client, 'apiCall').mockImplementation(async (path: string) => {
      const codes = (path.split('codes=')[1] ?? '').split(',').filter(Boolean);
      const quoteByCode: Record<string, { price: number; change_pct: number; change_won: number }> = {
        '005930': { price: 70100, change_pct: 2.1, change_won: 100 },
        '000660': { price: 179000, change_pct: -1.2, change_won: -1000 },
        '035420': { price: 212000, change_pct: 4.4, change_won: 2000 },
      };
      return {
        phase: 'open' as const,
        quotes: codes.map((code) => ({ code, ...quoteByCode[code] })),
      };
    });

    const clientForRender = qc();
    const rendered = render(<ScreenerDrawer />, { wrapper: wrap(clientForRender, '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '조회' }));
    await waitFor(() => expect(screen.getByText('NAVER')).toBeInTheDocument());

    const rowOrder = () => screen.getAllByTestId(/^screener-row-/).map((el) => el.dataset.testid);

    fireEvent.click(sortButton());
    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-035420',
      'screener-row-005930',
      'screener-row-000660',
    ]));
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1') ?? '{}').sortMode).toEqual({
      field: 'change_pct',
      direction: 'asc',
    });

    fireEvent.click(sortButton());
    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-000660',
      'screener-row-005930',
      'screener-row-035420',
    ]));
    expect(JSON.parse(localStorage.getItem('screenerPanel.v1') ?? '{}').sortMode).toEqual({
      field: 'change_pct',
      direction: 'desc',
    });

    rendered.unmount();
    render(<ScreenerDrawer />, { wrapper: wrap(clientForRender, '/inventory') });

    await waitFor(() => expect(rowOrder()).toEqual([
      'screener-row-000660',
      'screener-row-005930',
      'screener-row-035420',
    ]));
  });
```

Add a saved-definition stale test near the existing stale selection test:

```ts
  it('flags the last result when the saved screener definition changed after the scan', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({
      schema_version: 1,
      saves: [{ ...SAVE, updated_at_ms: 20 }],
    });
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      sortMode: 'default',
      updateState: { status: 'idle' },
      lastScan: {
        savedId: 's1',
        savedName: '돌파+거래대금',
        savedUpdatedAtMs: 10,
        rows: ROWS,
        scanStatus: 'ok',
        warnings: [],
        scannedAtMs: Date.now(),
        basis: 'intraday',
        dataStale: false,
      },
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });

    await waitFor(() => expect(screen.getByText(/조건 저장본 변경됨/)).toBeInTheDocument());
  });
```

- [ ] **Step 2: Run drawer tests to verify they fail**

Run:

```bash
cd frontend
npm test -- src/screener/ScreenerDrawer.test.tsx --run
```

Expected: FAIL because `ScreenerDrawer` still uses component-local `sortMode` and writes old `PanelScan` shape.

- [ ] **Step 3: Replace component-local sort state with store state**

In `frontend/src/screener/ScreenerDrawer.tsx`, update the imports and store selectors:

```ts
import { useEffect, useMemo } from 'react';
```

Replace:

```ts
  const lastScan = useScreenerPanelStore((s) => s.lastScan);
  const setLastScan = useScreenerPanelStore((s) => s.setLastScan);
  const [sortMode, setSortMode] = useState<ScreenerResultSortMode>('default');
```

with:

```ts
  const lastScan = useScreenerPanelStore((s) => s.lastScan);
  const setLastScan = useScreenerPanelStore((s) => s.setLastScan);
  const sortMode = useScreenerPanelStore((s) => s.sortMode);
  const setSortMode = useScreenerPanelStore((s) => s.setSortMode);
  const clearExpiredScan = useScreenerPanelStore((s) => s.clearExpiredScan);
```

Add this effect after `useScreenerUpdate()`:

```ts
  useEffect(() => {
    clearExpiredScan();
  }, [clearExpiredScan]);
```

- [ ] **Step 4: Stamp scan snapshots with freshness metadata**

Replace the `setLastScan` call inside `runScan`:

```ts
          setLastScan({
            savedId: selected.id,
            savedName: selected.name,
            savedUpdatedAtMs: selected.updated_at_ms,
            rows: res.rows,
            scanStatus: res.status,
            warnings: res.warnings,
            scannedAtMs: Date.now(),
            basis: DRAWER_SCAN_BASIS,
            dataStale: false,
          });
          setSortMode('default');
```

- [ ] **Step 5: Show stale reasons from selected save and update state**

Add stale reason derivation after `notSeeded`:

```ts
  const lastScanStaleReason = (() => {
    if (!lastScan) return null;
    if (selectedSavedId !== lastScan.savedId) return '선택한 조건과 다름';
    if (selected && selected.updated_at_ms !== lastScan.savedUpdatedAtMs) return '조건 저장본 변경됨';
    if (lastScan.dataStale) return '데이터 갱신됨';
    return null;
  })();
```

Replace the existing inline stale summary:

```tsx
              {selectedSavedId !== lastScan.savedId && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · 선택한 조건과 다름 — 조회로 갱신
                </span>
              )}
```

with:

```tsx
              {lastScanStaleReason && (
                <span className="ml-1 normal-case tracking-normal" style={{ color: 'var(--warn)' }}>
                  · {lastScanStaleReason} — 조회로 갱신
                </span>
              )}
```

- [ ] **Step 6: Run drawer tests to verify they pass**

Run:

```bash
cd frontend
npm test -- src/screener/ScreenerDrawer.test.tsx --run
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "feat: restore right rail screener sort and scan"
```

---

### Task 3: Keep Update Status Stable and Mark Results Stale After Data Refresh

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Test: `frontend/src/screener/ScreenerDrawer.test.tsx`

**Interfaces:**
- Consumes:
  - Store methods from Task 1: `setUpdatePending`, `setUpdateSuccess`, `setUpdateError`, `markLastScanDataStale`
- Produces:
  - Button label driven by store-backed pending state
  - Error display driven by store-backed error state
  - Last scan stale marker after successful update

- [ ] **Step 1: Add update status tests**

Add these tests to `frontend/src/screener/ScreenerDrawer.test.tsx` near the existing `갱신` tests:

```ts
  it('keeps update pending status in the screener panel store', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    let resolveUpdate!: () => void;
    vi.spyOn(screenerApi, 'triggerScreenerUpdate').mockImplementation(
      () => new Promise((resolve) => {
        resolveUpdate = () => resolve(undefined);
      }),
    );

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '데이터 갱신' }));

    expect(useScreenerPanelStore.getState().updateState.status).toBe('pending');
    expect(screen.getByRole('button', { name: '갱신 중…' })).toBeDisabled();

    resolveUpdate();

    await waitFor(() => expect(useScreenerPanelStore.getState().updateState.status).toBe('success'));
  });

  it('marks existing scan results stale after data update succeeds', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'triggerScreenerUpdate').mockResolvedValue(undefined as never);
    useScreenerPanelStore.setState({
      selectedSavedId: 's1',
      sortMode: 'default',
      updateState: { status: 'idle' },
      lastScan: {
        savedId: 's1',
        savedName: '돌파+거래대금',
        savedUpdatedAtMs: SAVE.updated_at_ms,
        rows: ROWS,
        scanStatus: 'ok',
        warnings: [],
        scannedAtMs: Date.now(),
        basis: 'intraday',
        dataStale: false,
      },
    });

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '데이터 갱신' }));

    await waitFor(() => expect(screen.getByText(/데이터 갱신됨/)).toBeInTheDocument());
    expect(useScreenerPanelStore.getState().lastScan?.dataStale).toBe(true);
  });

  it('shows stored update errors after the mutation rejects', async () => {
    vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
    vi.spyOn(screenerApi, 'triggerScreenerUpdate').mockRejectedValue(new Error('network down'));

    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(useScreenerPanelStore.getState().selectedSavedId).toBe('s1'));
    fireEvent.click(screen.getByRole('button', { name: '데이터 갱신' }));

    await waitFor(() => expect(screen.getByText(/갱신 실패/)).toBeInTheDocument());
    expect(useScreenerPanelStore.getState().updateState).toMatchObject({
      status: 'error',
      message: 'network down',
    });
  });
```

- [ ] **Step 2: Run drawer tests to verify they fail**

Run:

```bash
cd frontend
npm test -- src/screener/ScreenerDrawer.test.tsx --run
```

Expected: FAIL because update status still comes only from React Query mutation state and does not mark `lastScan.dataStale`.

- [ ] **Step 3: Wire update callbacks to the store**

In `frontend/src/screener/ScreenerDrawer.tsx`, add store selectors next to the other selectors:

```ts
  const updateState = useScreenerPanelStore((s) => s.updateState);
  const setUpdatePending = useScreenerPanelStore((s) => s.setUpdatePending);
  const setUpdateSuccess = useScreenerPanelStore((s) => s.setUpdateSuccess);
  const setUpdateError = useScreenerPanelStore((s) => s.setUpdateError);
  const markLastScanDataStale = useScreenerPanelStore((s) => s.markLastScanDataStale);
```

Add a helper before `return`:

```ts
  const updatePending = updateState.status === 'pending' || update.isPending;
  const updateErrorMessage = updateState.status === 'error' ? updateState.message : null;
  const runUpdate = () => {
    setUpdatePending(Date.now());
    update.mutate(undefined, {
      onSuccess: () => {
        setUpdateSuccess(Date.now());
        markLastScanDataStale();
      },
      onError: (err) => {
        setUpdateError(err instanceof Error && err.message ? err.message : '갱신 실패', Date.now());
      },
    });
  };
```

Replace the update button props and label:

```tsx
            onClick={runUpdate}
            disabled={updatePending || notSeeded}
```

```tsx
            {updatePending ? '갱신 중…' : '갱신'}
```

Replace the error block:

```tsx
        {updateErrorMessage && (
          <RailState tone="error" className="p-0">갱신 실패 — {updateErrorMessage}</RailState>
        )}
```

- [ ] **Step 4: Run drawer tests to verify they pass**

Run:

```bash
cd frontend
npm test -- src/screener/ScreenerDrawer.test.tsx --run
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "feat: retain right rail screener update state"
```

---

### Task 4: Regression Sweep and Documentation Notes

**Files:**
- Modify: `frontend/src/state/screenerPanel.ts`
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Test: no new test file unless the regression sweep exposes a gap

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: verified state retention behavior with no unrelated frontend regression.

- [ ] **Step 1: Run focused frontend tests**

Run:

```bash
cd frontend
npm test -- src/state/screenerPanel.test.ts src/screener/ScreenerDrawer.test.tsx src/state/rightRail.test.ts src/rightrail/RightRail.test.tsx --run
```

Expected: PASS.

- [ ] **Step 2: Run typecheck/build**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS. The TypeScript build should accept the widened `PanelScan` and store selectors.

- [ ] **Step 3: Manual QA in browser**

Run the app using the repo's normal dev command:

```bash
cd frontend
npm run dev
```

Manual checks:

1. Open right rail screener.
2. Select a saved condition and click `조회`.
3. Sort by change rate.
4. Navigate to `Inventory`, `Heatmap`, and back to `Live`.
5. Confirm the right rail still shows the same scan and sort.
6. Close and reopen the right rail screener.
7. Confirm the same scan and sort still render.
8. Click `갱신`.
9. Confirm the button shows `갱신 중…` while pending.
10. Confirm existing results remain visible with `데이터 갱신됨 — 조회로 갱신`.
11. Click `조회`.
12. Confirm the stale marker clears and sort resets to default.

- [ ] **Step 4: Inspect localStorage size and contents**

In browser devtools, inspect `localStorage["screenerPanel.v1"]`.

Expected:

```json
{
  "selectedSavedId": "s1",
  "lastScan": {
    "savedId": "s1",
    "savedName": "돌파+거래대금",
    "savedUpdatedAtMs": 1,
    "rows": [],
    "scanStatus": "ok",
    "warnings": [],
    "scannedAtMs": 1800000000000,
    "basis": "intraday",
    "dataStale": false
  },
  "sortMode": "default"
}
```

The actual `rows` array may contain many entries. If saved scans regularly exceed localStorage limits, stop and revisit Option C or add a persisted row cap before shipping.

- [ ] **Step 5: Commit verification-only doc/test adjustments if any**

If no files changed during the sweep, skip this commit. If test comments or docs changed:

```bash
git add frontend/src/state/screenerPanel.ts frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "test: verify right rail screener state retention"
```

---

## Self-Review

- Spec coverage: The plan covers scan result retention, sort retention, update status retention, stale data signaling, TTL expiry, and corruption-safe hydration for the right-rail drawer.
- Scope control: The full `/screener` page is explicitly out of scope because it has separate local mutation state and different editing responsibilities.
- Placeholder scan: clean.
- Type consistency: `PanelScan`, `PanelUpdateState`, `ScreenerResultSortMode`, and store method names are defined in Task 1 and consumed consistently in Tasks 2-3.
- Risk: Persisting large result rows may pressure localStorage. Task 4 includes an explicit localStorage size check and a stop condition.

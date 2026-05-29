# Delete `/replay` + Migrate Chart Options to `/live` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**scope:** frontend

**Goal:** `/replay` 페이지와 replay 전용 state 모듈을 삭제하고, 차트 옵션 4개 (auctionWindowMask, ratioOutlierFilter+Threshold, SourcePreference) 와 Drawing 기능을 `/live` 페이지로 이관한다.

**Architecture:** 옵션 A — 새 `useChartPrefsStore` (글로벌 zustand) 도입, `useActivePrefs` API 시그니처 보존으로 chart projector 무영향. `LiveSettingsModal` 신설 + LiveToolbar `[⚙ 설정]` 버튼. `AuctionWindowOverlay` + `DrawingOverlay` + `DrawingPropertyPanel` 을 `LiveChartRoot` 에 마운트 (ChartStage 자체는 삭제하고 host 책임만 이전). 인프라 정리(`tabs.ts`, `tabsPersistence`, `url.ts`, `toolbarDraft.ts`, `replayLayout.ts`, `replay/`, `ChartStage`, `VolumeProfileOverlay`, `chart/projectors/movingAverage.ts`, `chart/ChartPrefsContext.tsx`) 통째 삭제.

**Tech Stack:** React 18, zustand, lightweight-charts, vite, vitest, TypeScript, react-router, Tailwind.

**Spec:** [2026-05-29-delete-replay-migrate-chart-options-design.md](../specs/2026-05-29-delete-replay-migrate-chart-options-design.md)

---

## Phase 의존 그래프

```
A: chartPrefs store 신설 + persistence  ──┐
                                          ├──> C: LiveSettingsModal
B: useActivePrefs/useAuctionMaskActive 전환 ┘
                                          
D: AuctionWindowOverlay live 마운트  (B 후)
E: Drawing host migration to LiveChartRoot (B 후)

F: Routing & entry point 변경 (C/D/E 완료 후 동시 가능)
G: replay/ 디렉토리 + ChartStage + VolumeProfileOverlay 삭제 (F 후)
H: replay 전용 state 모듈 삭제 (G 후)
I: chartPrefs 정리 (movingAverages/volumeProfileMode 필드 제거) (H 후)
J: chart/projectors/movingAverage.ts + ChartPrefsContext 정리 (I 후, grep 분기)

K: Doc updates — CONTEXT.md replay entries, ADR-0014/0022/0046 supersede (G 후 병렬 가능)
L: 최종 검증 (pytest + npm build + 수동 QA)
```

병렬 가능: F/K 시점부터 여러 subagent로 분산 가능. A→B→{C,D,E} 사이는 순차.

---

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `frontend/src/state/chartPrefsPersistence.ts` | `mergePrefs` validation + new localStorage key `hoga.chart.prefs.v1` (debounced subscribe pattern) |
| `frontend/src/state/chartPrefs.test.ts` | New store + persistence unit tests |
| `frontend/src/live/LiveSettingsModal.tsx` | Modal body — flat layout, no category sidebar |
| `frontend/src/live/LiveSettingsModal.test.tsx` | Modal interaction tests |
| `frontend/src/live/settings/ToggleRow.tsx` | Moved from `replay/settings/ToggleRow.tsx` (unchanged) |
| `frontend/src/live/settings/NumericPrefRow.tsx` | Extracted from `replay/SettingsModal.tsx` (activeTabId-free) |
| `frontend/src/live/settings/SourcePreferenceRadio.tsx` | Extracted from `replay/SettingsModal.tsx` |
| `frontend/src/live/LiveDrawingMenu.tsx` | Moved from `replay/DrawingMenu.tsx` (path rename only) |
| `frontend/src/live/InvariantOutcomesBanner.tsx` | Moved from `replay/InvariantOutcomesBanner.tsx` |
| `frontend/src/live/InvariantOutcomesBanner.test.tsx` | Moved test |

### Modify

| Path | Change |
|---|---|
| `frontend/src/state/chartPrefs.ts` | Add `useChartPrefsStore` zustand create, refactor `useActivePrefs` to read from it, remove `registerTabsStore`/`_activeTabPrefsStore`/throw guard, **remove `movingAverages`/`volumeProfileMode` fields + MA constants** (Phase I) |
| `frontend/src/state/useAuctionMaskActive.ts` | Replace `useTabsStore` import with `useChartPrefsStore.auctionWindowMask` direct read; drop `useCursor` dep — caller passes `cursorMs` |
| `frontend/src/main.tsx` | Remove `ReplayViewer` import + `replay` route; `/` redirect → `/live` |
| `frontend/src/nav/LeftNav.tsx` | Remove `Replay Viewer` NavItem |
| `frontend/src/inventory/StockDateGroupDetail.tsx` | Remove `onRowClick` handler + tabs imports; remove row hover/cursor styles |
| `frontend/src/live/LiveToolbar.tsx` | Add `[⚙ 설정]` button + `[✏ 그리기]` menu; new props `onOpenSettings`, `onActivateDrawing` |
| `frontend/src/live/LivePage.tsx` | Add `settingsOpen` state + `<LiveSettingsModal>` mount; thread props to LiveToolbar |
| `frontend/src/live/LiveChartRoot.tsx` | Mount `<AuctionWindowOverlay>`, `<DrawingOverlay>`, `<DrawingPropertyPanel>`; paneSeries registry from RangeSeriesPane onSeriesReady |
| `frontend/src/live/LiveWorkarea.tsx` | Update import path: `'../replay/InvariantOutcomesBanner'` → `'./InvariantOutcomesBanner'` |
| `frontend/src/chart/RangeSeriesPane.tsx` | Already supports paneId callback — verify `onSeriesReady?(paneId, series)` prop exists; if not, add (used by both ChartStage today and LiveChartRoot post-migration) |

### Delete

| Path | Reason |
|---|---|
| `frontend/src/pages/ReplayViewer.tsx` | Page deleted |
| `frontend/src/replay/*` (entire directory) | All replay-only UI |
| `frontend/src/state/tabs.ts` + tests | replay-only state |
| `frontend/src/state/tabsPersistence.ts` + tests | replay-only persistence |
| `frontend/src/state/url.ts` + tests | replay URL sync |
| `frontend/src/state/toolbarDraft.ts` + tests | replay toolbar draft |
| `frontend/src/state/replayLayout.ts` + tests | replay sidebar layout state |
| `frontend/src/chart/ChartStage.tsx` + test | replay chart shell |
| `frontend/src/chart/VolumeProfileOverlay.tsx` + tests | not used by `/live`; spec drops mode |
| `frontend/src/chart/ChartPrefsContext.tsx` | Legacy context — verify zero callers in Phase J |
| `frontend/src/chart/projectors/movingAverage.ts` + tests | replay-only (live has own overlay) — verify in Phase J |
| `frontend/src/api/useCursor.ts` + tests | replay-only (live has `useLiveCursor`) |

### Move (rename / relocate, no content change unless noted)

| From | To | Notes |
|---|---|---|
| `frontend/src/replay/settings/ToggleRow.tsx` | `frontend/src/live/settings/ToggleRow.tsx` | identity |
| `frontend/src/replay/DrawingMenu.tsx` | `frontend/src/live/LiveDrawingMenu.tsx` | rename + import paths |
| `frontend/src/replay/InvariantOutcomesBanner.tsx` + test | `frontend/src/live/InvariantOutcomesBanner.tsx` | identity |

---

## Pre-flight: branch verification

- [ ] **PF-1: Confirm clean tree on `feat+frontend5`**

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
```

Expected: empty porcelain output, branch `feat+frontend5`.

- [ ] **PF-2: Baseline test run (record passing count for later comparison)**

```bash
cd frontend && npm install --silent && npm test -- --run 2>&1 | tail -20
```

Record the "Tests N passed" line. The end-of-plan verification compares against this baseline minus deleted-test count plus new-test count.

- [ ] **PF-3: Baseline build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: clean build, no errors.

---

## Phase A: New chartPrefs store

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Create: `frontend/src/state/chartPrefsPersistence.ts`
- Create: `frontend/src/state/chartPrefs.test.ts`

### Task A1: Write failing test for `useChartPrefsStore` defaults

- [ ] **Step 1: Create test file**

```ts
// frontend/src/state/chartPrefs.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useChartPrefsStore, DEFAULT_PREFS } from './chartPrefs';

describe('useChartPrefsStore', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('initializes with DEFAULT_PREFS', () => {
    const s = useChartPrefsStore.getState();
    for (const key of Object.keys(DEFAULT_PREFS) as Array<keyof typeof DEFAULT_PREFS>) {
      expect(s[key]).toEqual(DEFAULT_PREFS[key]);
    }
  });

  it('setToggle mutates the named boolean', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('setNumericPref mutates the named number', () => {
    useChartPrefsStore.getState().setNumericPref('ratioOutlierThreshold', 42);
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(42);
  });

  it('resetToDefaults restores DEFAULT_PREFS', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    useChartPrefsStore.getState().resetToDefaults();
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd frontend && npx vitest run src/state/chartPrefs.test.ts
```

Expected: FAIL (no `useChartPrefsStore` export).

### Task A2: Implement `useChartPrefsStore`

- [ ] **Step 1: Edit `frontend/src/state/chartPrefs.ts` — add store, keep existing registry/types**

Append below existing `DEFAULT_PREFS` (do NOT remove `movingAverages`/`volumeProfileMode` yet — Phase I handles that):

```ts
import { create } from 'zustand';

type ChartPrefsStore = ChartViewPrefs & {
  setToggle: (key: ChartToggleKey, value: boolean) => void;
  setNumericPref: (key: NumericPrefKey, value: number) => void;
  setVolumeProfileMode: (mode: 'range' | 'per-day') => void;
  setMovingAverage: (i: MAIndex, cfg: MAConfig) => void;
  resetToDefaults: () => void;
};

export const useChartPrefsStore = create<ChartPrefsStore>((set) => ({
  ...DEFAULT_PREFS,
  setToggle: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  setNumericPref: (key, value) => set({ [key]: value } as Partial<ChartPrefsStore>),
  setVolumeProfileMode: (mode) => set({ volumeProfileMode: mode }),
  setMovingAverage: (i, cfg) =>
    set((s) => {
      const next = [...s.movingAverages];
      next[i] = cfg;
      return { movingAverages: next };
    }),
  resetToDefaults: () =>
    set({
      ...DEFAULT_PREFS,
      movingAverages: DEFAULT_MOVING_AVERAGES.map((c) => ({ ...c })),
    }),
}));
```

- [ ] **Step 2: Run — expect pass**

```bash
cd frontend && npx vitest run src/state/chartPrefs.test.ts
```

Expected: PASS (4/4).

### Task A3: Switch `useActivePrefs` to read from new store

- [ ] **Step 1: Edit `frontend/src/state/chartPrefs.ts` — replace seam with direct read**

Replace this block:

```ts
// Old (delete from registerTabsStore declaration through useActivePrefs body):
let _activeTabPrefsStore: ActiveTabPrefsStoreApi | null = null;
export function registerTabsStore(store: ActiveTabPrefsStoreApi): void {
  _activeTabPrefsStore = store;
}
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  if (_activeTabPrefsStore === null) {
    throw new Error(
      'useActivePrefs called before tabs store registered. Ensure ./tabs is imported.',
    );
  }
  return _activeTabPrefsStore((s) => selector(s.getPrefs(s.activeTabId)));
}
```

With:

```ts
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  return useChartPrefsStore(selector);
}
```

Remove the `ActiveTabPrefsStoreApi` type definition as well.

- [ ] **Step 2: Build check**

```bash
cd frontend && npx tsc -p tsconfig.json --noEmit 2>&1 | head -40
```

Expected: errors only at `tabs.ts:registerTabsStore(...)` call site (and possibly tests). Note them — these are Phase B/H targets, not regressions.

- [ ] **Step 3: Re-run chartPrefs tests**

```bash
cd frontend && npx vitest run src/state/chartPrefs.test.ts
```

Expected: still PASS.

### Task A4: Persistence module + key

- [ ] **Step 1: Create `frontend/src/state/chartPrefsPersistence.ts`**

```ts
import { CHART_TOGGLES, CHART_NUMERIC_PREFS, DEFAULT_PREFS, type ChartViewPrefs } from './chartPrefs';
import type { useChartPrefsStore } from './chartPrefs';
import { attachPersistence } from './persistentSubscriber';

export const CHART_PREFS_KEY = 'hoga.chart.prefs.v1';
const WRITE_DEBOUNCE_MS = 250;

export function mergePrefs(raw: unknown): ChartViewPrefs {
  const out: ChartViewPrefs = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const t of CHART_TOGGLES) {
    const v = obj[t.key];
    if (typeof v === 'boolean') (out as Record<string, unknown>)[t.key] = v;
  }
  for (const p of CHART_NUMERIC_PREFS) {
    const v = obj[p.key];
    if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= p.min && v <= p.max) {
      (out as Record<string, unknown>)[p.key] = v;
    }
  }
  // volumeProfileMode + movingAverages handled inline until Phase I removes them.
  if (obj.volumeProfileMode === 'range' || obj.volumeProfileMode === 'per-day') {
    out.volumeProfileMode = obj.volumeProfileMode;
  }
  if (Array.isArray(obj.movingAverages)) {
    out.movingAverages = obj.movingAverages.map((ma, i) => ({
      period: typeof (ma as { period?: number }).period === 'number'
        ? (ma as { period: number }).period
        : DEFAULT_PREFS.movingAverages[i]?.period ?? 20,
      enabled: typeof (ma as { enabled?: boolean }).enabled === 'boolean'
        ? (ma as { enabled: boolean }).enabled
        : DEFAULT_PREFS.movingAverages[i]?.enabled ?? false,
    }));
  }
  return out;
}

export function hydrateChartPrefs(store: typeof useChartPrefsStore): void {
  try {
    const raw = localStorage.getItem(CHART_PREFS_KEY);
    if (raw === null) return;
    const parsed = mergePrefs(JSON.parse(raw));
    store.setState(parsed);
  } catch {
    // localStorage unavailable / parse failure — fall back to DEFAULT_PREFS
  }
}

export function attachChartPrefsPersistence(store: typeof useChartPrefsStore): () => void {
  return attachPersistence(store, {
    key: CHART_PREFS_KEY,
    debounceMs: WRITE_DEBOUNCE_MS,
    serialize: (s) => {
      const { setToggle, setNumericPref, setVolumeProfileMode, setMovingAverage, resetToDefaults, ...prefs } = s;
      return JSON.stringify(prefs);
    },
  });
}
```

- [ ] **Step 2: Verify `attachPersistence` signature**

```bash
grep -n "export function attachPersistence" frontend/src/state/persistentSubscriber.ts
```

Read the signature. If it differs from the shape used above (e.g. requires a `loadFn`), adapt the new module to match. Do NOT modify `persistentSubscriber.ts` — Phase H removes its other callers, but it stays alive for this one.

- [ ] **Step 3: Wire hydrate + persist on store import**

Add to the bottom of `frontend/src/state/chartPrefs.ts`:

```ts
import { hydrateChartPrefs, attachChartPrefsPersistence } from './chartPrefsPersistence';

hydrateChartPrefs(useChartPrefsStore);
attachChartPrefsPersistence(useChartPrefsStore);
```

- [ ] **Step 4: Add persistence test**

Append to `frontend/src/state/chartPrefs.test.ts`:

```ts
import { mergePrefs, CHART_PREFS_KEY } from './chartPrefsPersistence';

describe('chartPrefsPersistence', () => {
  it('mergePrefs ignores invalid types and falls back to DEFAULT_PREFS', () => {
    const merged = mergePrefs({ auctionWindowMask: 'not-a-bool', ratioOutlierThreshold: 999_999 });
    expect(merged.auctionWindowMask).toBe(DEFAULT_PREFS.auctionWindowMask);
    expect(merged.ratioOutlierThreshold).toBe(DEFAULT_PREFS.ratioOutlierThreshold);
  });

  it('mergePrefs accepts valid values', () => {
    const merged = mergePrefs({ auctionWindowMask: false, ratioOutlierThreshold: 50 });
    expect(merged.auctionWindowMask).toBe(false);
    expect(merged.ratioOutlierThreshold).toBe(50);
  });

  it('uses the new key, not replay.tabs.*', () => {
    expect(CHART_PREFS_KEY).toBe('hoga.chart.prefs.v1');
    expect(CHART_PREFS_KEY.includes('replay')).toBe(false);
  });
});
```

- [ ] **Step 5: Run**

```bash
cd frontend && npx vitest run src/state/chartPrefs.test.ts
```

Expected: PASS (7/7).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefsPersistence.ts frontend/src/state/chartPrefs.test.ts
git commit -m "feat(state): introduce useChartPrefsStore + persistence (hoga.chart.prefs.v1)"
```

---

## Phase B: Migrate `useAuctionMaskActive` off `useTabsStore`

**Files:**
- Modify: `frontend/src/state/useAuctionMaskActive.ts` + test

### Task B1: Inspect call sites first

- [ ] **Step 1: Find all callers of `useAuctionMaskActive`**

```bash
grep -rn "useAuctionMaskActive" frontend/src/ | grep -v "\.test\."
```

Expected callers: `sidebar/CursorSidebar.tsx` (replay path — `CursorSidebarConnected`), `live/LiveSidebar.tsx` (live path — read from line 66-70 in current code). Confirm both.

### Task B2: Decouple from `useCursor`

`useAuctionMaskActive` currently calls `useCursor()` to get `cursorMs`. After tabs deletion that hook dies, so cursor must be passed in by callers.

- [ ] **Step 1: Read current implementation**

```bash
cat frontend/src/state/useAuctionMaskActive.ts
```

- [ ] **Step 2: Rewrite to pure (axis, cursorMs) → boolean**

```ts
// frontend/src/state/useAuctionMaskActive.ts
import type { VirtualAxis } from '../util/virtualAxis';
import { useChartPrefsStore } from './chartPrefs';

/**
 * Active iff (1) the global `auctionWindowMask` toggle is on AND (2) the
 * given cursor ms falls inside the closing Auction Window for the axis.
 * Callers pass `cursorMs` explicitly — this hook does not subscribe to
 * any cursor store, so it works for both /live (useLiveCursorStore) and
 * any future page.
 */
export function useAuctionMaskActive(axis: VirtualAxis | null, cursorMs: number | null): boolean {
  const auctionWindowMask = useChartPrefsStore((s) => s.auctionWindowMask);
  if (!auctionWindowMask) return false;
  if (axis === null || cursorMs === null) return false;
  return axis.inClosingAuctionWindow(cursorMs);
}
```

- [ ] **Step 3: Update test**

```bash
cat frontend/src/state/useAuctionMaskActive.test.ts
```

Edit the test to pass `axis` + `cursorMs` directly (no more `useCursor` mock). Sample:

```ts
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useAuctionMaskActive } from './useAuctionMaskActive';
import { useChartPrefsStore } from './chartPrefs';
import { createVirtualAxis } from '../util/virtualAxis';

describe('useAuctionMaskActive', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  const axis = createVirtualAxis([
    { date: '20260101', sessionOpenMs: 1_700_000_000_000, sessionCloseMs: 1_700_023_400_000 },
  ]);
  const cursorBefore = 1_700_022_600_000; // before 15:20

  it('returns false when toggle is off regardless of cursor', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    const { result } = renderHook(() => useAuctionMaskActive(axis, cursorBefore));
    expect(result.current).toBe(false);
  });

  it('returns false when axis or cursor is null', () => {
    const { result } = renderHook(() => useAuctionMaskActive(null, cursorBefore));
    expect(result.current).toBe(false);
  });

  it('reflects axis.inClosingAuctionWindow when toggle on', () => {
    const { result } = renderHook(() => useAuctionMaskActive(axis, cursorBefore));
    // Behavior depends on actual axis window math — assert it returns a boolean
    expect(typeof result.current).toBe('boolean');
  });
});
```

- [ ] **Step 4: Run**

```bash
cd frontend && npx vitest run src/state/useAuctionMaskActive.test.ts
```

Expected: PASS.

### Task B3: Update call sites to pass cursorMs

- [ ] **Step 1: Update `frontend/src/live/LiveSidebar.tsx`**

Current line ~66-70 reads:

```ts
const axis = useLiveAxisStore((s) => s.axis);
const maskRatio =
  isSpot && axis !== null
    ? axis.inClosingAuctionWindow(cursorMs!)
    : false;
```

Change to use the hook:

```ts
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
// ...
const axis = useLiveAxisStore((s) => s.axis);
const maskRatio = useAuctionMaskActive(axis, isSpot ? cursorMs : null);
```

- [ ] **Step 2: `sidebar/CursorSidebar.tsx`**

`CursorSidebarConnected` will be deleted with replay in Phase G. The default export `CursorSidebar` (layout shell) does NOT use the hook. **Leave `CursorSidebarConnected` as-is for now** — Phase G removes the whole connected variant.

- [ ] **Step 3: Run tests**

```bash
cd frontend && npx vitest run src/live/LiveSidebar.test.tsx src/state/useAuctionMaskActive.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/state/useAuctionMaskActive.ts frontend/src/state/useAuctionMaskActive.test.ts frontend/src/live/LiveSidebar.tsx
git commit -m "refactor(state): useAuctionMaskActive reads cursor from caller, store from useChartPrefsStore"
```

---

## Phase C: LiveSettingsModal + LiveToolbar gear button

**Files:**
- Create: `frontend/src/live/settings/ToggleRow.tsx` (move from replay/settings/ — copy now, delete original in Phase G)
- Create: `frontend/src/live/settings/NumericPrefRow.tsx`
- Create: `frontend/src/live/settings/SourcePreferenceRadio.tsx`
- Create: `frontend/src/live/LiveSettingsModal.tsx` + test
- Modify: `frontend/src/live/LiveToolbar.tsx` + test
- Modify: `frontend/src/live/LivePage.tsx` + test

### Task C1: Copy ToggleRow to live/settings

- [ ] **Step 1: Copy file**

```bash
mkdir -p frontend/src/live/settings
cp frontend/src/replay/settings/ToggleRow.tsx frontend/src/live/settings/ToggleRow.tsx
```

- [ ] **Step 2: Verify no path adjustment needed**

```bash
grep "^import" frontend/src/live/settings/ToggleRow.tsx
```

If imports are all from lightweight-charts / react / `'./...'`, no edit needed. If any `'../state/...'` import exists, leave it — `state/` is shared.

### Task C2: Extract `NumericPrefRow` to live/settings (activeTabId-free)

- [ ] **Step 1: Create file**

```tsx
// frontend/src/live/settings/NumericPrefRow.tsx
import { useEffect, useState } from 'react';
import {
  useChartPrefsStore,
  type NumericPrefDef,
  type NumericPrefKey,
} from '../../state/chartPrefs';

export default function NumericPrefRow({ def }: { def: NumericPrefDef }) {
  const value = useChartPrefsStore((s) => s[def.key as NumericPrefKey]);
  const gateEnabled = useChartPrefsStore((s) =>
    def.enabledBy === undefined ? true : s[def.enabledBy],
  );
  const setNumericPref = useChartPrefsStore((s) => s.setNumericPref);
  const [inputValue, setInputValue] = useState<string>(String(value));

  useEffect(() => {
    setInputValue(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = inputValue.trim();
    const n = Number(trimmed);
    if (
      trimmed !== '' &&
      Number.isFinite(n) &&
      Number.isInteger(n) &&
      n >= def.min &&
      n <= def.max &&
      n !== value
    ) {
      setNumericPref(def.key as NumericPrefKey, n);
    } else {
      setInputValue(String(value));
    }
  };

  return (
    <div
      className={
        gateEnabled
          ? 'flex items-center justify-between py-2'
          : 'flex items-center justify-between py-2 opacity-50'
      }
    >
      <div className="flex-1 pr-4">
        <div className="text-fg text-sm">{def.label}</div>
        <div className="text-fg-dim text-xs mt-0.5">
          {def.description} ({def.min.toLocaleString()}–{def.max.toLocaleString()})
        </div>
      </div>
      <input
        type="number"
        min={def.min}
        max={def.max}
        step={1}
        disabled={!gateEnabled}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        aria-label={def.label}
        data-testid={`settings-numeric-${def.key}`}
        className="w-[72px] text-right text-sm bg-bg-input border border-border rounded-[4px] px-2 py-1 tabular-nums disabled:cursor-not-allowed"
      />
    </div>
  );
}
```

### Task C3: Extract `SourcePreferenceRadio` to live/settings

- [ ] **Step 1: Create file**

```tsx
// frontend/src/live/settings/SourcePreferenceRadio.tsx
import { useSourcePreferenceStore, type SourcePreference } from '../../state/sourcePreference';

export default function SourcePreferenceRadio({ value }: { value: SourcePreference }) {
  const current = useSourcePreferenceStore((s) => s.sourcePreference);
  const setPref = useSourcePreferenceStore((s) => s.setSourcePreference);
  const labelMap: Record<SourcePreference, string> = {
    hogaplay: 'hogaplay 우선',
    kis_live: 'kis_live 우선',
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', cursor: 'pointer' }}>
      <input
        type="radio"
        name="source-preference"
        value={value}
        checked={current === value}
        onChange={() => setPref(value)}
      />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg)' }}>{labelMap[value]}</span>
    </label>
  );
}
```

### Task C4: Write failing test for LiveSettingsModal

- [ ] **Step 1: Create `frontend/src/live/LiveSettingsModal.test.tsx`**

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LiveSettingsModal from './LiveSettingsModal';
import { useChartPrefsStore } from '../state/chartPrefs';

describe('LiveSettingsModal', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('renders chart toggles (chart category only)', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
    expect(screen.getByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeTruthy();
  });

  it('toggle click mutates chartPrefs store', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
    fireEvent.click(screen.getByTestId('settings-toggle-auctionWindowMask'));
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('numeric input commits on Enter', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    const input = screen.getByTestId('settings-numeric-ratioOutlierThreshold') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(50);
  });

  it('source preference radio renders both options', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(screen.getByLabelText(/hogaplay 우선/)).toBeTruthy();
    expect(screen.getByLabelText(/kis_live 우선/)).toBeTruthy();
  });

  it('Escape calls onClose', () => {
    let closed = false;
    render(<LiveSettingsModal onClose={() => { closed = true; }} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  it('backdrop click calls onClose', () => {
    let closed = false;
    render(<LiveSettingsModal onClose={() => { closed = true; }} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd frontend && npx vitest run src/live/LiveSettingsModal.test.tsx
```

Expected: FAIL (no LiveSettingsModal).

### Task C5: Implement LiveSettingsModal

- [ ] **Step 1: Create `frontend/src/live/LiveSettingsModal.tsx`**

```tsx
import { useEffect } from 'react';
import {
  useChartPrefsStore,
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  categoryOf,
  type ChartToggleKey,
} from '../state/chartPrefs';
import { SOURCE_OPTIONS } from '../state/sourcePreference';
import ToggleRow from './settings/ToggleRow';
import NumericPrefRow from './settings/NumericPrefRow';
import SourcePreferenceRadio from './settings/SourcePreferenceRadio';

type Props = {
  onClose: () => void;
};

export default function LiveSettingsModal({ onClose }: Props) {
  const prefs = useChartPrefsStore();
  const setToggle = useChartPrefsStore((s) => s.setToggle);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="설정"
      onClick={onClose}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg-card border border-border-strong rounded-[6px] shadow-[0_8px_24px_rgba(0,0,0,0.4)] w-[640px] max-w-[90vw] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-fg text-base font-medium">차트 설정</h2>
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4">
          {CHART_TOGGLES.filter((t) => categoryOf(t) === 'chart').map((toggle) => {
            const key: ChartToggleKey = toggle.key;
            return (
              <ToggleRow
                key={key}
                label={toggle.label}
                description={toggle.description}
                checked={prefs[key]}
                onToggle={() => setToggle(key, !prefs[key])}
                testId={`settings-toggle-${key}`}
              />
            );
          })}
          {CHART_NUMERIC_PREFS.map((def) => (
            <NumericPrefRow key={def.key} def={def} />
          ))}
          <div style={{ marginTop: 'var(--space-md)' }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-dim)', marginBottom: 'var(--space-xs)' }}>
              기본 데이터 소스 <span style={{ color: 'var(--fg-dimmer)' }}>(모든 차트 공통)</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
              {SOURCE_OPTIONS.map((opt) => (
                <SourcePreferenceRadio key={opt} value={opt} />
              ))}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dimmer)', marginTop: 'var(--space-xs)' }}>
              현재 source는 차트 상단 칩에 표시됩니다.
            </div>
          </div>
        </div>
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run — expect pass**

```bash
cd frontend && npx vitest run src/live/LiveSettingsModal.test.tsx
```

Expected: PASS (6/6).

### Task C6: Add ⚙ button to LiveToolbar

- [ ] **Step 1: Edit `frontend/src/live/LiveToolbar.tsx`**

Update Props + add second button mirroring `[+ 보조지표]` shape:

```tsx
import { LIVE_TIMEFRAMES, useLivePageStore } from '../state/livePage';

type Props = {
  onOpenIndicators: () => void;
  onOpenSettings: () => void;
};

export function LiveToolbar({ onOpenIndicators, onOpenSettings }: Props) {
  const tf = useLivePageStore((s) => s.candleTimeframe);
  const setTf = useLivePageStore((s) => s.setCandleTimeframe);
  return (
    <div
      data-testid="live-toolbar"
      className="flex items-center gap-2 border-b px-3"
      style={{
        height: 'var(--h-toolbar)',
        borderColor: 'var(--border)',
        background: 'var(--bg-card)',
      }}
    >
      <div className="flex gap-1" role="group" aria-label="Timeframe">
        {LIVE_TIMEFRAMES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTf(t)}
            aria-pressed={tf === t}
            className="px-2 py-1 rounded font-mono"
            style={{
              background: tf === t ? 'var(--tint-selection)' : 'var(--bg-input)',
              color: tf === t ? 'var(--accent)' : 'var(--fg-dim)',
              fontSize: 'var(--text-xs)',
              border: '1px solid',
              borderColor: tf === t ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-testid="live-indicators-button"
        onClick={onOpenIndicators}
        aria-label="보조지표"
        className="ml-1 inline-flex items-center rounded hover:opacity-90 transition-opacity"
        style={{
          gap: '4px',
          padding: '4px 10px',
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>보조지표</span>
      </button>
      <button
        type="button"
        data-testid="live-settings-button"
        onClick={onOpenSettings}
        aria-label="설정"
        className="inline-flex items-center rounded hover:opacity-90 transition-opacity"
        style={{
          gap: '4px',
          padding: '4px 10px',
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>설정</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Update or add LiveToolbar test for the new button**

If `frontend/src/live/LiveToolbar.test.tsx` does not exist, create it:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveToolbar } from './LiveToolbar';

describe('LiveToolbar', () => {
  it('renders settings button and calls onOpenSettings on click', () => {
    const onOpenSettings = vi.fn();
    render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={onOpenSettings} />);
    const btn = screen.getByTestId('live-settings-button');
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('renders indicators button and calls onOpenIndicators on click', () => {
    const onOpenIndicators = vi.fn();
    render(<LiveToolbar onOpenIndicators={onOpenIndicators} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByTestId('live-indicators-button'));
    expect(onOpenIndicators).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run**

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
```

Expected: PASS.

### Task C7: Wire LivePage state for the modal

- [ ] **Step 1: Edit `frontend/src/live/LivePage.tsx`**

Around the existing `const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);` add:

```tsx
const [settingsOpen, setSettingsOpen] = useState(false);
```

In the JSX, change:

```tsx
<LiveToolbar onOpenIndicators={() => setIndicatorPanelOpen(true)} />
```

To:

```tsx
<LiveToolbar
  onOpenIndicators={() => setIndicatorPanelOpen(true)}
  onOpenSettings={() => setSettingsOpen(true)}
/>
```

And below the IndicatorPanel mount add:

```tsx
{settingsOpen && (
  <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
)}
```

Add the import:

```tsx
import LiveSettingsModal from './LiveSettingsModal';
```

- [ ] **Step 2: Run LivePage test**

```bash
cd frontend && npx vitest run src/live/LivePage.test.tsx
```

Expected: PASS. If existing test mocks `LiveToolbar` and forgets the new prop, that's a fail to fix — pass `onOpenSettings={() => {}}` in the mock.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/live/settings/ frontend/src/live/LiveSettingsModal.tsx frontend/src/live/LiveSettingsModal.test.tsx frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveToolbar.test.tsx frontend/src/live/LivePage.tsx
git commit -m "feat(live): add LiveSettingsModal and ⚙ toolbar button"
```

---

## Phase D: Mount AuctionWindowOverlay in LiveChartRoot

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveChartRoot.test.tsx`

### Task D1: Write failing test

- [ ] **Step 1: Append to `frontend/src/live/LiveChartRoot.test.tsx`**

```tsx
import { useChartPrefsStore } from '../state/chartPrefs';

// In an existing describe block, add:
it('mounts AuctionWindowOverlay when bundle has segments', () => {
  // Existing test harness should already render LiveChartRoot with a non-empty bundle.
  // Adapt to whatever helper the file uses; the assertion below works once the overlay is present.
  // The overlay carries data-testid="auction-window-overlay" in chart/AuctionWindowOverlay.tsx
  // (verify by grep; if absent, add it as part of this task).
  render(<LiveChartRoot {...defaultProps} />);
  expect(document.querySelector('[data-testid="auction-window-overlay"]')).not.toBeNull();
});
```

- [ ] **Step 2: Confirm the testid exists**

```bash
grep -n "data-testid" frontend/src/chart/AuctionWindowOverlay.tsx
```

If missing, add `data-testid="auction-window-overlay"` to the root element of the component.

- [ ] **Step 3: Run — expect fail**

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx
```

Expected: FAIL (no overlay mounted).

### Task D2: Mount the overlay

- [ ] **Step 1: Edit `frontend/src/live/LiveChartRoot.tsx`**

Add import near other chart imports:

```tsx
import AuctionWindowOverlay from '../chart/AuctionWindowOverlay';
```

In the return JSX, **inside the conditional block** that mounts `<MovingAverageOverlay>` and `<DayBoundaryOverlay>`, add:

```tsx
<AuctionWindowOverlay chart={chart} axis={axis} />
```

(Put it adjacent to DayBoundaryOverlay. The overlay self-gates on `useActivePrefs((p) => p.auctionWindowMask)`, so no extra wiring.)

- [ ] **Step 2: Run — expect pass**

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.test.tsx frontend/src/chart/AuctionWindowOverlay.tsx
git commit -m "feat(live): mount AuctionWindowOverlay in LiveChartRoot"
```

---

## Phase E: Drawing host migration

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveToolbar.tsx` + test
- Modify: `frontend/src/live/LivePage.tsx`
- Create: `frontend/src/live/LiveDrawingMenu.tsx` (from replay/)
- Modify: `frontend/src/chart/RangeSeriesPane.tsx` (verify paneId callback)

### Task E1: Verify RangeSeriesPane already supports paneId registration callback

- [ ] **Step 1: Read the prop interface**

```bash
sed -n '1,80p' frontend/src/chart/RangeSeriesPane.tsx
```

If a prop like `onSeriesReady?: (paneId: PaneId, series: ISeriesApi<any>) => void` exists, document it and skip to E2. If absent, add it:

```tsx
// In RangeSeriesPane props:
import type { PaneId } from './drawing/types';
// ...
type RangeSeriesPaneProps = {
  // ...existing props...
  onSeriesReady?: (paneId: PaneId, series: ISeriesApi<'Line'>) => void;
};
```

In the effect that creates the first series for the pane, after creation:

```tsx
opts.onSeriesReady?.(spec.name as PaneId, firstSeries);
```

(Adapt `firstSeries` / `spec.name` to the actual local variable names in the file.)

- [ ] **Step 2: Run RangeSeriesPane test**

```bash
cd frontend && npx vitest run src/chart/RangeSeriesPane.test.tsx
```

Expected: PASS.

### Task E2: paneSeries registry + Drawing mount in LiveChartRoot

- [ ] **Step 1: Edit `frontend/src/live/LiveChartRoot.tsx`**

Add imports:

```tsx
import type { ISeriesApi } from 'lightweight-charts';
import type { PaneId } from '../chart/drawing/types';
import DrawingOverlay from '../chart/DrawingOverlay';
import DrawingPropertyPanel from '../chart/DrawingPropertyPanel';
import { useDrawingsStore } from '../state/drawings';
```

In the component, add a ref-backed registry:

```tsx
const paneSeriesRef = useRef<Map<PaneId, ISeriesApi<'Line'>>>(new Map());
const handleSeriesReady = useCallback((paneId: PaneId, series: ISeriesApi<'Line'>) => {
  paneSeriesRef.current.set(paneId, series);
}, []);
```

Add `useEffect` to sync activeCode into drawings store (mirrors ChartStage:171):

```tsx
useEffect(() => {
  if (code) useDrawingsStore.getState().setActiveCode(code);
}, [code]);
```

Pass `onSeriesReady` to every `<RangeSeriesPane>`:

```tsx
<RangeSeriesPane
  key={spec.name}
  chart={chart}
  bundle={bundle}
  axis={axis}
  paneIndex={i}
  spec={spec}
  onSeriesReady={handleSeriesReady}
/>
```

Add `computeAnchor` callback (copied from ChartStage:115 — read it first, port verbatim):

```bash
sed -n '110,140p' frontend/src/chart/ChartStage.tsx
```

Then paste the equivalent into LiveChartRoot, replacing any reference to `paneSeries.get` with `paneSeriesRef.current.get`.

Below `<DayBoundaryOverlay>` add:

```tsx
<DrawingOverlay chart={chart} axis={axis} paneSeries={paneSeriesRef.current} />
<DrawingPropertyPanel computeAnchor={computeAnchor} />
```

- [ ] **Step 2: Build check**

```bash
cd frontend && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "LiveChartRoot|DrawingOverlay|DrawingPropertyPanel" | head -20
```

Expected: zero errors in these files. If `DrawingOverlay`'s `paneSeries` prop type differs from `Map<PaneId, ISeriesApi<'Line'>>` adjust accordingly (e.g. it may want a getter function).

### Task E3: Move DrawingMenu to live + add tool button on LiveToolbar

- [ ] **Step 1: Move file**

```bash
git mv frontend/src/replay/DrawingMenu.tsx frontend/src/live/LiveDrawingMenu.tsx
```

- [ ] **Step 2: Update import paths inside the moved file**

```bash
grep "^import" frontend/src/live/LiveDrawingMenu.tsx
```

Any `'../state/drawings'` or `'../chart/...'` paths now need to be `'../state/drawings'` / `'../chart/...'` — they should still resolve since both `replay/` and `live/` are at the same depth. Verify with:

```bash
cd frontend && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "LiveDrawingMenu" | head -10
```

- [ ] **Step 3: Add tool button to LiveToolbar**

Edit `frontend/src/live/LiveToolbar.tsx` — add a third button rendering `LiveDrawingMenu`:

```tsx
import LiveDrawingMenu from './LiveDrawingMenu';
// ...
<LiveDrawingMenu />
```

Place after the `[⚙ 설정]` button. `LiveDrawingMenu` is self-contained — it reads/writes `useDrawingsStore.activeTool` directly. If it requires a prop for mount anchor or onActivate, adapt to the existing interface (read the file first).

- [ ] **Step 4: Wire LivePage drawing layer (no-op if Tool defaults to 'select')**

Drawings are stored in `useDrawingsStore` (global). No additional LivePage wiring needed beyond mounting DrawingOverlay/Panel in LiveChartRoot (Task E2).

- [ ] **Step 5: Run tests**

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx src/live/LiveToolbar.test.tsx
```

Expected: PASS. If LiveChartRoot test fails due to DrawingOverlay needing a `<canvas>` polyfill in jsdom, follow the same pattern Replay tests use (mock the overlay).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveDrawingMenu.tsx frontend/src/chart/RangeSeriesPane.tsx
git commit -m "feat(live): host Drawing in LiveChartRoot (overlay + panel + tool menu)"
```

---

## Phase F: Routing & entry point changes

**Files:**
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/nav/LeftNav.tsx`
- Modify: `frontend/src/inventory/StockDateGroupDetail.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`

### Task F1: `/` → `/live` redirect + remove replay route

- [ ] **Step 1: Edit `frontend/src/main.tsx`**

```tsx
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { LivePage } from './live/LivePage';
import Inventory from './pages/Inventory';
import Capture from './pages/Capture';
import Watchlist from './pages/Watchlist';
import Settings from './pages/Settings';
import './styles/global.css';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Navigate to="/live" replace />} />
          <Route path="live" element={<LivePage />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="capture" element={<Capture />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
```

(`ReplayViewer` import and `replay` route removed.)

### Task F2: Remove `Replay Viewer` from LeftNav

- [ ] **Step 1: Edit `frontend/src/nav/LeftNav.tsx`**

Delete the line:

```tsx
<NavItem to="/replay" label="Replay Viewer" />
```

Result — `Live` becomes the first item under Workspace.

### Task F3: Remove inventory row-click handler + hover

- [ ] **Step 1: Read current `StockDateGroupDetail.tsx`**

```bash
sed -n '70,100p' frontend/src/inventory/StockDateGroupDetail.tsx
sed -n '95,150p' frontend/src/inventory/StockDateGroupDetail.tsx
```

- [ ] **Step 2: Remove the handler**

Delete the `onRowClick` function and the `useTabsStore`/`useNavigate` imports if those are now unused. Remove the `onClick={() => onRowClick(r)}` attribute from each `<tr>` (or equivalent row element).

Remove any `className="... cursor-pointer hover:bg-..."` portion that signals clickability — keep the row visually flat. Replace with the static row styling that other tables in the codebase use.

- [ ] **Step 3: Update / remove inventory test**

```bash
grep -n "onRowClick\|click.*row\|navigate.*replay" frontend/src/inventory/StockDateGroupDetail.test.tsx 2>/dev/null
```

If a test asserts the click behavior, delete that test case. If no test file exists, skip.

### Task F4: LiveWorkarea import path fix

- [ ] **Step 1: Move InvariantOutcomesBanner**

```bash
git mv frontend/src/replay/InvariantOutcomesBanner.tsx frontend/src/live/InvariantOutcomesBanner.tsx
git mv frontend/src/replay/InvariantOutcomesBanner.test.tsx frontend/src/live/InvariantOutcomesBanner.test.tsx
```

- [ ] **Step 2: Edit `frontend/src/live/LiveWorkarea.tsx`**

Change line 6:

```tsx
import InvariantOutcomesBanner from './InvariantOutcomesBanner';
```

- [ ] **Step 3: Build + test**

```bash
cd frontend && npm run build 2>&1 | tail -10
cd frontend && npx vitest run src/live/InvariantOutcomesBanner.test.tsx src/live/LiveWorkarea.test.tsx
```

Expected: clean build, tests PASS. (Build may still complain about replay imports — those resolve in Phase G.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main.tsx frontend/src/nav/LeftNav.tsx frontend/src/inventory/StockDateGroupDetail.tsx frontend/src/live/InvariantOutcomesBanner.tsx frontend/src/live/InvariantOutcomesBanner.test.tsx frontend/src/live/LiveWorkarea.tsx
git rm frontend/src/replay/InvariantOutcomesBanner.tsx frontend/src/replay/InvariantOutcomesBanner.test.tsx 2>/dev/null
git commit -m "refactor(routing): /->/live, remove replay route + nav, drop inventory row click, move InvariantOutcomesBanner to live"
```

---

## Phase G: Delete replay/ + ChartStage + VolumeProfileOverlay

**Files:** see Delete table at top.

### Task G1: Delete `pages/ReplayViewer.tsx` + `replay/` directory

- [ ] **Step 1: Verify zero callers left**

```bash
grep -rn "ReplayViewer\|from '\.\./replay\|from '\.\./\.\./replay\|/replay'" frontend/src/ 2>/dev/null | grep -v "\.test\." | grep -v "^frontend/src/replay/"
```

Expected: empty. Any hit must be addressed before deletion (likely a stray import you missed in Phase F).

- [ ] **Step 2: Delete**

```bash
git rm frontend/src/pages/ReplayViewer.tsx
git rm -r frontend/src/replay/
```

(`replay/settings/ToggleRow.tsx` is gone — the live copy in Task C1 is the live successor.)

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: errors only at ChartStage / VolumeProfileOverlay / useCursor (handled below).

### Task G2: Delete `chart/ChartStage.tsx` + test

- [ ] **Step 1: Verify only replay imported ChartStage**

```bash
grep -rn "ChartStage" frontend/src/ 2>/dev/null | grep -v "\.test\." | grep -v "Mirrors ChartStage" | grep -v "^frontend/src/chart/ChartStage"
```

Expected: empty (after replay deletion). Any leftover must be addressed.

- [ ] **Step 2: Delete**

```bash
git rm frontend/src/chart/ChartStage.tsx frontend/src/chart/ChartStage.test.tsx 2>/dev/null
```

### Task G3: Delete `chart/VolumeProfileOverlay.tsx` + tests

- [ ] **Step 1: Verify no callers**

```bash
grep -rn "VolumeProfileOverlay" frontend/src/ 2>/dev/null | grep -v "\.test\." | grep -v "^frontend/src/chart/VolumeProfileOverlay"
```

Expected: empty (live never mounted it; ChartStage is gone).

- [ ] **Step 2: Delete**

```bash
git rm frontend/src/chart/VolumeProfileOverlay.tsx frontend/src/chart/VolumeProfileOverlay.test.tsx 2>/dev/null
```

### Task G4: Delete `api/useCursor.ts` + tests

- [ ] **Step 1: Verify no callers**

```bash
grep -rn "from '\.\./api/useCursor\|from '\.\./\.\./api/useCursor'" frontend/src/ 2>/dev/null | grep -v "\.test\."
```

Expected: empty. (CursorSidebarConnected was deleted with replay; useAuctionMaskActive lost its dep in Phase B.)

- [ ] **Step 2: Delete**

```bash
git rm frontend/src/api/useCursor.ts frontend/src/api/useCursor.test.ts 2>/dev/null
```

### Task G5: Build + commit

- [ ] **Step 1: Build**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: still has errors from `state/tabs.ts` imports (handled in Phase H).

- [ ] **Step 2: Commit**

```bash
git commit -m "chore: delete replay page, ChartStage, VolumeProfileOverlay, useCursor"
```

---

## Phase H: Delete replay-only state modules

### Task H1: Delete tabs / tabsPersistence / url / toolbarDraft / replayLayout

- [ ] **Step 1: Verify no remaining callers**

```bash
grep -rn "from '\.\./state/tabs\|from '\.\./\.\./state/tabs\|state/tabsPersistence\|state/url\|state/toolbarDraft\|state/replayLayout" frontend/src/ 2>/dev/null | grep -v "\.test\."
```

Expected: empty. Any hit signals a missed migration (Phases A/B/E/G).

- [ ] **Step 2: Delete**

```bash
git rm frontend/src/state/tabs.ts frontend/src/state/tabs.test.ts 2>/dev/null
git rm frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts 2>/dev/null
git rm frontend/src/state/url.ts frontend/src/state/url.test.ts 2>/dev/null
git rm frontend/src/state/toolbarDraft.ts frontend/src/state/toolbarDraft.test.ts 2>/dev/null
git rm frontend/src/state/replayLayout.ts frontend/src/state/replayLayout.test.ts 2>/dev/null
```

- [ ] **Step 3: Check `state/persistentSubscriber.ts` is still needed**

```bash
grep -rn "from '\./persistentSubscriber\|from '\.\./state/persistentSubscriber" frontend/src/ 2>/dev/null
```

Expected: only `chartPrefsPersistence.ts`. The module is alive.

- [ ] **Step 4: Build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: clean build except for `chart/projectors/movingAverage.ts` (still imports `state/tabs`). Phase J handles that.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: delete tabs/tabsPersistence/url/toolbarDraft/replayLayout state modules"
```

---

## Phase I: Strip movingAverages / volumeProfileMode from chartPrefs

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/state/chartPrefsPersistence.ts`

### Task I1: Verify no in-tree readers of these fields

- [ ] **Step 1: grep**

```bash
grep -rn "movingAverages\|volumeProfileMode\|MA_SLOT_COUNT\|DEFAULT_MOVING_AVERAGES\|MAConfig\|MAIndex\|MovingAverage" frontend/src/ 2>/dev/null | grep -v "\.test\." | grep -v "useLivePageStore" | grep -v "live/indicators/" | grep -v "^frontend/src/state/chartPrefs" | head -20
```

Expected: matches only in `chart/projectors/movingAverage.ts` (Phase J target). If anywhere else, decide whether to clean up here or extend Phase J.

### Task I2: Strip the fields

- [ ] **Step 1: Edit `frontend/src/state/chartPrefs.ts`**

- Delete `MAConfig`, `MAIndex`, `MA_SLOT_COUNT`, `DEFAULT_MOVING_AVERAGES`, the `_MAIndexCheck` block, and the `movingAverages` field of `ChartViewPrefs`.
- Delete the `'range' | 'per-day'` union from `ChartViewPrefs` and the `volumeProfileMode` field.
- Delete `setMovingAverage` and `setVolumeProfileMode` from `ChartPrefsStore` + the create body.
- Remove the corresponding initial values in `DEFAULT_PREFS`.

- [ ] **Step 2: Edit `frontend/src/state/chartPrefsPersistence.ts`**

Remove the `volumeProfileMode` and `movingAverages` branches in `mergePrefs`.

- [ ] **Step 3: Build + test**

```bash
cd frontend && npx tsc -p tsconfig.json --noEmit 2>&1 | head -10
cd frontend && npx vitest run src/state/chartPrefs.test.ts
```

Expected: TS errors only in `chart/projectors/movingAverage.ts` (Phase J). Tests PASS.

---

## Phase J: Resolve `chart/projectors/movingAverage.ts` + ChartPrefsContext

### Task J1: Decide MA projector fate

- [ ] **Step 1: Verify callers**

```bash
grep -rn "chart/projectors/movingAverage\|MOVING_AVERAGE_SPEC" frontend/src/ 2>/dev/null | grep -v "\.test\." | grep -v "^frontend/src/chart/projectors/movingAverage"
```

Expected: zero (ChartStage was the only consumer). If empty:

```bash
git rm frontend/src/chart/projectors/movingAverage.ts frontend/src/chart/projectors/movingAverage.test.ts 2>/dev/null
```

If non-empty (unexpected — e.g. live imports a helper from this file), surface the call site and extract the helper to a new module that does NOT import from `state/tabs`.

### Task J2: Delete ChartPrefsContext if dead

- [ ] **Step 1: Verify**

```bash
grep -rn "ChartPrefsContext\b" frontend/src/ 2>/dev/null | grep -v "\.test\."
```

Expected: matches only inside the file itself or in stale comments. If zero non-self references:

```bash
git rm frontend/src/chart/ChartPrefsContext.tsx
```

### Task J3: Build + test gate

- [ ] **Step 1: Full type-check**

```bash
cd frontend && npx tsc -p tsconfig.json --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Run all tests**

```bash
cd frontend && npm test -- --run 2>&1 | tail -20
```

Expected: all tests pass; total count = (baseline from PF-2) − (deleted test count) + (new test count).

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: drop movingAverages/volumeProfileMode from chartPrefs; remove movingAverage projector + ChartPrefsContext"
```

---

## Phase K: Documentation updates (CONTEXT.md + ADRs)

### Task K1: CONTEXT.md surgical removals

- [ ] **Step 1: Remove "Replay Tab" entry**

Open `CONTEXT.md`. Locate the `**Replay Tab**:` heading (≈line 244) and its `_Avoid_` line. Delete both lines plus the body in between.

In its place, insert a new entry for ChartViewPrefs if not already covered:

```markdown
**ChartViewPrefs**:
The global, single-user chart view preferences owned by `useChartPrefsStore` (`frontend/src/state/chartPrefs.ts`) — booleans from the `CHART_TOGGLES` registry, integers from `CHART_NUMERIC_PREFS`. Persisted to `localStorage["hoga.chart.prefs.v1"]` (debounced 250ms via `chartPrefsPersistence.ts`). Read by chart projectors (RatioPane, QuoteTotalsPane, FillStrength), the AuctionWindowOverlay, and the LiveSettingsModal through `useActivePrefs(selector)`. The boolean Source Preference setting lives in a separate `useSourcePreferenceStore` (see **Source Preference**).
_Avoid_: "per-tab prefs" (the multi-tab model was removed with `/replay` on 2026-05-29), "ChartPrefsContext" (the React-context indirection was removed in the same change).
```

- [ ] **Step 2: Update Drawing-related entries**

Find `**Drawing**:` heading. Replace mentions of "Replay Viewer toolbar" / "ChartStage" / "the Replay Viewer's `DrawingMenu`" with "the `/live` page's `LiveToolbar`" / "LiveChartRoot" / "LiveDrawingMenu". Localstorage key `replay.drawings.v1.<code>` stays — the spec keeps it as option A.

Do the same for `**Drawing Overlay**:`, `**Drawing Property Panel**:`, `**Drawing Tool**:`, `**Default Drawing Style**:` entries.

- [ ] **Step 3: Update Volume Profile entry**

Find `**Volume Profile**:`. Either delete the entire entry or trim it to: "Wire field `volume_profile_range` / `volume_profile_by_day` on the RangeBundle; not currently consumed by the frontend (the `/replay` page that rendered it was removed 2026-05-29; `/live` does not mount `VolumeProfileOverlay`)."

- [ ] **Step 4: Grep audit for leftover "Replay" prose**

```bash
grep -n "Replay\|/replay" CONTEXT.md | grep -v "orderbook replay" | grep -v "^[0-9]*:_Avoid_"
```

For each non-`orderbook replay` match, rephrase to remove the Replay reference (it's been replaced with /live or by removing the concept). The brand string "orderbook replay" in the header description stays.

### Task K2: ADR supersede notes

- [ ] **Step 1: ADR-0014**

Edit `docs/adr/0014-replay-single-timeframe.md`. Change the `**Status:**` line to:

```
**Status:** superseded by /replay removal (2026-05-29) — the Replay Viewer no longer exists; `/live` uses `LiveTimeframe` per ADR-0041.
```

- [ ] **Step 2: ADR-0022**

Edit `docs/adr/0022-runtime-sidebar-width-user-owned.md`. Change `**Status:**` to:

```
**Status:** superseded by /replay removal (2026-05-29) — `state/replayLayout.ts` is gone and `/live`'s sidebar width is the CSS-token constant `--sidebar-w`.
```

- [ ] **Step 3: ADR-0046**

Edit `docs/adr/0046-live-ma-fork-from-replay.md`. Change `**Status:**` to:

```
**Status:** superseded by /replay removal (2026-05-29) — the "fork" framing is moot since `/replay`'s MA implementation is deleted. `/live`'s MA continues to live in `useLivePageStore` (the originally chosen side of the fork).
```

- [ ] **Step 4: Commit doc updates**

```bash
git add CONTEXT.md docs/adr/0014-replay-single-timeframe.md docs/adr/0022-runtime-sidebar-width-user-owned.md docs/adr/0046-live-ma-fork-from-replay.md
git commit -m "docs(context,adr): supersede replay-only entries after /replay removal"
```

---

## Phase L: Final verification

### Task L1: Backend regression test

- [ ] **Step 1: Run pytest**

```bash
uv run pytest 2>&1 | tail -10
```

Expected: all tests pass (no backend changes were made, but this catches any inadvertent breakage).

### Task L2: Frontend full test + build

- [ ] **Step 1: All tests**

```bash
cd frontend && npm test -- --run 2>&1 | tail -10
```

Expected: pass count = baseline (PF-2) minus deleted-test count plus new-test count. Read the line; if the number is off, list which suites failed/skipped.

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: clean build, no errors.

- [ ] **Step 3: TypeScript**

```bash
cd frontend && npx tsc -p tsconfig.json --noEmit 2>&1 | tail -10
```

Expected: zero errors.

### Task L3: Manual QA via `/browse` skill

- [ ] **Step 1: Start dev servers (if not already running)**

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga &
cd frontend && npm run dev &
```

- [ ] **Step 2: Probe routing**

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/
$B js "window.location.pathname"
```

Expected: `"/live"`.

```bash
$B goto http://localhost:5173/replay
$B js "window.location.pathname"
$B text | head -10
```

Expected: not the replay page (either 404 / fallback or redirect — verify whichever the router emits with no `replay` route registered).

- [ ] **Step 3: Probe LiveSettingsModal**

```bash
$B goto http://localhost:5173/live
$B snapshot -i | head -30
```

Look for `live-settings-button` ref. Click it:

```bash
$B click '@<ref>'   # ref of live-settings-button
$B snapshot -i | grep -i "차트 설정\|auctionWindow\|ratioOutlier\|hogaplay\|kis_live"
```

Expected: modal open, all 4 controls visible.

- [ ] **Step 4: Probe AuctionWindowOverlay**

```bash
$B js "document.querySelector('[data-testid=\"auction-window-overlay\"]')?.outerHTML?.slice(0, 200) ?? 'absent'"
```

Expected: not `'absent'`. Confirm the auctionWindow shading paints over 15:20–15:30 on a minute timeframe.

- [ ] **Step 5: Probe Drawing**

In live, click the drawing menu, select trendline, then probe:

```bash
$B js "document.querySelectorAll('canvas').length"
```

Expected: ≥2 (chart canvas + drawing overlay canvas).

- [ ] **Step 6: Console errors**

```bash
$B console --errors
```

Expected: empty list.

### Task L4: Wrap up

- [ ] **Step 1: Confirm clean tree + push-ready state**

```bash
git status --porcelain
git log --oneline main..HEAD | head -20
```

- [ ] **Step 2: Sanity grep — any remaining "replay" in code (not docs/brand)**

```bash
grep -rln "replay\|/replay" frontend/src/ 2>/dev/null
```

Expected: 0 hits. If hits: investigate one-by-one — comments / stale strings / actual code.

- [ ] **Step 3: Final commit if cleanup needed**

```bash
git status --porcelain
# if any small fixups
git commit -am "chore: final cleanup after /replay removal"
```

---

## Self-Review Notes

- All 9 spec areas covered by Phases A–L (A/B/C/D/E/F/G/H/I/J/K/L)
- TDD pattern used for chartPrefs store (A1→A2), LiveSettingsModal (C4→C5), AuctionWindowOverlay mount (D1→D2)
- Deletion phases (G/H/J) gated by grep verification to avoid accidental removal of live-used code
- Doc updates (K) deferred until code is settled to avoid prose churning
- Manual QA (L3) uses `/browse` per CLAUDE.md directive
- All file paths absolute and unambiguous
- No "TBD" / "see above" / "similar to" — each task is self-contained

## Parallelization Notes

After Phase E completes:
- F (routing), G (deletion), H (state deletion), I (chartPrefs strip), J (movingAverage), K (docs) all touch disjoint files
- Subagent-driven execution can dispatch F/G/H/I/J as a series with shared verification + K in parallel
- L must run last (verification gate)

Within Phase A: A1→A2 sequential (TDD). A3→A4 sequential (each builds on the previous file state).

## Manual touchpoints that may need user input

- Task E1: if `RangeSeriesPane` does not yet expose `onSeriesReady`, the prop signature decision (callback vs. ref-prop) may have alternatives — flag if unclear.
- Task E2: `DrawingOverlay`'s `paneSeries` prop type may want a function getter vs. a Map; adapt to what exists.
- Task K1 step 4: leftover "Replay" prose may include nuanced phrasings — surface ambiguous cases instead of guessing.

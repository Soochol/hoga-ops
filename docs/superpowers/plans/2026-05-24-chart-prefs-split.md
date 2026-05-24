# Chart Prefs Split + useActivePrefs + ChartPrefsContext Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Split chart-pref types/constants out of `tabs.ts` into `chartPrefs.ts`, introduce a `useActivePrefs<T>(selector)` helper there, delete `ChartPrefsContext.tsx`, and migrate 6 consumers. Three coupled deepenings landed together because they share the same read-path surface.

**Architecture:** `chartPrefs.ts` owns chart-pref types/constants + the canonical read helper. `tabs.ts` shrinks to store + actions + persistence. Consumers subscribe to fine-grained slices via `useActivePrefs((p) => p.foo)` directly against the store, eliminating the Context layer.

**Tech Stack:** TypeScript, React, Zustand, Vitest (jsdom).

**Spec:** [docs/superpowers/specs/2026-05-24-chart-prefs-split-design.md](../specs/2026-05-24-chart-prefs-split-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `frontend/src/state/chartPrefs.ts` | NEW | Types + constants + `useActivePrefs`. |
| `frontend/src/state/chartPrefs.test.ts` | NEW | `useActivePrefs` subscription tests. |
| `frontend/src/state/tabs.ts` | MODIFY | Drop type/const defs; import + re-export from `chartPrefs`. |
| `frontend/src/chart/ChartPrefsContext.tsx` | DELETE | No longer needed. |
| `frontend/src/chart/ChartStage.tsx` | MODIFY | Drop `<ChartPrefsProvider>` wrap. |
| `frontend/src/chart/AuctionWindowOverlay.tsx` | MODIFY | `useChartPrefs` → `useActivePrefs`. |
| `frontend/src/chart/VolumeProfileOverlay.tsx` | MODIFY | Same. |
| `frontend/src/chart/projectors/ratio.ts` | MODIFY | Same. |
| `frontend/src/chart/projectors/quoteTotals.ts` | MODIFY | Same. |
| `frontend/src/chart/projectors/movingAverage.ts` | MODIFY | Same. |

**Not touched:** `tabs.test.ts`, `tabsPersistence.ts`, `persistentSubscriber.ts`, `useAuctionMaskActive.ts`, `auctionMask.ts`, `SettingsModal.tsx`.

---

## Task 1: Create `chartPrefs.ts` with types + constants (no helper yet)

**Files:**
- Create: `frontend/src/state/chartPrefs.ts`
- Modify: `frontend/src/state/tabs.ts`

This task is a pure code move. `tabs.ts` continues to type-check via re-export.

- [ ] **Step 1: Read current `tabs.ts` lines 22-95**

Run: `sed -n '22,95p' frontend/src/state/tabs.ts`

You'll see: `CHART_TOGGLES`, `ChartToggleKey`, `MAConfig`, `MA_SLOT_COUNT`, `MAIndex`, `_MAIndexCheck`, `DEFAULT_MOVING_AVERAGES`, `ChartViewPrefs`, `TOGGLE_DEFAULTS`, `DEFAULT_PREFS` definitions plus their docstrings. Copy these verbatim.

- [ ] **Step 2: Create `frontend/src/state/chartPrefs.ts`**

Paste the lines from Step 1 at the top. Then add at the bottom:

```ts
// useActivePrefs lives in this module too (Task 3). Adding the import
// here would create an unused-import error until then; deferred to T3.
```

The file at this point: just types + constants. No imports needed (everything is self-contained). No `useTabsStore` reference yet.

- [ ] **Step 3: Modify `tabs.ts` to re-export from `chartPrefs.ts`**

Remove the duplicated definitions (the lines you copied in Step 1). Replace with re-exports near the top of `tabs.ts`, after the existing imports:

```ts
// Re-export chart-pref types + constants. These moved to ./chartPrefs but
// many consumers still import from './tabs'; re-exports keep them working
// during the migration window. Direct imports from './chartPrefs' are
// encouraged for new code.
export {
  CHART_TOGGLES,
  DEFAULT_MOVING_AVERAGES,
  DEFAULT_PREFS,
  MA_SLOT_COUNT,
} from './chartPrefs';
export type {
  ChartToggleKey,
  ChartViewPrefs,
  MAConfig,
  MAIndex,
} from './chartPrefs';

import {
  CHART_TOGGLES,
  DEFAULT_PREFS,
  MA_SLOT_COUNT,
  type ChartViewPrefs,
} from './chartPrefs';
```

(Both `export { ... } from` and the bare `import` are needed because `tabs.ts`'s store code uses these values at runtime — re-exporting alone doesn't bring them into the local scope.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b` from `frontend/`. Expected: clean.

- [ ] **Step 5: Run the full state/ suite**

Run: `npx vitest run src/state/`. Expected: ALL passing (no test changes; existing tests import `useTabsStore`, `DEFAULT_MOVING_AVERAGES`, etc. from `./tabs` and still get them via re-export).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/tabs.ts
git commit -m "refactor(state): split chart pref types + constants into chartPrefs.ts"
```

---

## Task 2: Add `useActivePrefs<T>(selector)` helper + smoke test

**Files:**
- Modify: `frontend/src/state/chartPrefs.ts`
- Create: `frontend/src/state/chartPrefs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/state/chartPrefs.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivePrefs } from './chartPrefs';
import { useTabsStore } from './tabs';

describe('useActivePrefs — scaffold', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('returns the default for the active tab when no override exists', () => {
    const { result } = renderHook(() => useActivePrefs((p) => p.volumeProfileMode));
    expect(result.current).toBe('range');
  });

  it('reflects setVolumeProfileMode on the active tab', () => {
    const { result } = renderHook(() => useActivePrefs((p) => p.volumeProfileMode));
    expect(result.current).toBe('range');
    act(() => {
      const id = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    });
    expect(result.current).toBe('per-day');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/chartPrefs.test.ts`. Expected: FAIL — `useActivePrefs` not exported.

- [ ] **Step 3: Implement `useActivePrefs`**

Append to `frontend/src/state/chartPrefs.ts` (replace the placeholder comment from Task 1 Step 2):

```ts
import { useTabsStore } from './tabs';

/**
 * Subscribe to a slice of the active tab's `ChartViewPrefs`.
 *
 * Fine-grained: re-renders only when the selected slice changes (by
 * Zustand's default `Object.is` equality). Use this in chart components
 * and projectors instead of reading the whole prefs object — RatioPane
 * shouldn't re-render when the user flips `volumeProfileMode`.
 *
 * Replaces the prior `useChartPrefs()` + `ChartPrefsContext` pattern,
 * which threaded the whole prefs object through context and forced
 * every consumer to re-render on any pref change.
 */
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  return useTabsStore((s) => selector(s.getPrefs(s.activeTabId)));
}
```

The `import` is at the bottom of the file (after types/constants) on purpose — keeps top-of-file scannable for the read-only domain shape; the runtime hook + its `useTabsStore` import sit together at the bottom.

- [ ] **Step 4: Run tests + typecheck**

```bash
npx vitest run src/state/chartPrefs.test.ts
npx tsc -b
```

Expected: 2 tests passing; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/chartPrefs.ts frontend/src/state/chartPrefs.test.ts
git commit -m "feat(state): useActivePrefs — fine-grained selector over active tab prefs"
```

---

## Task 3: Fine-grained re-render test (proves the perf gain)

**Files:** `frontend/src/state/chartPrefs.test.ts`

- [ ] **Step 1: Add the failing test**

Append:

```ts
describe('useActivePrefs — fine-grained subscription', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('does not re-render when an unselected slice changes', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useActivePrefs((p) => p.volumeProfileMode);
    });
    expect(renders).toBe(1);
    expect(result.current).toBe('range');

    // Mutate a DIFFERENT slice (auctionWindowMask) — should not re-render
    // this hook because the selected value (volumeProfileMode) didn't change.
    act(() => {
      const id = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    });
    expect(renders).toBe(1);
    expect(result.current).toBe('range');

    // Mutate the selected slice — should re-render.
    act(() => {
      const id = useTabsStore.getState().activeTabId;
      useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    });
    expect(renders).toBe(2);
    expect(result.current).toBe('per-day');
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run src/state/chartPrefs.test.ts`. Expected: PASS (zustand's `Object.is` equality is the default — fine-grained subscription works out of the box for primitive returns).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/state/chartPrefs.test.ts
git commit -m "test(state): prove useActivePrefs fine-grained subscription"
```

---

## Task 4: Migrate `chart/AuctionWindowOverlay.tsx`

**Files:** `frontend/src/chart/AuctionWindowOverlay.tsx`

- [ ] **Step 1: Read the current consumer**

Run: `sed -n '1,35p' frontend/src/chart/AuctionWindowOverlay.tsx`

You'll see `import { useChartPrefs } from './ChartPrefsContext';` and `const prefs = useChartPrefs();` followed by a use of `prefs.auctionWindowMask`.

- [ ] **Step 2: Replace the import + call**

In `frontend/src/chart/AuctionWindowOverlay.tsx`:

Find:
```ts
import { useChartPrefs } from './ChartPrefsContext';
```
Replace with:
```ts
import { useActivePrefs } from '../state/chartPrefs';
```

Find the `const prefs = useChartPrefs();` line. Replace with:
```ts
const auctionWindowMask = useActivePrefs((p) => p.auctionWindowMask);
```

Then find the `if (!prefs.auctionWindowMask) return null;` line (or wherever `prefs.auctionWindowMask` appears) and change to `if (!auctionWindowMask) return null;`. If `prefs` was used for other fields, switch each to a separate `useActivePrefs((p) => p.fooField)` call — each subscription is independent and fine-grained.

(If `prefs` was only used for `auctionWindowMask`, the whole `prefs` variable goes away.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/chart/AuctionWindowOverlay.tsx
git commit -m "refactor(chart): AuctionWindowOverlay uses useActivePrefs"
```

---

## Task 5: Migrate `chart/VolumeProfileOverlay.tsx`

**Files:** `frontend/src/chart/VolumeProfileOverlay.tsx`

- [ ] **Step 1: Read the current consumer**

The file uses `const { volumeProfileMode: mode } = useChartPrefs();`.

- [ ] **Step 2: Replace**

Find:
```ts
import { useChartPrefs } from './ChartPrefsContext';
```
Replace with:
```ts
import { useActivePrefs } from '../state/chartPrefs';
```

Find:
```ts
const { volumeProfileMode: mode } = useChartPrefs();
```
Replace with:
```ts
const mode = useActivePrefs((p) => p.volumeProfileMode);
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc -b
git add frontend/src/chart/VolumeProfileOverlay.tsx
git commit -m "refactor(chart): VolumeProfileOverlay uses useActivePrefs"
```

---

## Task 6: Migrate the 3 projector context hooks

**Files:**
- `frontend/src/chart/projectors/ratio.ts`
- `frontend/src/chart/projectors/quoteTotals.ts`
- `frontend/src/chart/projectors/movingAverage.ts`

Each file has the same pattern: `useChartPrefs().<field>` inside a small `useXContext` arrow.

- [ ] **Step 1: `ratio.ts`**

Find:
```ts
import { useChartPrefs } from '../ChartPrefsContext';
```
Replace with:
```ts
import { useActivePrefs } from '../../state/chartPrefs';
```

Find:
```ts
const useRatioContext = (): boolean => useChartPrefs().auctionWindowMask;
```
Replace with:
```ts
const useRatioContext = (): boolean => useActivePrefs((p) => p.auctionWindowMask);
```

- [ ] **Step 2: `quoteTotals.ts`**

Same pattern. Replace import + the `useQuoteTotalsContext` body:
```ts
const useQuoteTotalsContext = (): boolean => useActivePrefs((p) => p.auctionWindowMask);
```

- [ ] **Step 3: `movingAverage.ts`**

Read it first: `sed -n '1,70p' frontend/src/chart/projectors/movingAverage.ts`. The pattern:
```ts
const useMAContext = (): MAContext => useChartPrefs().movingAverages;
```

Replace import + body:
```ts
import { useActivePrefs } from '../../state/chartPrefs';
// ...
const useMAContext = (): MAContext => useActivePrefs((p) => p.movingAverages);
```

(`MAContext` type stays whatever it currently is — likely `MAConfig[]`. The selector returns the array reference; zustand re-renders when the reference changes, which happens on every `setMovingAverage` call because the action builds a new array. Same behavior as Context.)

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc -b
git add frontend/src/chart/projectors/ratio.ts frontend/src/chart/projectors/quoteTotals.ts frontend/src/chart/projectors/movingAverage.ts
git commit -m "refactor(chart/projectors): all useXContext hooks use useActivePrefs"
```

---

## Task 7: Migrate `ChartStage.tsx` + delete `ChartPrefsContext.tsx`

**Files:**
- `frontend/src/chart/ChartStage.tsx`
- DELETE `frontend/src/chart/ChartPrefsContext.tsx`

- [ ] **Step 1: Find every reference to `ChartPrefs*` in `ChartStage.tsx`**

Run: `grep -n "ChartPrefs\|useChartPrefs" frontend/src/chart/ChartStage.tsx`

You should see at least:
- `import { ChartPrefsProvider } from './ChartPrefsContext';`
- `<ChartPrefsProvider value={prefs}>...</ChartPrefsProvider>` wrapping JSX (around line 351-411)
- Possibly a `useChartPrefs()` call earlier — investigate

- [ ] **Step 2: Determine if `ChartStage` itself reads any prefs**

If `ChartStage`'s body has any `useChartPrefs()` call or reads a `prefs` variable for its own behavior (not just to provide to children), each such read becomes a `useActivePrefs((p) => p.fooField)` call. If `prefs` exists only to feed `<ChartPrefsProvider value={prefs}>`, the whole variable disappears.

- [ ] **Step 3: Remove the provider wrap**

Find the JSX:
```tsx
<ChartPrefsProvider value={prefs}>
  {/* ... pane children ... */}
</ChartPrefsProvider>
```

Replace with the inner children directly (drop the wrapper element). Remove the `import { ChartPrefsProvider } from './ChartPrefsContext';` line.

If `ChartStage` was subscribing to `useTabsStore((s) => s.getPrefs(s.activeTabId))` purely to produce the `prefs` value for the provider, remove that subscription too — children now self-subscribe.

- [ ] **Step 4: Delete `ChartPrefsContext.tsx`**

```bash
rm frontend/src/chart/ChartPrefsContext.tsx
```

- [ ] **Step 5: Confirm no remaining references**

Run: `grep -rn "ChartPrefsContext\|ChartPrefsProvider\|useChartPrefs" frontend/src/`. Expected: zero matches.

- [ ] **Step 6: Typecheck + full test suite**

```bash
npx tsc -b
npx vitest run
```

Expected: clean tsc; full suite passes (the new chartPrefs tests + all previously-passing tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/chart/ChartStage.tsx
git rm frontend/src/chart/ChartPrefsContext.tsx
git commit -m "refactor(chart): drop ChartPrefsProvider wrap; delete ChartPrefsContext"
```

---

## Task 8: Sweep (lint + full vitest + manual)

**Files:** none.

- [ ] **Step 1: Full sweep**

```bash
npx vitest run
npx tsc -b
npx eslint src/state/ src/chart/
```

Expected: all clean. Test count should be roughly 613 + 3 new useActivePrefs tests = ~616.

- [ ] **Step 2: Grep audit**

```bash
grep -rn "useChartPrefs\|ChartPrefsContext\|ChartPrefsProvider" frontend/src/
```

Expected: zero matches.

```bash
grep -rn "useActivePrefs\b" frontend/src/
```

Expected: matches in `chartPrefs.ts` (definition + tests) and the 5 migrated consumers (AuctionWindowOverlay, VolumeProfileOverlay, ratio, quoteTotals, movingAverage).

- [ ] **Step 3: Manual check (only if dev servers running)**

Open `/replay`, change Volume Profile mode in Settings → only VolumeProfileOverlay re-renders (verifiable with React DevTools Profiler if available; otherwise visual smoke test that nothing breaks).

- [ ] **Step 4: If anything failed, fix in place and re-run; otherwise this task produces no commit.**

---

## Out of scope (per spec)
- `SettingsModal.tsx` `getPrefs` duplications.
- `useTabsStore` decomposition.
- `_MAIndexCheck` runtime guard removal.

## Self-Review Notes

- **Spec coverage**: split (T1), helper + tests (T2-T3), 6 consumer migrations (T4-T7), sweep (T8). All covered.
- **Type consistency**: `useActivePrefs<T>(selector: (p: ChartViewPrefs) => T): T` used uniformly across 6 callsites.
- **Re-export keeps `tabs.ts` consumers working** — `tabs.test.ts`, `tabsPersistence.ts`, etc. all import from `./tabs` and keep getting `ChartViewPrefs`, `DEFAULT_PREFS`, etc. via re-export.
- **Circular import safe** — `chartPrefs.ts`'s `useTabsStore` reference is inside a function body, not at module top-level.

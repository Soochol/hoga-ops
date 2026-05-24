# Chart prefs module split + useActivePrefs + ChartPrefsContext removal — design

**Status:** Draft
**Date:** 2026-05-24
**Owner:** frontend

## Problem

Three coupled frictions in the prefs read-path:

1. **`tabs.ts` is a 280-line grab-bag** — chart-pref types (`ChartViewPrefs`, `MAConfig`, `MAIndex`, `ChartToggleKey`), chart-pref constants (`CHART_TOGGLES`, `DEFAULT_MOVING_AVERAGES`, `MA_SLOT_COUNT`, `DEFAULT_PREFS`), the Zustand store, actions, persistence wiring, and HMR dispose all live in one file. Adding a new toggle requires reading the entire file to know what to touch.

2. **`useChartPrefs()` returns the full prefs object — every pane re-renders on any pref change.** The Context's docstring claims its purpose is "single subscription, no per-pane `useTabsStore` import" — but zustand selectors give finer-grained re-rendering when each consumer subscribes to its own slice. With the Context, RatioPane re-renders when `volumeProfileMode` changes (which it doesn't read), and VolumeProfileOverlay re-renders when `auctionWindowMask` flips. This is a perf regression masquerading as a clean abstraction.

3. **`useTabsStore((s) => s.getPrefs(s.activeTabId).foo)` is the right read pattern but it's repeated 4+ times** (friction #4 in the earlier exploration) — `ChartStage`, `SettingsModal` (×2), `useAuctionMaskActive`. No canonical helper.

The three are coupled: removing ChartPrefsContext requires a replacement read pattern; the replacement read pattern needs a home (and `tabs.ts` is already overloaded); the split into `chartPrefs.ts` gives the helper its natural home.

## Goal

Three landed changes:

### A. Split `chartPrefs.ts` out of `tabs.ts`

`frontend/src/state/chartPrefs.ts` owns:
- Types: `ChartViewPrefs`, `ChartToggleKey`, `MAConfig`, `MAIndex`
- Constants: `CHART_TOGGLES`, `DEFAULT_MOVING_AVERAGES`, `MA_SLOT_COUNT`, `DEFAULT_PREFS`
- The `_MAIndexCheck` type guard

`frontend/src/state/tabs.ts` keeps:
- `Tab`, `TabSelection`, `TabStatus` types
- The store, actions, `fresh()`, `seedInitialState`, persistence wiring
- Re-exports from `chartPrefs.ts` for back-compat during migration (then dropped)

### B. Introduce `useActivePrefs<T>(selector)` helper

```ts
// state/chartPrefs.ts (or state/tabs.ts — TBD by colocation)
export function useActivePrefs<T>(selector: (prefs: ChartViewPrefs) => T): T {
  return useTabsStore((s) => selector(s.getPrefs(s.activeTabId)));
}
```

This is the deep module: fine-grained subscription, canonical pattern, one-line consumer code.

### C. Delete `ChartPrefsContext` + migrate consumers

| Consumer | Before | After |
|---|---|---|
| `ChartStage.tsx` | `<ChartPrefsProvider value={prefs}>...</>` wrap + read prefs from store | Drop the provider entirely; pass nothing |
| `AuctionWindowOverlay.tsx` | `useChartPrefs().auctionWindowMask` | `useActivePrefs((p) => p.auctionWindowMask)` |
| `VolumeProfileOverlay.tsx` | `useChartPrefs().volumeProfileMode` | `useActivePrefs((p) => p.volumeProfileMode)` |
| `ratio.ts` projector | `useChartPrefs().auctionWindowMask` (via `useRatioContext`) | `useActivePrefs((p) => p.auctionWindowMask)` |
| `quoteTotals.ts` projector | same | same |
| `movingAverage.ts` projector | `useChartPrefs().movingAverages` | `useActivePrefs((p) => p.movingAverages)` |

After migration, `chart/ChartPrefsContext.tsx` deletes.

## Non-goals

- **No store API change** — `useTabsStore.getPrefs`, `setToggle`, `setVolumeProfileMode`, `setMovingAverage` keep the same signatures.
- **No new toggle / no new pref field** — pure refactor.
- **No persistence schema change** — `replay.tabs.v1` snapshot shape unchanged.
- **No `state/useAuctionMaskActive.ts` change** — it already uses `useTabsStore` directly (after the previous Auction Mask unification spec); doesn't go through ChartPrefsContext.
- **No `SettingsModal.tsx` change in this spec** — it has its own `useTabsStore((s) => s.getPrefs(s.activeTabId).x)` repeats but they're writes (uses `getPrefs` + setters). Worth a small follow-up but separate from this spec.

## Architecture

### Module layout after the split

```
frontend/src/state/
├── chartPrefs.ts            ← NEW: types + constants + useActivePrefs
├── chartPrefs.test.ts       ← NEW: useActivePrefs unit tests
├── tabs.ts                  ← MODIFIED: store + actions only, imports from chartPrefs
├── tabs.test.ts             ← UNCHANGED (existing tests still pass)
├── tabsPersistence.ts       ← UNCHANGED (already uses `import type` from tabs)
├── persistentSubscriber.ts  ← UNCHANGED
└── useAuctionMaskActive.ts  ← UNCHANGED
```

```
frontend/src/chart/
├── ChartPrefsContext.tsx    ← DELETED
├── ChartStage.tsx           ← MODIFIED: drop ChartPrefsProvider wrap
├── AuctionWindowOverlay.tsx ← MODIFIED: useActivePrefs
├── VolumeProfileOverlay.tsx ← MODIFIED: useActivePrefs
└── projectors/
    ├── ratio.ts             ← MODIFIED: useActivePrefs in useRatioContext
    ├── quoteTotals.ts       ← MODIFIED: same
    └── movingAverage.ts     ← MODIFIED: same
```

### `chartPrefs.ts` shape

```ts
// frontend/src/state/chartPrefs.ts

import { useTabsStore } from './tabs';  // ← runtime dep on tabs.ts (acyclic since tabs.ts only type-imports back)

// ── Types ────────────────────────────────────────────────────────────────

export const CHART_TOGGLES = [
  {
    key: 'auctionWindowMask',
    label: '호가비 동시호가 마스킹',
    description: '15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.',
    default: true,
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

export type MAConfig = { period: number; enabled: boolean };
export const MA_SLOT_COUNT = 5;
export type MAIndex = 0 | 1 | 2 | 3 | 4;

// (the _MAIndexCheck guard moves verbatim)

export const DEFAULT_MOVING_AVERAGES: readonly MAConfig[] = Object.freeze([
  { period: 5, enabled: true },
  { period: 10, enabled: true },
  { period: 20, enabled: true },
  { period: 60, enabled: true },
  { period: 120, enabled: true },
]);

export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
  movingAverages: MAConfig[];
} & { [K in ChartToggleKey]: boolean };

const TOGGLE_DEFAULTS = Object.fromEntries(
  CHART_TOGGLES.map((t) => [t.key, t.default]),
) as { [K in ChartToggleKey]: boolean };

export const DEFAULT_PREFS: ChartViewPrefs = {
  volumeProfileMode: 'range',
  movingAverages: DEFAULT_MOVING_AVERAGES.map((c) => ({ ...c })),
  ...TOGGLE_DEFAULTS,
};

// ── Read-path helper ─────────────────────────────────────────────────────

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

### `tabs.ts` after the split

- Drops: `CHART_TOGGLES`, `ChartToggleKey`, `MAConfig`, `MA_SLOT_COUNT`, `MAIndex`, `_MAIndexCheck`, `DEFAULT_MOVING_AVERAGES`, `ChartViewPrefs`, `TOGGLE_DEFAULTS`, `DEFAULT_PREFS`.
- Imports them from `./chartPrefs` instead.
- Re-exports `ChartViewPrefs` and `DEFAULT_PREFS` for one cycle (any external consumer that imports from `'./tabs'` keeps working).

```ts
// state/tabs.ts (top imports)
import {
  CHART_TOGGLES,
  DEFAULT_PREFS,
  MA_SLOT_COUNT,
  type ChartToggleKey,
  type ChartViewPrefs,
  type MAConfig,
  type MAIndex,
} from './chartPrefs';

export type { ChartViewPrefs, MAConfig, MAIndex, ChartToggleKey } from './chartPrefs';
export { DEFAULT_PREFS, CHART_TOGGLES, MA_SLOT_COUNT, DEFAULT_MOVING_AVERAGES } from './chartPrefs';
```

(Re-exports remove the need for a sweep of every consumer in this PR. A follow-up can clean import paths if needed; today's diff stays narrow.)

### Circular import handling

`chartPrefs.ts` value-imports `useTabsStore` from `tabs.ts`. `tabs.ts` value-imports constants from `chartPrefs.ts`. This is the same circular pattern as `tabs.ts ↔ tabsPersistence.ts` (which uses type-only imports). The resolution mirrors the proven pattern:

- `tabs.ts` imports `chartPrefs.ts` first (value imports for `DEFAULT_PREFS` etc.). On `tabs.ts` module load, `chartPrefs.ts` begins evaluating.
- `chartPrefs.ts`'s `useActivePrefs` references `useTabsStore` lazily — inside a function body, not at module evaluation time. By the time anyone CALLS `useActivePrefs`, both modules are fully evaluated.
- The `import { useTabsStore } from './tabs'` line in `chartPrefs.ts` resolves to the namespace; `useTabsStore` is read on first call, not on module load.

This is safe because:
1. `chartPrefs.ts` top-level code (type aliases, constants) doesn't reach for `useTabsStore`.
2. `tabs.ts` top-level code reads from `chartPrefs.ts` (constants are evaluated by the time `tabs.ts` resumes after the import).
3. `useActivePrefs` is called only from React render — long after both modules finished loading.

### Consumer migration shape

Before (e.g. `chart/projectors/ratio.ts`):
```ts
import { useChartPrefs } from '../ChartPrefsContext';
const useRatioContext = (): boolean => useChartPrefs().auctionWindowMask;
```

After:
```ts
import { useActivePrefs } from '../../state/chartPrefs';
const useRatioContext = (): boolean => useActivePrefs((p) => p.auctionWindowMask);
```

The 6 consumers above all follow this exact pattern.

`ChartStage.tsx` is slightly different — it currently wraps children in `<ChartPrefsProvider value={prefs}>`. After migration:
- Drop the wrapper (panes subscribe to the store directly via `useActivePrefs`).
- ChartStage may not even need to subscribe to prefs at all if no remaining ChartStage code reads them. Investigate during migration.

## Files

### Created
- `frontend/src/state/chartPrefs.ts` (~100 LOC: types + constants + `useActivePrefs`)
- `frontend/src/state/chartPrefs.test.ts` (~50 LOC: useActivePrefs subscription tests)

### Modified
- `frontend/src/state/tabs.ts` — drop type/constant definitions; import + re-export from `chartPrefs`.
- `frontend/src/chart/ChartStage.tsx` — remove `<ChartPrefsProvider>` wrapper; investigate whether prefs subscription is still needed at all.
- `frontend/src/chart/AuctionWindowOverlay.tsx` — `useChartPrefs` → `useActivePrefs`.
- `frontend/src/chart/VolumeProfileOverlay.tsx` — same.
- `frontend/src/chart/projectors/ratio.ts` — same.
- `frontend/src/chart/projectors/quoteTotals.ts` — same.
- `frontend/src/chart/projectors/movingAverage.ts` — same.

### Deleted
- `frontend/src/chart/ChartPrefsContext.tsx`

### Not touched
- `state/tabs.test.ts` — passes unchanged (existing tests don't touch the removed exports' source location; just their names).
- `state/tabsPersistence.{ts,test.ts}` — already uses `import type` from tabs; type re-exports keep this working.
- `state/useAuctionMaskActive.ts` — already uses `useTabsStore` directly.
- `state/persistentSubscriber.{ts,test.ts}`
- `replay/SettingsModal.tsx` — reads `prefs` via `getPrefs` for write paths; out of scope for this spec.

## Behavior contracts (must hold)

1. **Fine-grained re-rendering**: After migration, a `setVolumeProfileMode` call must NOT re-render `RatioPane`, `QuoteTotalsPane`, or `AuctionWindowOverlay`. Currently it does (they all subscribe via ChartPrefsContext to the full object). Validated by inspection or a render-count test.
2. **All existing tests pass unchanged.**
3. **The `tabs.test.ts` 17 tests stay green** — `DEFAULT_PREFS`, `CHART_TOGGLES`, the store API are all still importable from `./tabs` via re-export.
4. **No visual regression** — all panes render the same data; this is a read-path refactor.

## Edge cases

| Case | Behavior |
|---|---|
| `useActivePrefs` selector throws | React boundary catches; same behavior as any throwing selector in zustand. Not a new failure mode. |
| Selector returns a new object literal each call | Re-renders every time (zustand uses `Object.is`). Document: selectors should return primitives or stable references. The 6 migrating callsites all select either booleans or array references — safe by default. |
| Active tab switches | `getPrefs(s.activeTabId)` returns the new tab's prefs; selector re-runs; component re-renders. Same behavior as before (ChartStage was re-subscribing when activeTabId changed). |
| Tab has no entry in `prefs` Map | `getPrefs` returns `DEFAULT_PREFS` (unchanged behavior). |

## Testing

### Unit (`chartPrefs.test.ts`)
1. `useActivePrefs(selector)` returns the selected slice for the active tab
2. Switching active tab triggers re-render (verify with `act` + render count)
3. Selector returning primitive — re-renders only when that primitive changes (verify by mutating a different pref field and asserting render count is stable)
4. Selector returning object reference — re-renders when the reference changes (`movingAverages` array swap)

### Regression
- `tabs.test.ts` 17 tests pass unchanged
- `tabsPersistence.test.ts` 31 tests pass unchanged
- `persistentSubscriber.test.ts` 10 tests pass unchanged
- `useAuctionMaskActive.test.ts` 4 tests pass unchanged
- `auctionMask.test.ts` 5 tests pass unchanged

### Manual
- Open `/replay`, change Volume Profile mode in Settings, observe via React DevTools profiler:
  - VolumeProfileOverlay re-renders (expected)
  - RatioPane, QuoteTotalsPane do NOT re-render (the fine-grained win)
- Toggle Auction Mask, observe:
  - RatioPane + QuoteTotalsPane re-render (expected)
  - VolumeProfileOverlay does NOT re-render

## Out of scope / 후속

- `SettingsModal.tsx` `getPrefs` duplications — separate cleanup.
- `useTabsStore` decomposition into smaller stores — too big for this cycle.
- Migrating away from `useTabsStore.getPrefs` accessor entirely in favor of a derived store — overkill.
- `_MAIndexCheck` runtime guard removal — out of scope (it's a build-time type check, harmless).

## Open questions

None.

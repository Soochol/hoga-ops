import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { RangeBundle, Timeframe } from '../api/types';
import { useToolbarDraftStore } from './toolbarDraft';
import {
  loadPersisted,
  toSnapshot,
  fromSnapshot,
  STORAGE_KEY,
  type SnapshotDeps,
} from './tabsPersistence';
import { attachPersistence } from './persistentSubscriber';

export type TabSelection = {
  code: string;
  fromDate: string;
  toDate: string;
  timeframe: Timeframe;
};
export type TabStatus = 'empty' | 'loading' | 'loaded' | 'error';

// Re-export chart-pref types + constants. These moved to ./chartPrefs but
// many consumers still import from './tabs'; re-exports keep them working
// during the migration window. Direct imports from './chartPrefs' are
// encouraged for new code.
export {
  CHART_NUMERIC_PREFS,
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
  NumericPrefDef,
  NumericPrefKey,
} from './chartPrefs';

import {
  CHART_NUMERIC_PREFS,
  CHART_TOGGLES,
  DEFAULT_PREFS,
  MA_SLOT_COUNT,
  registerTabsStore,
  type ChartToggleKey,
  type ChartViewPrefs,
  type MAConfig,
  type MAIndex,
  type NumericPrefDef,
  type NumericPrefKey,
} from './chartPrefs';

/** Lookup table for numeric pref defs by key — O(1) clamp on every setter call.
 *  Built once at module load from the frozen registry. */
const NUMERIC_PREF_DEFS_BY_KEY = new Map<NumericPrefKey, NumericPrefDef>(
  CHART_NUMERIC_PREFS.map((d) => [d.key, d]),
);

export type Tab = {
  id: string;
  selection: TabSelection | null;
  cursorMs: number | null;
  status: TabStatus;
  errorMessage?: string;
  // Wire Model transition (ADR-0013): bundles are now keyed by from_date and
  // hold a RangeBundle. Tasks 15-17 update Workarea/Panes to consume this.
  bundles: Map<string, RangeBundle>;
};

type Store = {
  tabs: Tab[];
  activeTabId: string;
  prefs: Map<string, ChartViewPrefs>;
  newTab: (opts?: { confirmEvictOldest?: boolean }) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setSelection: (id: string, sel: TabSelection) => void;
  setStatus: (id: string, status: TabStatus, errorMessage?: string) => void;
  setCursor: (id: string, ms: number | null) => void;
  putBundle: (id: string, date: string, bundle: RangeBundle) => void;
  getPrefs: (id: string) => ChartViewPrefs;
  setVolumeProfileMode: (id: string, mode: ChartViewPrefs['volumeProfileMode']) => void;
  /** Generic setter for any boolean toggle in `CHART_TOGGLES`. */
  setToggle: (id: string, key: ChartToggleKey, value: boolean) => void;
  /** Generic setter for any integer numeric pref in `CHART_NUMERIC_PREFS`.
   *  Out-of-range or non-finite values are clamped to the registered
   *  `[min, max]` band and floored to integer (defense-in-depth — UI input
   *  also enforces these). Unknown `key` is a no-op (guarded by the key
   *  union type at compile time; the runtime lookup is a tripwire for
   *  any non-TypeScript caller). */
  setNumericPref: (id: string, key: NumericPrefKey, value: number) => void;
  /** Patch one slot of `movingAverages`. Out-of-range `index` is a no-op.
   *  Period validation is intentionally NOT done here — the UI layer (T5)
   *  owns range checks so that downstream callers can apply identical
   *  patches without re-validating. */
  setMovingAverage: (id: string, index: MAIndex, patch: Partial<MAConfig>) => void;
  reset: () => void;
};

const fresh = (): Tab => ({
  id: nanoid(8),
  selection: null,
  cursorMs: null,
  status: 'empty',
  bundles: new Map(),
});

export const TABS_SOFT_CAP = 8;

/** Build the initial store slots by hydrating from localStorage when a valid
 *  v1 snapshot exists, otherwise falling back to a single fresh tab.
 *  Returning the three slots together keeps `tabs`, `activeTabId`, `prefs`
 *  consistent at construction time (spec §"prefs Map 시드"). */
function seedInitialState(): {
  tabs: Tab[];
  activeTabId: string;
  prefs: Map<string, ChartViewPrefs>;
} {
  const snapshotDeps: SnapshotDeps = {
    defaultPrefs: DEFAULT_PREFS,
    freshTab: fresh,
    chartToggleKeys: CHART_TOGGLES.map((t) => t.key),
    numericPrefDefs: CHART_NUMERIC_PREFS,
  };
  const snap = loadPersisted();
  if (snap === null) {
    const t = fresh();
    return { tabs: [t], activeTabId: t.id, prefs: new Map() };
  }
  return fromSnapshot(snap, snapshotDeps);
}

const seeded = seedInitialState();

export const useTabsStore = create<Store>((set, get) => ({
  tabs: seeded.tabs,
  activeTabId: seeded.activeTabId,
  prefs: seeded.prefs,
  newTab: (opts) => {
    let { tabs } = get();
    if (tabs.length >= TABS_SOFT_CAP) {
      if (!opts?.confirmEvictOldest) return get().activeTabId;
      tabs = tabs.slice(1);
    }
    const t = fresh();
    set({ tabs: [...tabs, t], activeTabId: t.id });
    return t.id;
  },
  closeTab: (id) => {
    const { tabs, activeTabId, prefs } = get();
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.id !== id);
    const wasActive = activeTabId === id;
    // Closing the active tab moves focus to the neighbor to the right (else left).
    // Closing a non-active tab leaves activeTabId untouched.
    const nextActive = wasActive
      ? (next[idx]?.id ?? next[idx - 1]?.id ?? next[0].id)
      : activeTabId;
    useToolbarDraftStore.getState().clearTab(id);
    // Clean up per-tab prefs to prevent leak (CQ1).
    const nextPrefs = new Map(prefs);
    nextPrefs.delete(id);
    set({ tabs: next, activeTabId: nextActive, prefs: nextPrefs });
  },
  setActive: (id) => set({ activeTabId: id }),
  setSelection: (id, sel) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, selection: sel } : t)) })),
  setStatus: (id, status, errorMessage) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, status, errorMessage } : t)) })),
  setCursor: (id, ms) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, cursorMs: ms } : t)) })),
  putBundle: (id, date, bundle) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const bundles = new Map(t.bundles);
        bundles.set(date, bundle);
        return { ...t, bundles, status: 'loaded' as const };
      }),
    })),
  getPrefs: (id) => get().prefs.get(id) ?? DEFAULT_PREFS,
  setVolumeProfileMode: (id, mode) =>
    set((s) => {
      const next = new Map(s.prefs);
      next.set(id, { ...DEFAULT_PREFS, ...next.get(id), volumeProfileMode: mode });
      return { prefs: next };
    }),
  setToggle: (id, key, value) =>
    set((s) => {
      const next = new Map(s.prefs);
      next.set(id, { ...DEFAULT_PREFS, ...next.get(id), [key]: value });
      return { prefs: next };
    }),
  setNumericPref: (id, key, value) =>
    set((s) => {
      const def = NUMERIC_PREF_DEFS_BY_KEY.get(key);
      if (def === undefined) return {};
      // Clamp at the store boundary so localStorage round-trips can't smuggle
      // bad values back in via setter calls. UI input also enforces the range
      // but defense-in-depth keeps projector invariants intact. NaN/Infinity
      // are excluded by the Math.floor + clamp chain.
      const safe = Math.min(
        def.max,
        Math.max(def.min, Math.floor(Number.isFinite(value) ? value : def.default)),
      );
      const next = new Map(s.prefs);
      next.set(id, {
        ...DEFAULT_PREFS,
        ...next.get(id),
        [key]: safe,
      });
      return { prefs: next };
    }),
  setMovingAverage: (id, index, patch) =>
    set((s) => {
      if (index < 0 || index >= MA_SLOT_COUNT) return {};
      const next = new Map(s.prefs);
      const current: ChartViewPrefs = { ...DEFAULT_PREFS, ...next.get(id) };
      // MA_SLOT_COUNT is the cardinality invariant; current.movingAverages
      // is guaranteed to have MA_SLOT_COUNT entries via DEFAULT_PREFS.
      const mas = current.movingAverages;
      const nextMas = mas.map((m, i) => (i === index ? { ...m, ...patch } : m));
      next.set(id, { ...current, movingAverages: nextMas });
      return { prefs: next };
    }),
  reset: () => {
    const t = fresh();
    set({ tabs: [t], activeTabId: t.id, prefs: new Map() });
  },
}));

// Register the store with chartPrefs.ts so `useActivePrefs` can subscribe
// to it without a top-level import-cycle (see chartPrefs.ts comment).
registerTabsStore(useTabsStore);

/** Debounced persistence — every store mutation schedules a save 250ms out.
 *  See spec §"Save 디바운싱" for rationale. */
const unsubscribePersist = attachPersistence(useTabsStore, {
  storageKey: STORAGE_KEY,
  toSnapshot: (s) =>
    toSnapshot({ tabs: s.tabs, activeTabId: s.activeTabId, prefs: s.prefs }),
});

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribePersist);
}

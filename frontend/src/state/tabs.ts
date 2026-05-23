import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { RangeBundle, Timeframe } from '../api/types';
import { useToolbarDraftStore } from './toolbarDraft';

export type TabSelection = {
  code: string;
  fromDate: string;
  toDate: string;
  timeframe: Timeframe;
};
export type TabStatus = 'empty' | 'loading' | 'loaded' | 'error';

/**
 * Declarative registry of boolean chart toggles surfaced in the Settings
 * modal. Each entry is the single source of truth for one toggle: its key
 * (used as a `ChartViewPrefs` field), default value, and UI strings.
 *
 * Adding a toggle = one entry here. The type below (`ChartToggleKey`),
 * the `ChartViewPrefs` boolean fields, the default values, and the
 * `SettingsModal` row rendering all derive from this list.
 */
export const CHART_TOGGLES = [
  {
    key: 'auctionWindowMask',
    label: '호가비 동시호가 마스킹',
    description: '15:20–15:30 KST 동시호가 구간의 호가비를 0 으로 처리합니다.',
    default: true,
  },
] as const;

export type ChartToggleKey = (typeof CHART_TOGGLES)[number]['key'];

/** Per-MA configuration. Indexed slot in `ChartViewPrefs.movingAverages`
 *  aligns 1:1 with `MA_COLORS` (T1). Period range (2..400) is validated
 *  at the UI layer (T5), not in the store. */
export type MAConfig = {
  period: number;
  enabled: boolean;
};

/** Default Moving Average configuration: 5 slots, all enabled, with
 *  periods 5 / 10 / 20 / 60 / 120 캔들. The array is frozen so it cannot
 *  be mutated by accident; consumers should make a mutable copy before
 *  writing (see `DEFAULT_PREFS`). */
export const DEFAULT_MOVING_AVERAGES: readonly MAConfig[] = Object.freeze([
  { period: 5, enabled: true },
  { period: 10, enabled: true },
  { period: 20, enabled: true },
  { period: 60, enabled: true },
  { period: 120, enabled: true },
]);

/** Per-tab chart view preferences. Stored in a `Map<tabId, ChartViewPrefs>`
 *  on the store for parity with `Tab.bundles` (CQ1). Boolean fields come
 *  from `CHART_TOGGLES`; non-boolean prefs (e.g. `volumeProfileMode`,
 *  `movingAverages`) sit alongside as explicit fields. */
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
  /** Patch one slot of `movingAverages`. Out-of-range `index` is a no-op.
   *  Period validation is intentionally NOT done here — the UI layer (T5)
   *  owns range checks so that downstream callers can apply identical
   *  patches without re-validating. */
  setMovingAverage: (id: string, index: 0 | 1 | 2 | 3 | 4, patch: Partial<MAConfig>) => void;
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

const initial = fresh();

export const useTabsStore = create<Store>((set, get) => ({
  tabs: [initial],
  activeTabId: initial.id,
  prefs: new Map(),
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
  setMovingAverage: (id, index, patch) =>
    set((s) => {
      if (index < 0 || index > 4) return {};
      const next = new Map(s.prefs);
      const current: ChartViewPrefs = { ...DEFAULT_PREFS, ...next.get(id) };
      const mas = current.movingAverages;
      if (index >= mas.length) return {};
      const nextMas = mas.map((m, i) => (i === index ? { ...m, ...patch } : m));
      next.set(id, { ...current, movingAverages: nextMas });
      return { prefs: next };
    }),
  reset: () => {
    const t = fresh();
    set({ tabs: [t], activeTabId: t.id, prefs: new Map() });
  },
}));

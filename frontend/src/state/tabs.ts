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

/** Per-tab chart view preferences (volume profile mode, etc.). Stored in a
 *  Map<tabId, ChartViewPrefs> on the store for parity with Tab.bundles (CQ1). */
export type ChartViewPrefs = {
  volumeProfileMode: 'range' | 'per-day';
};

const DEFAULT_PREFS: ChartViewPrefs = { volumeProfileMode: 'range' };

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
  reset: () => {
    const t = fresh();
    set({ tabs: [t], activeTabId: t.id, prefs: new Map() });
  },
}));

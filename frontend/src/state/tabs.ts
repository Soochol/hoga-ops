import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { SessionBundle } from '../api/types';

export type TabSelection = { code: string; fromDate: string; toDate: string };
export type TabStatus = 'empty' | 'loading' | 'loaded' | 'error';

export type Tab = {
  id: string;
  selection: TabSelection | null;
  cursorMs: number | null;
  status: TabStatus;
  errorMessage?: string;
  bundles: Map<string, SessionBundle>;
};

type Store = {
  tabs: Tab[];
  activeTabId: string;
  newTab: (opts?: { confirmEvictOldest?: boolean }) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setSelection: (id: string, sel: TabSelection) => void;
  setStatus: (id: string, status: TabStatus, errorMessage?: string) => void;
  setCursor: (id: string, ms: number | null) => void;
  putBundle: (id: string, date: string, bundle: SessionBundle) => void;
  reset: () => void;
};

const fresh = (): Tab => ({
  id: nanoid(8),
  selection: null,
  cursorMs: null,
  status: 'empty',
  bundles: new Map(),
});

const SOFT_CAP = 8;

export const useTabsStore = create<Store>((set, get) => ({
  tabs: [fresh()],
  activeTabId: '',
  newTab: (opts) => {
    let { tabs } = get();
    if (tabs.length >= SOFT_CAP) {
      if (!opts?.confirmEvictOldest) return get().activeTabId;
      tabs = tabs.slice(1);
    }
    const t = fresh();
    set({ tabs: [...tabs, t], activeTabId: t.id });
    return t.id;
  },
  closeTab: (id) => {
    const { tabs } = get();
    if (tabs.length <= 1) return;
    const next = tabs.filter((t) => t.id !== id);
    set({ tabs: next, activeTabId: next[next.length - 1].id });
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
  reset: () => {
    const t = fresh();
    set({ tabs: [t], activeTabId: t.id });
  },
}));

// initialize activeTabId on first import
useTabsStore.setState({ activeTabId: useTabsStore.getState().tabs[0].id });

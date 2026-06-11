import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useLivePageStore, type LiveTimeframe } from './livePage';

export const TABS_SOFT_CAP = 8;

export type LiveTab = {
  id: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
};

type TabsStore = {
  tabs: LiveTab[];
  activeTabId: string | null;
  openOrFocusTab: (code: string, label?: string) => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
};

// Module guard: when true, the active-tab→page write is in progress, so the
// page→tab mirror (Task 3) must not write back (prevents the historicalFromDate
// reset inside setActiveCode/setCandleTimeframe from clobbering the tab).
export let applyingTab = false;
export function setApplyingTab(v: boolean): void { applyingTab = v; }

/** Push the active tab's view-state into useLivePageStore in the order that
 *  survives the historicalFromDate resets baked into the page setters. */
export function applyTabToPage(tab: LiveTab | null): void {
  setApplyingTab(true);
  const page = useLivePageStore.getState();
  page.setActiveCode(tab?.code ?? null);
  if (tab) {
    page.setCandleTimeframe(tab.timeframe);
    if (tab.historicalFromDate) page.extendHistoricalRange(tab.historicalFromDate);
  }
  setApplyingTab(false);
}

export const useLiveTabsStore = create<TabsStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openOrFocusTab: (code, label) => {
    const { tabs } = get();
    const hit = tabs.find((t) => t.code === code);
    if (hit) { get().focusTab(hit.id); return; }
    if (tabs.length >= TABS_SOFT_CAP) return;
    const tab: LiveTab = {
      id: nanoid(8),
      code,
      label: label ?? code,
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
    };
    set({ tabs: [...tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab);
  },

  focusTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    set({ activeTabId: id });
    applyTabToPage(tab);
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.id !== id);
    if (activeTabId !== id) { set({ tabs: next }); return; }
    const nextActiveId = next[idx]?.id ?? next[idx - 1]?.id ?? null;
    set({ tabs: next, activeTabId: nextActiveId });
    applyTabToPage(next.find((t) => t.id === nextActiveId) ?? null);
  },

  reorderTabs: (from, to) => {
    const { tabs } = get();
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) return;
    const next = tabs.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ tabs: next });
  },
}));

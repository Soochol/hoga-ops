import { nanoid } from 'nanoid';
import { create } from 'zustand';
import type { LiveTimeframe } from './livePage';
import type { StudyViewListRow } from '../api/studyViews';
import { formatStudyTabLabel } from '../studyViews/studyViewSelection';
import { attachPersistence } from './persistentSubscriber';
import type { TabViewport } from '../live/viewportAnchor';

const STORAGE_KEY = 'study.tabs.v1';

type SaveTabFields = Pick<StudyViewListRow, 'id' | 'code' | 'label' | 'name' | 'timeframe'>;

export type StudyTab = {
  id: string;
  viewId: string;
  code: string;
  label: string;
  name: string;
  timeframe: LiveTimeframe;
  viewport?: TabViewport | null;
};

type StudyTabSnapshot = Omit<StudyTab, 'id' | 'viewport'>;
type StudyTabsSnapshot = {
  version: 1;
  activeIndex: number;
  tabs: StudyTabSnapshot[];
};
type OpenSaveOptions = {
  timeframeOverride?: LiveTimeframe;
};

type StudyTabsStore = {
  tabs: StudyTab[];
  activeTabId: string | null;
  openSaveInActiveTab: (save: SaveTabFields, options?: OpenSaveOptions) => void;
  openSaveInNewTab: (save: SaveTabFields, options?: OpenSaveOptions) => void;
  ensureQuerySeed: (save: SaveTabFields) => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeTabsByViewId: (viewId: string) => StudyTab | null;
  reorderTabs: (from: number, to: number) => void;
  updateTabTimeframe: (id: string, timeframe: LiveTimeframe) => void;
  updateTabViewport: (id: string, viewport: TabViewport | null) => void;
};

function isStudyTabSnapshot(value: unknown): value is StudyTabSnapshot {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.viewId === 'string' &&
    typeof tab.code === 'string' &&
    typeof tab.label === 'string' &&
    typeof tab.name === 'string' &&
    typeof tab.timeframe === 'string'
  );
}

export function studyTabFromSave(save: SaveTabFields): StudyTab {
  const label = formatStudyTabLabel(save);
  return {
    id: nanoid(8),
    viewId: save.id,
    code: save.code,
    label,
    name: save.name,
    timeframe: save.timeframe,
  };
}

function saveWithOpenOptions(save: SaveTabFields, options?: OpenSaveOptions): SaveTabFields {
  return options?.timeframeOverride ? { ...save, timeframe: options.timeframeOverride } : save;
}

function retimeStudyTabLabel(tab: StudyTab, timeframe: LiveTimeframe): string {
  return formatStudyTabLabel({
    label: tab.label.split(' · ')[0] ?? tab.label,
    name: tab.name,
    timeframe,
  });
}

function loadStudyTabs(): { tabs: StudyTab[]; activeTabId: string | null } {
  if (typeof localStorage === 'undefined') return { tabs: [], activeTabId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeTabId: null };
    const snapshot = JSON.parse(raw) as Partial<StudyTabsSnapshot>;
    if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
      return { tabs: [], activeTabId: null };
    }
    const tabs = snapshot.tabs.filter(isStudyTabSnapshot).map((tab) => {
      const { viewport: _viewport, ...fields } = tab as StudyTabSnapshot & { viewport?: unknown };
      return {
        ...fields,
        id: nanoid(8),
      };
    });
    if (tabs.length === 0) return { tabs: [], activeTabId: null };
    const rawActiveIndex = Number.isInteger(snapshot.activeIndex) ? snapshot.activeIndex as number : 0;
    const activeIndex = Math.min(Math.max(0, rawActiveIndex), tabs.length - 1);
    return { tabs, activeTabId: tabs[activeIndex]?.id ?? null };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

export function toStudyTabsSnapshot(
  state: Pick<StudyTabsStore, 'tabs' | 'activeTabId'>,
): StudyTabsSnapshot {
  const activeIndex = Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeTabId));
  return {
    version: 1,
    activeIndex,
    tabs: state.tabs.map(({ id: _id, viewport: _viewport, ...tab }) => tab),
  };
}

export const useStudyTabsStore = create<StudyTabsStore>((set, get) => ({
  ...loadStudyTabs(),

  openSaveInActiveTab: (save, options) => {
    const effectiveSave = saveWithOpenOptions(save, options);
    const { tabs, activeTabId } = get();
    const existing = tabs.find((tab) => tab.viewId === save.id);
    if (existing) {
      set({
        tabs: tabs.map((tab) => (tab.id === existing.id
          ? { ...tab, ...studyTabFromSave(effectiveSave), id: tab.id, viewport: tab.viewport }
          : tab)),
        activeTabId: existing.id,
      });
      return;
    }
    const next = studyTabFromSave(effectiveSave);
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (!active) {
      set({ tabs: [...tabs, next], activeTabId: next.id });
      return;
    }
    set({
      tabs: tabs.map((tab) => (tab.id === active.id ? { ...next, id: active.id } : tab)),
      activeTabId: active.id,
    });
  },

  openSaveInNewTab: (save, options) => {
    const next = studyTabFromSave(saveWithOpenOptions(save, options));
    set({ tabs: [...get().tabs, next], activeTabId: next.id });
  },

  ensureQuerySeed: (save) => {
    const existing = get().tabs.find((tab) => tab.viewId === save.id);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    get().openSaveInNewTab(save);
  },

  focusTab: (id) => {
    if (!get().tabs.some((tab) => tab.id === id)) return;
    set({ activeTabId: id });
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const next = tabs.filter((tab) => tab.id !== id);
    if (activeTabId !== id) {
      set({ tabs: next });
      return;
    }
    const nextActiveId = next[index]?.id ?? next[index - 1]?.id ?? null;
    set({ tabs: next, activeTabId: nextActiveId });
  },

  closeTabsByViewId: (viewId) => {
    const { tabs, activeTabId } = get();
    const removedIndexes = tabs
      .map((tab, index) => (tab.viewId === viewId ? index : -1))
      .filter((index) => index !== -1);
    if (removedIndexes.length === 0) {
      return tabs.find((tab) => tab.id === activeTabId) ?? null;
    }
    const next = tabs.filter((tab) => tab.viewId !== viewId);
    const activeWasRemoved = tabs.some((tab) => tab.id === activeTabId && tab.viewId === viewId);
    if (!activeWasRemoved) {
      set({ tabs: next });
      return next.find((tab) => tab.id === activeTabId) ?? null;
    }
    const firstRemovedIndex = removedIndexes[0] ?? 0;
    const nextActive = next[firstRemovedIndex] ?? next[firstRemovedIndex - 1] ?? null;
    set({ tabs: next, activeTabId: nextActive?.id ?? null });
    return nextActive;
  },

  reorderTabs: (from, to) => {
    const { tabs } = get();
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length || from === to) return;
    const next = tabs.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set({ tabs: next });
  },

  updateTabTimeframe: (id, timeframe) => {
    const { tabs } = get();
    if (!tabs.some((tab) => tab.id === id)) return;
    set({
      tabs: tabs.map((tab) => (
        tab.id === id
          ? { ...tab, timeframe, label: retimeStudyTabLabel(tab, timeframe), viewport: null }
          : tab
      )),
    });
  },

  updateTabViewport: (id, viewport) => {
    const { tabs } = get();
    if (!tabs.some((tab) => tab.id === id)) return;
    set({ tabs: tabs.map((tab) => (tab.id === id ? { ...tab, viewport } : tab)) });
  },
}));

let _syncDispose: (() => void) | null = null;

export function initStudyTabsSync(): () => void {
  if (_syncDispose) return _syncDispose;
  const unsubPersist = attachPersistence(useStudyTabsStore, {
    storageKey: STORAGE_KEY,
    toSnapshot: (state) => toStudyTabsSnapshot(state),
  });
  _syncDispose = () => {
    unsubPersist();
    _syncDispose = null;
  };
  return _syncDispose;
}

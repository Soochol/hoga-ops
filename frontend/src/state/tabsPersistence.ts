import type { Tab, TabSelection, ChartViewPrefs } from './tabs';

/** Versioned storage key. Schema-breaking changes bump the suffix and let
 *  the previous key be garbage-collected naturally — no migration code. */
export const STORAGE_KEY = 'replay.tabs.v1';

/** Per-tab snapshot. `prefs` is `Partial` because forward-compat merge against
 *  `DEFAULT_PREFS` at load time tolerates schema additions. */
export type PersistedTab = {
  selection: TabSelection | null;
  prefs: Partial<ChartViewPrefs>;
};

export type ReplayTabsSnapshot = {
  version: 1;
  savedAt: number;
  activeIndex: number;
  tabs: PersistedTab[];
};

/** Runtime dependencies injected by `tabs.ts` so `tabsPersistence` stays
 *  acyclic with respect to value imports. */
export type SnapshotDeps = {
  defaultPrefs: ChartViewPrefs;
  freshTab: () => Tab;
};

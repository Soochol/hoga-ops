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

export type ToSnapshotInput = {
  tabs: readonly Tab[];
  activeTabId: string;
  prefs: ReadonlyMap<string, ChartViewPrefs>;
  defaultPrefs: ChartViewPrefs;
};

/** Pure projection: live store state → durable snapshot.
 *  Excludes bundles / cursorMs / status / id — see spec table. */
export function toSnapshot(input: ToSnapshotInput): ReplayTabsSnapshot {
  const { tabs, activeTabId, prefs, defaultPrefs } = input;
  const foundIdx = tabs.findIndex((t) => t.id === activeTabId);
  const activeIndex = foundIdx >= 0 ? foundIdx : 0;
  return {
    version: 1,
    savedAt: Date.now(),
    activeIndex,
    tabs: tabs.map((t) => ({
      selection: t.selection,
      prefs: prefs.get(t.id) ?? defaultPrefs,
    })),
  };
}

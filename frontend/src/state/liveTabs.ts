import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useLivePageStore, LIVE_TIMEFRAMES, type LiveTimeframe } from './livePage';
import { attachPersistence } from './persistentSubscriber';
import type { TabViewport } from '../live/viewportAnchor';

export const TABS_SOFT_CAP = 8;

export type LiveTab = {
  id: string;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  /** Saved chart viewport (줌+스크롤) for cold-restore on tab switch (ADR-0069
   *  A안). Captured on switch-AWAY via the registered viewport capture; null
   *  until first captured, and cleared on timeframe change (the bar span is
   *  meaningless across timeframes). See [[viewportAnchor]]. */
  viewport: TabViewport | null;
};

// Viewport capture registry. LiveChartRoot registers a reader over the LIVE
// chart instance; the store calls it on switch-AWAY (focusTab / openOrFocusTab
// new-tab) to snapshot the OUTGOING tab's view before applyTabToPage swaps the
// code and the per-viewKey chart remounts. Module-level (mirrors the applyingTab
// guard pattern): the store can't reach the chart on its own. The capture runs
// synchronously inside the click handler, so chartRef still points at the
// outgoing chart and getVisibleRange() returns the real outgoing viewport — no
// staleness window (unlike useViewportBackfill's snapshot, which needs a layout
// effect precisely because it runs across a data swap).
let viewportCapture: (() => TabViewport | null) | null = null;
export function registerViewportCapture(fn: () => TabViewport | null): () => void {
  viewportCapture = fn;
  return () => {
    if (viewportCapture === fn) viewportCapture = null;
  };
}

/** Snapshot the live chart's current viewport onto the active (outgoing) tab.
 *  No-op when there's no active tab or no registered capture (e.g. tests, or
 *  the empty-state with no chart). */
function snapshotActiveViewport(): void {
  const { tabs, activeTabId } = useLiveTabsStore.getState();
  if (!activeTabId || !viewportCapture) return;
  const vp = viewportCapture();
  if (!vp) return;
  useLiveTabsStore.setState({
    tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, viewport: vp } : t)),
  });
}

type TabsStore = {
  tabs: LiveTab[];
  activeTabId: string | null;
  openOrFocusTab: (code: string, label?: string) => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
};

// Module guard: true while the active-tab→page write (applyTabToPage) runs.
// NOT loop-prevention — the mirror reads useLivePageStore and writes
// useLiveTabsStore, so store separation already closes any loop, and
// applyTabToPage's final page write self-heals the active tab regardless.
// The guard is DEFENSIVE: it (1) suppresses the 2-3 redundant tab-array
// rewrites the transient setActiveCode/setCandleTimeframe resets would
// otherwise trigger mid-push, and (2) future-proofs against a reordering of
// applyTabToPage's setters that would make the last page write no longer equal
// the tab's true value. Module-private: the in-file mirror is its only reader.
let applyingTab = false;
function setApplyingTab(v: boolean): void { applyingTab = v; }

/** Push the active tab's view-state into useLivePageStore in the order that
 *  survives the historicalFromDate resets baked into the page setters. */
export function applyTabToPage(tab: LiveTab | null): void {
  setApplyingTab(true);
  try {
    const page = useLivePageStore.getState();
    page.setActiveCode(tab?.code ?? null);
    if (tab) {
      page.setCandleTimeframe(tab.timeframe);
      if (tab.historicalFromDate) page.extendHistoricalRange(tab.historicalFromDate);
    }
  } finally {
    setApplyingTab(false);
  }
}

const STORAGE_KEY = 'live.tabs.v1';

type TabSnapshot = {
  code: string;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  label: string;
  viewport: TabViewport | null;
};
type TabsSnapshot = { version: 1; activeIndex: number; tabs: TabSnapshot[] };

function isTimeframe(v: unknown): v is LiveTimeframe {
  return typeof v === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(v);
}

/** Defensive parse: a persisted viewport must be a finite-numbers + boolean
 *  shape, else drop to null (older snapshots predate the field → undefined). */
function isViewport(v: unknown): v is TabViewport {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.rightEdgeMs === 'number' && Number.isFinite(o.rightEdgeMs) &&
    typeof o.barSpan === 'number' && Number.isFinite(o.barSpan) && o.barSpan > 0 &&
    typeof o.atLiveEdge === 'boolean'
  );
}

export function toTabsSnapshot(state: Pick<TabsStore, 'tabs' | 'activeTabId'>): TabsSnapshot {
  const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
  return {
    version: 1,
    activeIndex: i < 0 ? 0 : i,
    tabs: state.tabs.map((t) => ({
      code: t.code, timeframe: t.timeframe, historicalFromDate: t.historicalFromDate,
      label: t.label, viewport: t.viewport,
    })),
  };
}

export function loadTabs(): { tabs: LiveTab[]; activeTabId: string | null } {
  // 1) live.tabs.v1
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const snap = JSON.parse(raw) as Partial<TabsSnapshot>;
      if (snap && Array.isArray(snap.tabs) && snap.tabs.length > 0) {
        const rawTabs = snap.tabs;
        // Resolve the active tab by code on the *unfiltered* list (and only for
        // an integer index) so dropping malformed entries below can't shift the
        // selection, and a string/NaN index can't throw away the whole payload.
        const ai = Number.isInteger(snap.activeIndex) ? (snap.activeIndex as number) : 0;
        const activeCodeRaw = rawTabs[Math.min(Math.max(0, ai), rawTabs.length - 1)]?.code;
        const tabs: LiveTab[] = rawTabs
          .filter((t) => t && typeof t.code === 'string')
          .map((t) => ({
            id: nanoid(8),
            code: t.code,
            label: typeof t.label === 'string' && t.label ? t.label : t.code,
            timeframe: isTimeframe(t.timeframe) ? t.timeframe : '1m',
            historicalFromDate: typeof t.historicalFromDate === 'string' ? t.historicalFromDate : null,
            viewport: isViewport(t.viewport) ? t.viewport : null,
          }));
        if (tabs.length > 0) {
          // findIndex=-1 (active entry was dropped) → first-tab fallback.
          const activeIdx = Math.max(0, tabs.findIndex((t) => t.code === activeCodeRaw));
          return { tabs, activeTabId: tabs[activeIdx].id };
        }
      }
    }
  } catch { /* fall through to migration */ }

  // 2) migrate live.page.v1 → single tab
  try {
    const raw = localStorage.getItem('live.page.v1');
    if (raw) {
      const p = JSON.parse(raw) as { activeCode?: string | null; candleTimeframe?: unknown; historicalFromDate?: unknown };
      if (p && typeof p.activeCode === 'string' && p.activeCode) {
        const tab: LiveTab = {
          id: nanoid(8),
          code: p.activeCode,
          label: p.activeCode,
          timeframe: isTimeframe(p.candleTimeframe) ? p.candleTimeframe : '1m',
          historicalFromDate: typeof p.historicalFromDate === 'string' ? p.historicalFromDate : null,
          viewport: null,
        };
        return { tabs: [tab], activeTabId: tab.id };
      }
    }
  } catch { /* fall through to empty */ }

  // 3) empty
  return { tabs: [], activeTabId: null };
}

export const useLiveTabsStore = create<TabsStore>((set, get) => ({
  ...loadTabs(),

  openOrFocusTab: (code, label) => {
    const hit = get().tabs.find((t) => t.code === code);
    if (hit) {
      // Refresh a stale label (e.g. a migrated tab where label===code) when the
      // caller re-opens the same code with a real name from search.
      if (label && label !== hit.label) {
        set({ tabs: get().tabs.map((t) => (t.id === hit.id ? { ...t, label } : t)) });
      }
      get().focusTab(hit.id); // focusTab snapshots the outgoing active viewport
      return;
    }
    if (get().tabs.length >= TABS_SOFT_CAP) return;
    // Capture the outgoing tab's viewport BEFORE adding the new one, then read
    // tabs FRESH so the snapshot's write isn't clobbered by a stale spread.
    snapshotActiveViewport();
    const tab: LiveTab = {
      id: nanoid(8),
      code,
      label: label ?? code,
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
      viewport: null,
    };
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab);
  },

  focusTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    snapshotActiveViewport(); // save the OUTGOING active tab's view before swap
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

// Live wiring (persistence + page→tab mirror) is OPT-IN via initLiveTabsSync(),
// called once at app entry (main.tsx). Importing this module no longer subscribes
// to anything — tests that only need the store/loadTabs don't inherit the
// useLivePageStore mirror subscription. Idempotent: a second call returns the
// existing dispose (StrictMode / HMR / test-beforeEach safe).
let _syncDispose: (() => void) | null = null;

export function initLiveTabsSync(): () => void {
  if (_syncDispose) return _syncDispose;
  const unsubPersist = attachPersistence(useLiveTabsStore, {
    storageKey: STORAGE_KEY,
    toSnapshot: (s) => toTabsSnapshot(s),
  });
  // page→tab mirror: user-initiated tf/pan changes flow into the active tab.
  // The early-return on unchanged tf+hfd also skips indicator-only page changes
  // (MA/volume toggles fire this unselectored subscribe). The applyingTab guard
  // is defensive (see its declaration) — not required for correctness here.
  const unsubMirror = useLivePageStore.subscribe((state, prev) => {
    if (applyingTab) return;
    if (state.candleTimeframe === prev.candleTimeframe && state.historicalFromDate === prev.historicalFromDate) return;
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    if (!activeTabId) return;
    // A timeframe change invalidates the saved viewport — its barSpan is in the
    // OLD timeframe's bars, meaningless after re-aggregation (mirrors how
    // setCandleTimeframe resets historicalFromDate). A pure pan (tf unchanged)
    // leaves viewport alone; it's only read on switch-back and re-captured on
    // the next switch-away.
    const tfChanged = state.candleTimeframe !== prev.candleTimeframe;
    useLiveTabsStore.setState({
      tabs: tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              timeframe: state.candleTimeframe,
              historicalFromDate: state.historicalFromDate,
              ...(tfChanged ? { viewport: null } : {}),
            }
          : t,
      ),
    });
  });
  _syncDispose = () => { unsubPersist(); unsubMirror(); _syncDispose = null; };
  return _syncDispose;
}

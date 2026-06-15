import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useLivePageStore, LIVE_TIMEFRAMES, type LiveTimeframe } from './livePage';
import { attachPersistence } from './persistentSubscriber';
import type { TabViewport } from '../live/viewportAnchor';
import { mirrorPageViewToActiveTab, projectTabToActiveView } from './liveTabProjection';

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
// chart instance; the store calls it on switch-AWAY (focusTab / addBlankTab
// new-tab) to snapshot the OUTGOING tab's view before applyTabToPage swaps the
// code and the per-viewKey chart remounts. Module-level: the store can't reach
// the chart on its own. The capture runs synchronously inside the click handler,
// so chartRef still points at the outgoing chart and getVisibleRange() returns
// the real outgoing viewport — no staleness window (unlike useViewportBackfill's
// snapshot, which needs a layout effect precisely because it runs across a data swap).
let viewportCapture: (() => TabViewport | null) | null = null;
export function registerViewportCapture(fn: () => TabViewport | null): () => void {
  viewportCapture = fn;
  return () => {
    if (viewportCapture === fn) viewportCapture = null;
  };
}

/** Write an already-captured viewport onto the active tab. No-op without an active
 *  tab or with a null viewport. LiveChartRoot's continuous capture calls this
 *  DIRECTLY with its own captureViewport() result (bypassing the registry below) so
 *  its unmount flush can't lose to the registry's own teardown — on route-nav the
 *  registerViewportCapture cleanup may null `viewportCapture` before the capture
 *  effect's cleanup runs, which would make a registry-routed flush a no-op. */
export function saveViewportToActiveTab(vp: TabViewport | null): void {
  if (!vp) return;
  const { tabs, activeTabId } = useLiveTabsStore.getState();
  if (!activeTabId) return;
  useLiveTabsStore.setState({
    tabs: tabs.map((t) => (t.id === activeTabId ? { ...t, viewport: vp } : t)),
  });
}

/** Snapshot the live chart's current viewport onto the active tab via the registered
 *  capture. Called on switch-AWAY (focusTab / addBlankTab) — a synchronous moment
 *  where the chart is alive and the registry is current. No-op without an active tab
 *  or a registered capture (tests / empty-state). */
function snapshotActiveViewport(): void {
  if (!viewportCapture) return;
  saveViewportToActiveTab(viewportCapture());
}

type TabsStore = {
  tabs: LiveTab[];
  activeTabId: string | null;
  /** 활성 탭의 종목을 제자리 교체한다(관심종목/검색/스크리너/히트맵 클릭·드롭의 공통 동작).
   *  활성 탭이 없으면(첫 진입·전체 닫힘) 이 종목으로 첫 탭을 만든다. 단일-탭 내비게이션
   *  모델(ADR-0069 개정): 새 탭은 addBlankTab(=+ 버튼)로만 생기고, 클릭은 현재 탭을 바꾼다.
   *  같은 코드가 다른 탭에 있어도 포커스하지 않고 현재 탭을 교체한다(중복 허용). */
  setActiveTabCode: (code: string, label?: string) => void;
  /** 빈 탭을 만들어 포커스한다(+ 버튼). 종목 선택 전까지 빈 상태(검색 안내)를 보인다. */
  addBlankTab: () => void;
  focusTab: (id: string) => void;
  closeTab: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
};

/** Project the active Live Tab's view-state onto the page in one atomic write.
 *  The active tab is the single writer of useLivePageStore.activeCode (ADR-0052/0069);
 *  projectActiveView sets code+timeframe+pan together so there is no setter ordering
 *  to get wrong. tab=null (last tab closed) clears the code and pan, keeping the
 *  current timeframe. */
export function applyTabToPage(tab: LiveTab | null): void {
  const page = useLivePageStore.getState();
  page.projectActiveView(projectTabToActiveView(tab, page.candleTimeframe));
}

const STORAGE_KEY = 'live.tabs.v1';
const MAX_PERSISTED_TABS = 1000;

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
  const activeIndex = i < 0 ? 0 : i;
  const start = state.tabs.length <= MAX_PERSISTED_TABS
    ? 0
    : Math.min(
        Math.max(0, activeIndex - Math.floor(MAX_PERSISTED_TABS / 2)),
        state.tabs.length - MAX_PERSISTED_TABS,
      );
  const tabs = state.tabs.slice(start, start + MAX_PERSISTED_TABS);
  return {
    version: 1,
    activeIndex: Math.max(0, activeIndex - start),
    tabs: tabs.map((t) => ({
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

  setActiveTabCode: (code, label) => {
    const { tabs, activeTabId } = get();
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active) {
      // 활성 탭이 없으면(첫 진입·전체 닫힘) 이 종목으로 첫 탭을 만든다.
      const tab: LiveTab = {
        id: nanoid(8),
        code,
        label: label ?? code,
        timeframe: useLivePageStore.getState().candleTimeframe,
        historicalFromDate: null,
        viewport: null,
      };
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      applyTabToPage(tab);
      return;
    }
    // 활성 탭의 종목을 제자리 교체 — timeframe은 유지(같은 분봉으로 종목만 전환),
    // pan(historicalFromDate)·viewport는 새 종목의 기본 뷰를 위해 초기화한다(다른 종목의
    // 저장 뷰를 복원하면 안 됨; ADR-0069 A안 viewport는 탭 전환 복귀용). projectActiveView에
    // historicalFromDate: null을 직접 전달하므로 page와 tab 양쪽이 일관된다.
    const updated: LiveTab = { ...active, code, label: label ?? code, historicalFromDate: null, viewport: null };
    set({ tabs: tabs.map((t) => (t.id === active.id ? updated : t)) });
    applyTabToPage(updated);
  },

  addBlankTab: () => {
    // 나가는 탭의 viewport를 새 탭 추가 전에 스냅샷(ADR-0069 A안), 그 후 tabs를 FRESH로 읽어
    // 스냅샷 쓰기가 stale spread에 덮이지 않게 한다.
    snapshotActiveViewport();
    const tab: LiveTab = {
      id: nanoid(8),
      code: '',
      label: '새 탭',
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
      viewport: null,
    };
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab); // code='' → activeCode 비움 → 빈 상태(종목 검색 안내)
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
  // The early-return on unchanged tf+hfd skips indicator-only page changes
  // (MA/volume toggles fire this unselectored subscribe) AND makes the projection's
  // own atomic write a no-op here when the active tab already holds those values.
  const unsubMirror = useLivePageStore.subscribe((state, prev) => {
    if (state.candleTimeframe === prev.candleTimeframe && state.historicalFromDate === prev.historicalFromDate) return;
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    if (!activeTabId) return;
    // Invalidate the saved viewport ONLY when the USER changed the timeframe
    // (its barSpan is in the OLD timeframe's bars, meaningless after re-aggregation
    // — mirrors how setCandleTimeframe resets historicalFromDate). Discriminate the
    // user-tf-change from a TAB SWITCH statelessly via the tab's own tf:
    //   • user clicks a tf button → setCandleTimeframe writes page first, the active
    //     tab still holds the OLD tf → page tf ≠ tab tf → null (correct).
    //   • tab switch → focusTab does set({activeTabId}) BEFORE projectActiveView, so
    //     by the time this mirror fires activeTabId is already the NEW tab and that
    //     tab already carries its own tf → page tf == tab tf → PRESERVE the viewport
    //     we are about to restore (ADR-0069 A안 cross-timeframe switch-back fix).
    // A pure pan (tf unchanged) leaves viewport alone; it's re-captured continuously
    // by LiveChartRoot's debounced range subscription.
    useLiveTabsStore.setState({
      tabs: mirrorPageViewToActiveTab(tabs, activeTabId, state),
    });
  });
  _syncDispose = () => { unsubPersist(); unsubMirror(); _syncDispose = null; };
  return _syncDispose;
}

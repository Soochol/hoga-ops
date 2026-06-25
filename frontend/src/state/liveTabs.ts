import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useLivePageStore, LIVE_TIMEFRAMES, type LiveTimeframe } from './livePage';
import { attachPersistence } from './persistentSubscriber';
import { mirrorPageViewToActiveTab, projectTabToActiveView } from './liveTabProjection';
import {
  instrumentLabel,
  instrumentToActiveCode,
  isLiveInstrument,
  stockInstrument,
  type LiveInstrument,
} from '../live/liveInstrument';

export type LiveTab = {
  id: string;
  instrument?: LiveInstrument | null;
  code: string;
  label: string;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
};

type TabsStore = {
  tabs: LiveTab[];
  activeTabId: string | null;
  /** 활성 탭의 종목을 제자리 교체한다(관심종목/검색/스크리너/히트맵 일반 클릭·드롭의 공통 동작).
   *  활성 탭이 없으면(첫 진입·전체 닫힘) 이 종목으로 첫 탭을 만든다. 단일-탭 기본 모델
   *  (ADR-0069 개정): 일반 클릭은 현재 탭을 바꾸고, 명시적 새 탭 intent(Ctrl/Meta 클릭)는
   *  openSymbolInNewTab을 사용한다. 같은 코드가 다른 탭에 있어도 포커스하지 않고 현재 탭을
   *  교체한다(중복 허용). */
  setActiveTabCode: (code: string, label?: string) => void;
  setActiveTabInstrument: (instrument: LiveInstrument) => void;
  /** 종목이 채워진 새 탭을 만들어 포커스한다(Ctrl/Meta+종목 클릭). 중복 탭은 허용한다. */
  openSymbolInNewTab: (code: string, label?: string) => void;
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

const STORAGE_KEY = 'live.tabs.v2';
const LEGACY_STORAGE_KEY = 'live.tabs.v1';
const MAX_PERSISTED_TABS = 1000;

type TabSnapshot = {
  instrument?: LiveInstrument | null;
  code: string;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  label: string;
};
type TabsSnapshot = { version: 2; activeIndex: number; tabs: TabSnapshot[] };

function isTimeframe(v: unknown): v is LiveTimeframe {
  return typeof v === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(v);
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
    version: 2,
    activeIndex: Math.max(0, activeIndex - start),
    tabs: tabs.map((t) => ({
      instrument: t.instrument,
      code: t.code, timeframe: t.timeframe, historicalFromDate: t.historicalFromDate,
      label: t.label,
    })),
  };
}

function tabFieldsFromInstrument(instrument: LiveInstrument | null): { code: string; label: string } {
  if (!instrument) return { code: '', label: '새 탭' };
  return {
    code: instrumentToActiveCode(instrument) ?? '',
    label: instrumentLabel(instrument),
  };
}

function coerceTabInstrument(t: Partial<TabSnapshot>): LiveInstrument | null {
  if (isLiveInstrument(t.instrument)) return t.instrument;
  if (typeof t.code === 'string' && t.code) {
    return stockInstrument(t.code, typeof t.label === 'string' && t.label ? t.label : t.code);
  }
  return null;
}

function makeTab(params: {
  instrument: LiveInstrument | null;
  timeframe: LiveTimeframe;
  historicalFromDate?: string | null;
}): LiveTab {
  const fields = tabFieldsFromInstrument(params.instrument);
  return {
    id: nanoid(8),
    instrument: params.instrument,
    code: fields.code,
    label: fields.label,
    timeframe: params.timeframe,
    historicalFromDate: params.historicalFromDate ?? null,
  };
}

export function loadTabs(): { tabs: LiveTab[]; activeTabId: string | null } {
  // 1) live.tabs.v2, then legacy live.tabs.v1
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
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
          .map((t) => makeTab({
            instrument: coerceTabInstrument(t),
            timeframe: isTimeframe(t.timeframe) ? t.timeframe : '1m',
            historicalFromDate: typeof t.historicalFromDate === 'string' ? t.historicalFromDate : null,
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
        const tab = makeTab({
          instrument: stockInstrument(p.activeCode),
          timeframe: isTimeframe(p.candleTimeframe) ? p.candleTimeframe : '1m',
          historicalFromDate: typeof p.historicalFromDate === 'string' ? p.historicalFromDate : null,
        });
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
    get().setActiveTabInstrument(stockInstrument(code, label ?? code));
  },

  setActiveTabInstrument: (instrument) => {
    const { tabs, activeTabId } = get();
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active) {
      // 활성 탭이 없으면(첫 진입·전체 닫힘) 이 종목으로 첫 탭을 만든다.
      const tab = makeTab({
        instrument,
        timeframe: useLivePageStore.getState().candleTimeframe,
        historicalFromDate: null,
      });
      set({ tabs: [...tabs, tab], activeTabId: tab.id });
      applyTabToPage(tab);
      return;
    }
    // 활성 탭의 종목을 제자리 교체 — timeframe은 유지(같은 분봉으로 종목만 전환),
    // pan(historicalFromDate)은 새 종목의 기본 뷰를 위해 초기화한다. projectActiveView에
    // historicalFromDate: null을 직접 전달하므로 page와 tab 양쪽이 일관된다.
    const fields = tabFieldsFromInstrument(instrument);
    const updated: LiveTab = {
      ...active,
      instrument,
      code: fields.code,
      label: fields.label,
      historicalFromDate: null,
    };
    set({ tabs: tabs.map((t) => (t.id === active.id ? updated : t)) });
    applyTabToPage(updated);
  },

  openSymbolInNewTab: (code, label) => {
    const tab = makeTab({
      instrument: stockInstrument(code, label ?? code),
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
    });
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab);
  },

  addBlankTab: () => {
    const tab = makeTab({
      instrument: null,
      timeframe: useLivePageStore.getState().candleTimeframe,
      historicalFromDate: null,
    });
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
    applyTabToPage(tab); // code='' → activeCode 비움 → 빈 상태(종목 검색 안내)
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
  // page→tab mirror: user-initiated timeframe changes flow into the active tab.
  // Pan/scrollback is intentionally not mirrored, so tab switches always return
  // to the latest-candle default fit.
  const unsubMirror = useLivePageStore.subscribe((state, prev) => {
    if (state.candleTimeframe === prev.candleTimeframe && state.historicalFromDate === prev.historicalFromDate) return;
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    if (!activeTabId) return;
    useLiveTabsStore.setState({
      tabs: mirrorPageViewToActiveTab(tabs, activeTabId, state),
    });
  });
  _syncDispose = () => { unsubPersist(); unsubMirror(); _syncDispose = null; };
  return _syncDispose;
}

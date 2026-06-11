import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useLiveTabsStore, TABS_SOFT_CAP, loadTabs, toTabsSnapshot, initLiveTabsSync,
  registerViewportCapture,
} from './liveTabs';
import { useLivePageStore } from './livePage';
import type { TabViewport } from '../live/viewportAnchor';

const VP_A: TabViewport = { rightEdgeMs: 1748275200000, barSpan: 300, atLiveEdge: false };

beforeEach(() => {
  localStorage.clear();
  useLiveTabsStore.setState({ tabs: [], activeTabId: null });
  useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
});

describe('useLiveTabsStore', () => {
  it('openOrFocusTab creates a tab and focuses it', () => {
    useLiveTabsStore.getState().openOrFocusTab('005930', '삼성전자');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].code).toBe('005930');
    expect(tabs[0].label).toBe('삼성전자');
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('openOrFocusTab on an existing code focuses, does not duplicate', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930', '삼성전자');
    s.openOrFocusTab('000660', 'SK하이닉스');
    s.openOrFocusTab('005930', '삼성전자');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('005930');
  });

  it('openOrFocusTab refreshes a stale label when re-opening a code with a name', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930'); // migrated tab: label defaults to code
    expect(useLiveTabsStore.getState().tabs[0].label).toBe('005930');
    s.openOrFocusTab('005930', '삼성전자'); // re-opened from search with a real name
    const { tabs } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].label).toBe('삼성전자');
  });

  it('writes the active tab code into useLivePageStore (single writer)', () => {
    useLiveTabsStore.getState().openOrFocusTab('035420', 'NAVER');
    expect(useLivePageStore.getState().activeCode).toBe('035420');
  });

  it('closeTab on active tab focuses the right neighbor (else left)', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001');
    s.openOrFocusTab('B00002');
    s.openOrFocusTab('C00003');
    const mid = useLiveTabsStore.getState().tabs[1].id;
    s.focusTab(mid);
    s.closeTab(mid);
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['A00001', 'C00003']);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('C00003');
  });

  it('closing the last tab clears activeTabId and activeCode', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001');
    s.closeTab(useLiveTabsStore.getState().tabs[0].id);
    expect(useLiveTabsStore.getState().tabs).toHaveLength(0);
    expect(useLiveTabsStore.getState().activeTabId).toBeNull();
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('openOrFocusTab is a no-op at the soft cap', () => {
    const s = useLiveTabsStore.getState();
    for (let i = 0; i < TABS_SOFT_CAP; i++) s.openOrFocusTab(`C${String(i).padStart(5, '0')}`);
    s.openOrFocusTab('Z99999');
    expect(useLiveTabsStore.getState().tabs).toHaveLength(TABS_SOFT_CAP);
    expect(useLiveTabsStore.getState().tabs.some((t) => t.code === 'Z99999')).toBe(false);
  });

  it('closeTab on the rightmost active tab focuses the left neighbor', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001');
    s.openOrFocusTab('B00002');
    s.openOrFocusTab('C00003'); // C is active (rightmost)
    s.closeTab(useLiveTabsStore.getState().tabs[2].id);
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['A00001', 'B00002']);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('B00002');
  });

  it('closing a non-active tab leaves activeTabId unchanged', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001');
    s.openOrFocusTab('B00002');
    s.openOrFocusTab('C00003'); // C is active
    const activeBefore = useLiveTabsStore.getState().activeTabId;
    s.closeTab(useLiveTabsStore.getState().tabs[0].id); // close inactive A
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['B00002', 'C00003']);
    expect(activeTabId).toBe(activeBefore);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('C00003');
  });

  it('reorderTabs moves a tab', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001'); s.openOrFocusTab('B00002'); s.openOrFocusTab('C00003');
    s.reorderTabs(0, 2);
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(['B00002', 'C00003', 'A00001']);
  });

  it('reorderTabs is a no-op when from===to or out of range', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001'); s.openOrFocusTab('B00002'); s.openOrFocusTab('C00003');
    const original = ['A00001', 'B00002', 'C00003'];
    s.reorderTabs(1, 1); // from === to
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(original);
    s.reorderTabs(-1, 2); // from out of range
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(original);
    s.reorderTabs(0, 5); // to out of range
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(original);
  });
});

describe('liveTabs persistence', () => {
  beforeEach(() => localStorage.clear());

  it('migrates live.page.v1 into a single tab when live.tabs.v1 is absent', () => {
    localStorage.setItem('live.page.v1', JSON.stringify({
      activeCode: '005930', candleTimeframe: '5m', historicalFromDate: '20260601',
    }));
    const { tabs, activeTabId } = loadTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].code).toBe('005930');
    expect(tabs[0].timeframe).toBe('5m');
    expect(tabs[0].historicalFromDate).toBe('20260601');
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('loads live.tabs.v1 with activeIndex clamp and reissued ids', () => {
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1, activeIndex: 9,
      tabs: [
        { code: '005930', timeframe: '1m', historicalFromDate: null, label: '삼성전자' },
        { code: '000660', timeframe: 'D', historicalFromDate: '20260101', label: 'SK하이닉스' },
      ],
    }));
    const { tabs, activeTabId } = loadTabs();
    expect(tabs.map((t) => t.code)).toEqual(['005930', '000660']);
    expect(tabs[1].timeframe).toBe('D');
    expect(activeTabId).toBe(tabs[1].id);
    expect(tabs[0].id).not.toBe('');
  });

  it('keeps the active tab (by code) when a malformed entry is filtered out', () => {
    // Malformed entry at raw index 0 makes the raw activeIndex (1 → '000660')
    // shift down a slot after filtering. Index-based selection would pick
    // '035420'; code-based selection must still land on '000660'.
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1, activeIndex: 1, // points at '000660' in the *raw* list
      tabs: [
        { timeframe: '1m', historicalFromDate: null, label: 'malformed (no code)' },
        { code: '000660', timeframe: 'D', historicalFromDate: '20260101', label: 'SK하이닉스' },
        { code: '035420', timeframe: '1m', historicalFromDate: null, label: 'NAVER' },
      ],
    }));
    const { tabs, activeTabId } = loadTabs();
    expect(tabs.map((t) => t.code)).toEqual(['000660', '035420']); // malformed dropped
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('000660');
  });

  it('does not discard valid tabs when activeIndex is non-integer (falls back to first)', () => {
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1, activeIndex: 'x',
      tabs: [
        { code: '005930', timeframe: '1m', historicalFromDate: null, label: '삼성전자' },
        { code: '000660', timeframe: 'D', historicalFromDate: '20260101', label: 'SK하이닉스' },
      ],
    }));
    const { tabs, activeTabId } = loadTabs();
    expect(tabs.map((t) => t.code)).toEqual(['005930', '000660']);
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('returns empty when neither key exists', () => {
    expect(loadTabs()).toEqual({ tabs: [], activeTabId: null });
  });

  it('toTabsSnapshot keeps persisted fields (incl. viewport), drops runtime-only id', () => {
    const snap = toTabsSnapshot({
      tabs: [{ id: 'abc', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: VP_A }],
      activeTabId: 'abc',
    } as never);
    expect(snap).toEqual({
      version: 1, activeIndex: 0,
      tabs: [{ code: '005930', timeframe: '1m', historicalFromDate: null, label: '삼성전자', viewport: VP_A }],
    });
  });

  it('round-trips a saved viewport through save → load', () => {
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1, activeIndex: 0,
      tabs: [{ code: '005930', timeframe: '1m', historicalFromDate: null, label: '삼성전자', viewport: VP_A }],
    }));
    const { tabs } = loadTabs();
    expect(tabs[0].viewport).toEqual(VP_A);
  });

  it('drops a malformed/absent viewport to null on load (forward + backward compat)', () => {
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1, activeIndex: 0,
      tabs: [
        { code: '005930', timeframe: '1m', historicalFromDate: null, label: 'no viewport field' },
        { code: '000660', timeframe: '1m', historicalFromDate: null, label: 'bad viewport', viewport: { rightEdgeMs: 'x', barSpan: -1, atLiveEdge: 1 } },
      ],
    }));
    const { tabs } = loadTabs();
    expect(tabs[0].viewport).toBeNull();
    expect(tabs[1].viewport).toBeNull();
  });

  it('migrated live.page.v1 tab has a null viewport', () => {
    localStorage.setItem('live.page.v1', JSON.stringify({ activeCode: '005930', candleTimeframe: '1m' }));
    const { tabs } = loadTabs();
    expect(tabs[0].viewport).toBeNull();
  });
});

describe('liveTabs ↔ page mirror', () => {
  let _disposeMirror: (() => void) | null = null;
  beforeEach(() => {
    localStorage.clear();
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
    _disposeMirror = initLiveTabsSync();
  });
  afterEach(() => { _disposeMirror?.(); _disposeMirror = null; });

  it('toolbar timeframe change writes into the active tab', () => {
    useLiveTabsStore.getState().openOrFocusTab('005930', '삼성전자');
    useLivePageStore.getState().setCandleTimeframe('5m'); // user toolbar action
    const active = useLiveTabsStore.getState().tabs[0];
    expect(active.timeframe).toBe('5m');
  });

  it('switching tabs restores each tab timeframe', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930', '삼성전자');
    useLivePageStore.getState().setCandleTimeframe('5m'); // tab A → 5m
    s.openOrFocusTab('000660', 'SK하이닉스');             // tab B (inherits 5m)
    useLivePageStore.getState().setCandleTimeframe('D');  // tab B → D
    const tabA = useLiveTabsStore.getState().tabs[0].id;
    s.focusTab(tabA);
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m'); // A restored
  });

  it('pan (historicalFromDate) persists per tab', () => {
    useLiveTabsStore.getState().openOrFocusTab('005930', '삼성전자');
    useLivePageStore.getState().extendHistoricalRange('20260601');
    expect(useLiveTabsStore.getState().tabs[0].historicalFromDate).toBe('20260601');
  });

  it('timeframe change clears the active tab viewport (barSpan invalid across timeframes)', () => {
    useLiveTabsStore.getState().openOrFocusTab('005930', '삼성전자');
    useLiveTabsStore.setState({
      tabs: useLiveTabsStore.getState().tabs.map((t) => ({ ...t, viewport: VP_A })),
    });
    useLivePageStore.getState().setCandleTimeframe('5m'); // toolbar tf change → mirror clears viewport
    expect(useLiveTabsStore.getState().tabs[0].viewport).toBeNull();
  });

  it('a pure pan (historicalFromDate change, tf unchanged) leaves the saved viewport intact', () => {
    useLiveTabsStore.getState().openOrFocusTab('005930', '삼성전자');
    useLiveTabsStore.setState({
      tabs: useLiveTabsStore.getState().tabs.map((t) => ({ ...t, viewport: VP_A })),
    });
    useLivePageStore.getState().extendHistoricalRange('20260601'); // pan, same tf
    expect(useLiveTabsStore.getState().tabs[0].viewport).toEqual(VP_A);
  });
});

describe('liveTabs viewport capture', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
  });

  it('snapshots the OUTGOING active tab viewport on switch', () => {
    const dispose = registerViewportCapture(() => VP_A);
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930', '삼성전자'); // A active; nothing to snapshot yet
    s.openOrFocusTab('000660', 'SK하이닉스'); // switch → A's viewport captured
    const tabs = useLiveTabsStore.getState().tabs;
    expect(tabs.find((t) => t.code === '005930')?.viewport).toEqual(VP_A);
    expect(tabs.find((t) => t.code === '000660')?.viewport).toBeNull(); // new tab clean
    dispose();
  });

  it('new-tab creation reads tabs FRESH so the snapshot is not clobbered by the spread', () => {
    const dispose = registerViewportCapture(() => VP_A);
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930');
    s.openOrFocusTab('000660'); // new-tab path: snapshot A, THEN [...get().tabs, B]
    expect(useLiveTabsStore.getState().tabs[0].viewport).toEqual(VP_A);
    dispose();
  });

  it('focusTab snapshots the outgoing tab but leaves the target tab viewport untouched', () => {
    // Capture is one-directional: the store SAVES viewport on switch-away;
    // restore happens in LiveChartRoot via the restoreViewport prop, not here.
    const dispose = registerViewportCapture(() => VP_A);
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930');
    s.openOrFocusTab('000660'); // leaving A → A.viewport = VP_A
    const aId = useLiveTabsStore.getState().tabs[0].id;
    s.focusTab(aId);            // leaving B → B.viewport = VP_A; A unchanged
    expect(useLiveTabsStore.getState().tabs[0].viewport).toEqual(VP_A);
    dispose();
  });

  it('no registered capture → switch leaves viewport null (tests / empty chart)', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930');
    s.openOrFocusTab('000660');
    expect(useLiveTabsStore.getState().tabs[0].viewport).toBeNull();
  });

  it('a null capture result is not written (degenerate / torn-down chart)', () => {
    const dispose = registerViewportCapture(() => null);
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('005930');
    s.openOrFocusTab('000660');
    expect(useLiveTabsStore.getState().tabs[0].viewport).toBeNull();
    dispose();
  });
});

describe('initLiveTabsSync', () => {
  beforeEach(() => {
    localStorage.clear();
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
  });

  it('is idempotent — a second call returns the same dispose (no double-subscribe)', () => {
    const d1 = initLiveTabsSync();
    const d2 = initLiveTabsSync();
    expect(d1).toBe(d2);
    d1();
  });

  it('dispose stops the page→tab mirror', () => {
    const dispose = initLiveTabsSync();
    useLiveTabsStore.getState().openOrFocusTab('005930', '삼성전자');
    dispose();
    useLivePageStore.getState().setCandleTimeframe('5m'); // after dispose — must NOT mirror
    expect(useLiveTabsStore.getState().tabs[0].timeframe).toBe('1m'); // unchanged
  });
});

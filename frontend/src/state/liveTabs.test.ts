import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  useLiveTabsStore, loadTabs, toTabsSnapshot, initLiveTabsSync,
} from './liveTabs';
import { useLivePageStore } from './livePage';
import { stockInstrument } from '../live/liveInstrument';

beforeEach(() => {
  localStorage.clear();
  useLiveTabsStore.setState({ tabs: [], activeTabId: null });
  useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
});

// 단일-탭 내비게이션 모델(ADR-0069 개정): 새 탭은 addBlankTab(=+ 버튼)로만 생기고,
// 클릭/검색/드롭은 setActiveTabCode로 현재 탭을 바꾼다. 다중 탭 셋업 헬퍼 — 빈 탭을
// 추가하고(=새 탭) 그 탭에 종목을 채운다.
function openTab(code: string, label?: string) {
  const s = useLiveTabsStore.getState();
  s.addBlankTab();
  s.setActiveTabCode(code, label);
}

describe('useLiveTabsStore', () => {
  it('setActiveTabCode creates the first tab when none exists', () => {
    useLiveTabsStore.getState().setActiveTabCode('005930', '삼성전자');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].code).toBe('005930');
    expect(tabs[0].label).toBe('삼성전자');
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('setActiveTabCode replaces the active tab in place (same id, no new tab)', () => {
    const s = useLiveTabsStore.getState();
    s.setActiveTabCode('005930', '삼성전자');
    const firstId = useLiveTabsStore.getState().activeTabId;
    s.setActiveTabCode('000660', 'SK하이닉스');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).toBe(firstId);          // 같은 탭을 교체
    expect(tabs[0].code).toBe('000660');
    expect(tabs[0].label).toBe('SK하이닉스');
  });

  it('setActiveTabCode changes only the active tab and allows a duplicate code', () => {
    openTab('005930', '삼성전자');   // 탭 A
    openTab('000660', 'SK하이닉스'); // 탭 B (활성)
    // 같은 코드가 A에 있어도 포커스하지 않고 현재 탭(B)을 교체 → 중복 허용.
    useLiveTabsStore.getState().setActiveTabCode('005930', '삼성전자');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.code)).toEqual(['005930', '005930']);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('005930');
  });

  it('setActiveTabCode keeps the tab timeframe but resets pan (historicalFromDate)', () => {
    openTab('005930', '삼성전자');
    // 활성 탭에 tf + pan을 직접 부여(미러 없이) 한 뒤 종목만 바꾼다.
    useLiveTabsStore.setState((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === st.activeTabId ? { ...t, timeframe: '5m', historicalFromDate: '20260601' } : t,
      ),
    }));
    useLiveTabsStore.getState().setActiveTabCode('000660');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    const active = tabs.find((t) => t.id === activeTabId)!;
    expect(active.code).toBe('000660');
    expect(active.timeframe).toBe('5m');          // 유지
    expect(active.historicalFromDate).toBeNull(); // 초기화
  });

  it('writes the active tab code into useLivePageStore (single writer)', () => {
    useLiveTabsStore.getState().setActiveTabCode('035420', 'NAVER');
    expect(useLivePageStore.getState().activeCode).toBe('035420');
  });

  it('setActiveTabInstrument creates an index tab and clears the stock activeCode projection', () => {
    useLiveTabsStore.getState().setActiveTabInstrument({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
    });
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    const active = tabs.find((t) => t.id === activeTabId)!;
    expect(active.instrument).toEqual({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });
    expect(active.code).toBe('');
    expect(active.label).toBe('KOSPI');
    expect(useLivePageStore.getState().activeInstrument).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
    });
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('addBlankTab adds a focused blank tab and clears the page active code', () => {
    useLivePageStore.setState({ activeCode: '005930' });
    useLiveTabsStore.getState().addBlankTab();
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].code).toBe('');
    expect(tabs[0].label).toBe('새 탭');
    expect(activeTabId).toBe(tabs[0].id);
    expect(useLivePageStore.getState().activeCode).toBe(''); // 빈 탭 → 빈 상태(검색 안내)
  });

  it('setActiveTabCode fills the active blank tab in place (no new tab)', () => {
    const s = useLiveTabsStore.getState();
    s.addBlankTab();
    const blankId = useLiveTabsStore.getState().activeTabId;
    s.setActiveTabCode('005930', '삼성전자');
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeTabId).toBe(blankId);  // 같은(빈) 탭을 채움
    expect(tabs[0].code).toBe('005930');
    expect(tabs[0].label).toBe('삼성전자');
  });

  it('closeTab on active tab focuses the right neighbor (else left)', () => {
    const s = useLiveTabsStore.getState();
    openTab('A00001');
    openTab('B00002');
    openTab('C00003');
    const mid = useLiveTabsStore.getState().tabs[1].id;
    s.focusTab(mid);
    s.closeTab(mid);
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['A00001', 'C00003']);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('C00003');
  });

  it('closing the last tab clears activeTabId and activeCode', () => {
    openTab('A00001');
    useLiveTabsStore.getState().closeTab(useLiveTabsStore.getState().tabs[0].id);
    expect(useLiveTabsStore.getState().tabs).toHaveLength(0);
    expect(useLiveTabsStore.getState().activeTabId).toBeNull();
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('addBlankTab allows more than the old 8-tab cap', () => {
    for (let i = 0; i < 9; i++) openTab(`C${String(i).padStart(5, '0')}`);
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs).toHaveLength(9);
    expect(tabs.map((t) => t.code)).toEqual([
      'C00000', 'C00001', 'C00002', 'C00003', 'C00004',
      'C00005', 'C00006', 'C00007', 'C00008',
    ]);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('C00008');
  });

  it('closeTab on the rightmost active tab focuses the left neighbor', () => {
    openTab('A00001');
    openTab('B00002');
    openTab('C00003'); // C가 활성(우측 끝)
    useLiveTabsStore.getState().closeTab(useLiveTabsStore.getState().tabs[2].id);
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['A00001', 'B00002']);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('B00002');
  });

  it('closing a non-active tab leaves activeTabId unchanged', () => {
    openTab('A00001');
    openTab('B00002');
    openTab('C00003'); // C가 활성
    const activeBefore = useLiveTabsStore.getState().activeTabId;
    useLiveTabsStore.getState().closeTab(useLiveTabsStore.getState().tabs[0].id); // 비활성 A 닫기
    const { tabs, activeTabId } = useLiveTabsStore.getState();
    expect(tabs.map((t) => t.code)).toEqual(['B00002', 'C00003']);
    expect(activeTabId).toBe(activeBefore);
    expect(tabs.find((t) => t.id === activeTabId)?.code).toBe('C00003');
  });

  it('reorderTabs moves a tab', () => {
    openTab('A00001'); openTab('B00002'); openTab('C00003');
    useLiveTabsStore.getState().reorderTabs(0, 2);
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(['B00002', 'C00003', 'A00001']);
  });

  it('reorderTabs is a no-op when from===to or out of range', () => {
    openTab('A00001'); openTab('B00002'); openTab('C00003');
    const s = useLiveTabsStore.getState();
    const original = ['A00001', 'B00002', 'C00003'];
    s.reorderTabs(1, 1); // from === to
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(original);
    s.reorderTabs(-1, 2); // from out of range
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(original);
    s.reorderTabs(0, 5); // to out of range
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(original);
  });

  it('switching to a tab projects code+timeframe and resets pan to latest fit', () => {
    openTab('005930', '삼성전자');
    useLiveTabsStore.setState((st) => ({
      tabs: st.tabs.map((t) => (t.id === st.activeTabId ? { ...t, timeframe: '5m', historicalFromDate: '20260601' } : t)),
    }));
    const tabA = useLiveTabsStore.getState().activeTabId!;
    openTab('000660', 'SK하이닉스'); // switch to B
    useLiveTabsStore.getState().focusTab(tabA); // back to A
    const page = useLivePageStore.getState();
    expect(page.activeCode).toBe('005930');
    expect(page.candleTimeframe).toBe('5m');
    expect(page.historicalFromDate).toBeNull(); // pan is not restored; chart starts at latest fit
  });

  it('focusTab ignores stored historicalFromDate so tab switches start at latest fit', () => {
    openTab('005930', '삼성전자');
    const tabId = useLiveTabsStore.getState().tabs[0].id;
    useLiveTabsStore.setState({
      tabs: useLiveTabsStore.getState().tabs.map((t) => (
        t.id === tabId ? { ...t, historicalFromDate: '20260601' } : t
      )),
    });

    useLivePageStore.setState({ historicalFromDate: '20260501' });
    useLiveTabsStore.getState().focusTab(tabId);

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('stores a runtime viewport on the active tab and restores it when focused again', () => {
    const viewport = {
      rightEdgeMs: 1_781_000_000_000,
      barSpan: 331,
      atLiveEdge: false,
    };
    openTab('005930', '삼성전자');
    const tabA = useLiveTabsStore.getState().activeTabId!;
    useLiveTabsStore.getState().updateTabViewport(tabA, viewport);
    openTab('000660', 'SK하이닉스');

    useLiveTabsStore.getState().focusTab(tabA);

    expect(useLiveTabsStore.getState().tabs.find((t) => t.id === tabA)?.viewport).toEqual(viewport);
    expect(useLivePageStore.getState().activeViewport).toEqual(viewport);
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

  it('migrates live.tabs.v1 stock tabs into stock instruments', () => {
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1,
      activeIndex: 0,
      tabs: [{
        code: '005930',
        label: '삼성전자',
        timeframe: '5m',
        historicalFromDate: '20260601',
      }],
    }));
    const { tabs } = loadTabs();
    expect(tabs[0].instrument).toEqual({
      kind: 'stock',
      code: '005930',
      label: '삼성전자',
    });
    expect(tabs[0].code).toBe('005930');
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

  it('toTabsSnapshot keeps persisted fields and drops runtime-only id and viewport', () => {
    const snap = toTabsSnapshot({
      tabs: [{
        id: 'abc',
        instrument: stockInstrument('005930', '삼성전자'),
        code: '005930',
        label: '삼성전자',
        timeframe: '1m',
        historicalFromDate: null,
        viewport: { rightEdgeMs: 1, barSpan: 2, atLiveEdge: false },
      }],
      activeTabId: 'abc',
    } as never);
    expect(snap).toEqual({
      version: 2, activeIndex: 0,
      tabs: [{
        instrument: { kind: 'stock', code: '005930', label: '삼성전자' },
        code: '005930',
        timeframe: '1m',
        historicalFromDate: null,
        label: '삼성전자',
      }],
    });
  });

  it('toTabsSnapshot persists a bounded active-centered window for pathological tab counts', () => {
    const tabs = Array.from({ length: 1005 }, (_, index) => ({
      id: `tab-${index}`,
      instrument: stockInstrument(String(100000 + index), `종목 ${index + 1}`),
      code: String(100000 + index),
      label: `종목 ${index + 1}`,
      timeframe: '1m' as const,
      historicalFromDate: null,
    }));
    const snap = toTabsSnapshot({ tabs, activeTabId: 'tab-1004' });
    expect(snap.tabs).toHaveLength(1000);
    expect(snap.tabs[0].code).toBe('100005');
    expect(snap.tabs[999].code).toBe('101004');
    expect(snap.activeIndex).toBe(999);
  });

  it('ignores persisted viewport fields on load', () => {
    localStorage.setItem('live.tabs.v1', JSON.stringify({
      version: 1, activeIndex: 0,
      tabs: [
        { code: '005930', timeframe: '1m', historicalFromDate: null, label: 'legacy viewport', viewport: { rightEdgeMs: 1, barSpan: 10, atLiveEdge: false } },
      ],
    }));
    const { tabs } = loadTabs();
    expect('viewport' in tabs[0]).toBe(false);
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
    openTab('005930', '삼성전자');
    useLivePageStore.getState().setCandleTimeframe('5m'); // user toolbar action
    const active = useLiveTabsStore.getState().tabs[0];
    expect(active.timeframe).toBe('5m');
  });

  it('toolbar timeframe change clears the active tab viewport', () => {
    openTab('005930', '삼성전자');
    const tabId = useLiveTabsStore.getState().activeTabId!;
    useLiveTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 1_781_000_000_000,
      barSpan: 331,
      atLiveEdge: true,
    });

    useLivePageStore.getState().setCandleTimeframe('5m');

    expect(useLiveTabsStore.getState().tabs[0].viewport).toBeNull();
  });

  it('switching tabs restores each tab timeframe', () => {
    const s = useLiveTabsStore.getState();
    openTab('005930', '삼성전자');
    useLivePageStore.getState().setCandleTimeframe('5m'); // tab A → 5m
    openTab('000660', 'SK하이닉스');                       // tab B (inherits 5m)
    useLivePageStore.getState().setCandleTimeframe('D');  // tab B → D
    const tabA = useLiveTabsStore.getState().tabs[0].id;
    s.focusTab(tabA);
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m'); // A restored
  });

  it('pan changes are mirrored into the active tab without changing viewport', () => {
    openTab('005930', '삼성전자');
    useLivePageStore.getState().extendHistoricalRange('20260601');
    expect(useLiveTabsStore.getState().tabs[0].historicalFromDate).toBe('20260601');
    expect(useLiveTabsStore.getState().tabs[0].viewport).toBeNull();
  });

  it('projecting a tab is idempotent on the active tab and does not churn its fields (mirror works without the guard)', () => {
    openTab('005930', '삼성전자');
    useLivePageStore.getState().setCandleTimeframe('5m'); // mirror → tab A.timeframe = 5m
    const before = useLiveTabsStore.getState().tabs[0];
    useLiveTabsStore.getState().focusTab(before.id); // re-project the SAME active tab
    const after = useLiveTabsStore.getState().tabs[0];
    expect(after.timeframe).toBe('5m');
    expect(after.historicalFromDate).toBe(before.historicalFromDate);
    expect(useLivePageStore.getState().candleTimeframe).toBe('5m');
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
    openTab('005930', '삼성전자');
    dispose();
    useLivePageStore.getState().setCandleTimeframe('5m'); // after dispose — must NOT mirror
    expect(useLiveTabsStore.getState().tabs[0].timeframe).toBe('1m'); // unchanged
  });
});

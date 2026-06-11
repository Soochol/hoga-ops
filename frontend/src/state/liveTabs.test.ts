import { describe, it, expect, beforeEach } from 'vitest';
import { useLiveTabsStore, TABS_SOFT_CAP } from './liveTabs';
import { useLivePageStore } from './livePage';

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

  it('reorderTabs moves a tab', () => {
    const s = useLiveTabsStore.getState();
    s.openOrFocusTab('A00001'); s.openOrFocusTab('B00002'); s.openOrFocusTab('C00003');
    s.reorderTabs(0, 2);
    expect(useLiveTabsStore.getState().tabs.map((t) => t.code)).toEqual(['B00002', 'C00003', 'A00001']);
  });
});

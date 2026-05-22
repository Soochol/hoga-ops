import { describe, it, expect, beforeEach } from 'vitest';
import { useTabsStore } from '../../src/state/tabs';
import { useToolbarDraftStore } from '../../src/state/toolbarDraft';

describe('tabs store', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useToolbarDraftStore.getState().reset();
  });

  it('starts with one empty tab', () => {
    expect(useTabsStore.getState().tabs.length).toBe(1);
    expect(useTabsStore.getState().tabs[0].selection).toBeNull();
  });

  it('newTab adds and activates', () => {
    const id = useTabsStore.getState().newTab();
    expect(useTabsStore.getState().tabs.length).toBe(2);
    expect(useTabsStore.getState().activeTabId).toBe(id);
  });

  it('closeTab removes; last tab close X disabled by guard', () => {
    const id = useTabsStore.getState().newTab();
    useTabsStore.getState().closeTab(id);
    expect(useTabsStore.getState().tabs.length).toBe(1);
    useTabsStore.getState().closeTab(useTabsStore.getState().tabs[0].id);
    expect(useTabsStore.getState().tabs.length).toBe(1);
  });

  it('enforces 8-tab soft cap', () => {
    for (let i = 0; i < 7; i++) useTabsStore.getState().newTab();
    expect(useTabsStore.getState().tabs.length).toBe(8);
    useTabsStore.getState().newTab({ confirmEvictOldest: true });
    expect(useTabsStore.getState().tabs.length).toBe(8);
  });

  it('closeTab clears any draft entry for the closed tab', () => {
    const id1 = useTabsStore.getState().activeTabId;
    const id2 = useTabsStore.getState().newTab();
    useToolbarDraftStore.getState().setDraft(id1, {
      code: '003490',
      from: '20260511',
      to: '20260511',
    });
    useToolbarDraftStore.getState().setDraft(id2, {
      code: '005930',
      from: null,
      to: null,
    });
    useTabsStore.getState().closeTab(id1);
    expect(useToolbarDraftStore.getState().getDraft(id1)).toEqual({
      code: null,
      from: null,
      to: null,
      timeframe: '1m',
    });
    // Other tab's draft untouched
    expect(useToolbarDraftStore.getState().getDraft(id2).code).toBe('005930');
  });
});

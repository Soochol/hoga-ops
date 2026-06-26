import { beforeEach, describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { studyTabFromSave, toStudyTabsSnapshot, useStudyTabsStore } from './studyTabs';

const save = {
  schema_version: 2,
  id: 'view1',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  range: { from_date: '20260616', to_date: '20260616', from_ms: 1, to_ms: 2 },
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 100,
  updated_at_ms: 200,
} satisfies StudyViewReference;

describe('studyTabs store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useStudyTabsStore.setState({ tabs: [], activeTabId: null });
  });

  it('creates a tab from a saved study view', () => {
    const tab = studyTabFromSave(save);
    expect(tab).toMatchObject({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자 · 장초반 · 1m',
      timeframe: '1m',
    });
  });

  it('replaces the active tab for normal navigation', () => {
    useStudyTabsStore.getState().openSaveInActiveTab(save);
    const first = useStudyTabsStore.getState().activeTabId;
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2', name: '마감' });
    const state = useStudyTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(first);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view2', name: '마감' });
  });

  it('focuses an existing tab instead of replacing the active tab for the same saved view', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const [firstTab, secondTab] = useStudyTabsStore.getState().tabs;

    useStudyTabsStore.getState().openSaveInActiveTab(save);

    const state = useStudyTabsStore.getState();
    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view1', 'view2']);
    expect(state.activeTabId).toBe(firstTab.id);
    expect(state.tabs.find((tab) => tab.id === secondTab.id)).toMatchObject({ viewId: 'view2', name: '마감' });
  });

  it('treats same-code same-name saves as distinct tabs when their saved view ids differ', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const firstTabId = useStudyTabsStore.getState().activeTabId;
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2' });

    const state = useStudyTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(firstTabId);
    expect(state.tabs[0]).toMatchObject({ viewId: 'view2', code: '005930', name: '장초반' });
  });

  it('opens Ctrl-click saves in a new tab', () => {
    useStudyTabsStore.getState().openSaveInActiveTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const state = useStudyTabsStore.getState();
    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view1', 'view2']);
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId).toBe('view2');
  });

  it('serializes without ephemeral generated ids', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).toEqual({
      viewId: 'view1',
      code: '005930',
      label: '삼성전자 · 장초반 · 1m',
      name: '장초반',
      timeframe: '1m',
    });
  });

  it('keeps tab viewport in memory but excludes it from the persisted snapshot', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const tabId = useStudyTabsStore.getState().activeTabId!;

    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: false,
    });

    expect(useStudyTabsStore.getState().tabs[0].viewport).toEqual({
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: false,
    });
    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).not.toHaveProperty('viewport');
  });

  it('closes every tab for a deleted study view and focuses a safe neighbor', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view1', name: '장초반 복사' });

    const nextActive = useStudyTabsStore.getState().closeTabsByViewId('view1');
    const state = useStudyTabsStore.getState();

    expect(state.tabs.map((tab) => tab.viewId)).toEqual(['view2']);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(nextActive?.viewId).toBe('view2');
  });
});

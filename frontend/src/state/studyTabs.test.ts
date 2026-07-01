import { beforeEach, describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { studyTabFromSave, toStudyTabsSnapshot, useStudyTabsStore } from './studyTabs';
import { useStudyViewOpenPrefsStore } from './studyViewOpenPrefs';

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
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '3m' });
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

  it('opens saved views from the side panel with the configured default minute timeframe', () => {
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' }, { timeframeOverride: '3m' });
    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '3m',
      label: '삼성전자 · 장초반 · 3m',
    });
  });

  it('updates an existing saved-view tab to the configured side-panel timeframe when clicked again', () => {
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' });
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' }, { timeframeOverride: '3m' });

    expect(useStudyTabsStore.getState().tabs).toHaveLength(1);
    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '3m',
      label: '삼성전자 · 장초반 · 3m',
    });
  });

  it('clears an existing saved-view tab viewport when reopening it with a different timeframe', () => {
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' });
    const tabId = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: false,
    });

    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' }, { timeframeOverride: '3m' });

    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '3m',
      viewport: null,
    });
  });

  it('keeps the saved view timeframe when no side-panel override is provided', () => {
    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, timeframe: '10m' });

    expect(useStudyTabsStore.getState().tabs[0]).toMatchObject({
      timeframe: '10m',
      label: '삼성전자 · 장초반 · 10m',
    });
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

  it('persists pinned state in study tab snapshots', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const id = useStudyTabsStore.getState().activeTabId!;

    useStudyTabsStore.getState().toggleTabPinned(id);

    expect(toStudyTabsSnapshot(useStudyTabsStore.getState()).tabs[0]).toMatchObject({
      viewId: save.id,
      pinned: true,
    });
  });

  it('keeps pinned study tabs before unpinned tabs when toggled', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const second = useStudyTabsStore.getState().tabs[1].id;

    useStudyTabsStore.getState().toggleTabPinned(second);

    expect(useStudyTabsStore.getState().tabs.map((t) => [t.viewId, Boolean(t.pinned)])).toEqual([
      ['view2', true],
      ['view1', false],
    ]);
  });

  it('does not close pinned study tabs', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const id = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().toggleTabPinned(id);

    useStudyTabsStore.getState().closeTab(id);

    expect(useStudyTabsStore.getState().tabs).toHaveLength(1);
    expect(useStudyTabsStore.getState().tabs[0].id).toBe(id);
  });

  it('does not drag study tabs across the pinned boundary', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    useStudyTabsStore.getState().openSaveInNewTab({ ...save, id: 'view2', name: '마감' });
    const first = useStudyTabsStore.getState().tabs[0].id;
    useStudyTabsStore.getState().toggleTabPinned(first);

    useStudyTabsStore.getState().reorderTabs(0, 1);

    expect(useStudyTabsStore.getState().tabs.map((t) => t.viewId)).toEqual(['view1', 'view2']);
  });

  it('opens an unpinned study tab when the active pinned tab would be replaced', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const pinnedId = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().toggleTabPinned(pinnedId);

    useStudyTabsStore.getState().openSaveInActiveTab({ ...save, id: 'view2', name: '마감' });

    expect(useStudyTabsStore.getState().tabs.map((t) => [t.viewId, Boolean(t.pinned)])).toEqual([
      ['view1', true],
      ['view2', false],
    ]);
    expect(useStudyTabsStore.getState().activeTabId).not.toBe(pinnedId);
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

  it('keeps a previously captured right padding when a later capture cannot compute it', () => {
    useStudyTabsStore.getState().openSaveInNewTab(save);
    const tabId = useStudyTabsStore.getState().activeTabId!;
    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: true,
      rightPaddingBars: 12,
    });

    useStudyTabsStore.getState().updateTabViewport(tabId, {
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: true,
    });

    expect(useStudyTabsStore.getState().tabs[0].viewport).toEqual({
      rightEdgeMs: 9_000,
      barSpan: 42,
      atLiveEdge: true,
      rightPaddingBars: 12,
    });
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

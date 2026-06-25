import { beforeEach, describe, expect, it } from 'vitest';
import type { ParquetStudyView } from '../api/studyViews';
import { studyTabFromSave, toStudyTabsSnapshot, useStudyTabsStore } from './studyTabs';

const save = {
  id: 'view1',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  snapshot_from_ms: 1,
  snapshot_to_ms: 2,
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  indicator_state: {
    volume_enabled: true,
    quote_totals_enabled: true,
    ratio_enabled: true,
    fill_strength_enabled: true,
    aggregation_basis: 'close',
    auction_window_mask: true,
    ratio_outlier_filter_enabled: false,
    ratio_outlier_threshold: 50,
  },
  memo: '',
  tags: [],
  provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
  snapshot_schema_version: 1,
  snapshot_path: '',
  snapshot_size_bytes: 1,
  created_at_ms: 100,
  updated_at_ms: 200,
} satisfies ParquetStudyView;

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

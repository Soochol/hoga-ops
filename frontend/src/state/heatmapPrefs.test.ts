import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useHeatmapPrefsStore, SORT_MODES, GROUP_SORTS } from './heatmapPrefs';
import type { SortMode, GroupSort } from '../heatmap/heat';

describe('useHeatmapPrefsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  });

  it('기본값 manual (eng-review D2: 안정 보드·큐레이션 순서 유지, 등락률 정렬은 옵트인)', () => {
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('manual');
  });
  it('setSortMode 갱신 + 영속 (desc/asc)', () => {
    useHeatmapPrefsStore.getState().setSortMode('desc');
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('desc');
    expect(localStorage.getItem('heatmap.sortMode.v1')).toContain('desc');
    useHeatmapPrefsStore.getState().setSortMode('asc');
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('asc');
  });
  it('알 수 없는 값 무시', () => {
    const before = useHeatmapPrefsStore.getState().sortMode;
    useHeatmapPrefsStore.getState().setSortMode('bogus' as SortMode);
    expect(useHeatmapPrefsStore.getState().sortMode).toBe(before);
  });
  it('SORT_MODES = [manual, desc, asc]', () => {
    expect(SORT_MODES).toEqual(['manual', 'desc', 'asc']);
  });
  it('구 값 change → desc 로 마이그레이션', async () => {
    localStorage.setItem('heatmap.sortMode.v1', JSON.stringify({ sortMode: 'change' }));
    vi.resetModules();
    const { useHeatmapPrefsStore: fresh } = await import('./heatmapPrefs');
    expect(fresh.getState().sortMode).toBe('desc');
  });
  it('groupSort 기본값 manual', () => {
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  });
  it('setGroupSort 갱신 + 별도 키 영속', () => {
    useHeatmapPrefsStore.getState().setGroupSort('desc');
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('desc');
    expect(localStorage.getItem('heatmap.groupSort.v1')).toContain('desc');
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('manual'); // sortMode 불변
  });
  it('groupSort 알 수 없는 값 무시', () => {
    useHeatmapPrefsStore.getState().setGroupSort('bogus' as GroupSort);
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  });
  it('GROUP_SORTS = [manual, desc, asc]', () => {
    expect(GROUP_SORTS).toEqual(['manual', 'desc', 'asc']);
  });
});

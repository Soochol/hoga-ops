import { describe, it, expect, beforeEach } from 'vitest';
import { useHeatmapPrefsStore, SORT_MODES, GROUP_SORTS } from './heatmapPrefs';
import type { SortMode, GroupSort } from '../heatmap/heat';

describe('useHeatmapPrefsStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  });

  it('기본값 manual (eng-review D2: 안정 보드·큐레이션 순서 유지, change는 옵트인)', () => {
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('manual');
  });
  it('setSortMode 갱신 + 영속', () => {
    useHeatmapPrefsStore.getState().setSortMode('change');
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('change');
    expect(localStorage.getItem('heatmap.sortMode.v1')).toContain('change');
  });
  it('알 수 없는 값 무시', () => {
    const before = useHeatmapPrefsStore.getState().sortMode;
    useHeatmapPrefsStore.getState().setSortMode('bogus' as SortMode);
    expect(useHeatmapPrefsStore.getState().sortMode).toBe(before);
  });
  it('SORT_MODES = [change, manual]', () => {
    expect(SORT_MODES).toEqual(['change', 'manual']);
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

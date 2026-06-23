import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStudyViewTreeState } from './useStudyViewTreeState';

const rows = [
  { id: 'a', label: '삼성전자', code: '005930', name: '급등 이후', memo: 'memo one' },
  { id: 'b', label: 'SK하이닉스', code: '000660', name: '눌림', memo: 'space memo' },
  { id: 'c', label: '삼성전자', code: '005930', name: '종가 반등', memo: 'close rebound' },
];

describe('useStudyViewTreeState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('derives visible groups from rows and query', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows));

    expect(result.current.visibleGroups.map((group) => [group.code, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['a', 'c']],
      ['000660', ['b']],
    ]);

    act(() => result.current.setQuery('close rebound'));

    expect(result.current.query).toBe('close rebound');
    expect(result.current.visibleGroups.map((group) => [group.code, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['c']],
    ]);
  });

  it('persists collapsed Code keys and prunes stale keys', () => {
    localStorage.setItem('studyViews.collapsedGroups.v1', JSON.stringify({ keys: ['005930', '999999'] }));

    const { result } = renderHook(() => useStudyViewTreeState(rows));

    expect(result.current.isCollapsed('005930')).toBe(true);
    expect(result.current.isCollapsed('000660')).toBe(false);
    expect(JSON.parse(localStorage.getItem('studyViews.collapsedGroups.v1') ?? '{}')).toEqual({ keys: ['005930'] });
  });

  it('toggles one group and applies bulk actions to visible groups only', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows));

    act(() => result.current.setQuery('SK'));
    expect(result.current.visibleGroupsCollapsed).toBe(false);
    act(() => result.current.toggleVisibleGroups());

    expect(result.current.isCollapsed('000660')).toBe(true);
    expect(result.current.isCollapsed('005930')).toBe(false);
    expect(result.current.visibleGroupsCollapsed).toBe(true);

    act(() => result.current.setQuery(''));
    act(() => result.current.toggleGroup('005930'));

    expect(result.current.isCollapsed('005930')).toBe(true);
    expect(result.current.visibleGroupsCollapsed).toBe(true);

    act(() => result.current.toggleVisibleGroups());

    expect(result.current.isCollapsed('005930')).toBe(false);
    expect(result.current.isCollapsed('000660')).toBe(false);
    expect(result.current.visibleGroupsCollapsed).toBe(false);
  });

  it('cycles and persists the tree sort mode', () => {
    const { result, rerender } = renderHook(() => useStudyViewTreeState(rows));

    expect(result.current.sortAction).toMatchObject({ label: '이름 오름차순 정렬', direction: 'default', pressed: false });

    act(() => result.current.cycleSortMode());

    expect(result.current.sortMode).toBe('name-asc');
    expect(result.current.sortAction).toMatchObject({ label: '이름 내림차순 정렬', direction: 'asc', pressed: true });
    expect(JSON.parse(localStorage.getItem('studyViews.treeSortMode.v1') ?? '{}')).toEqual({ sortMode: 'name-asc' });

    act(() => result.current.cycleSortMode());
    expect(result.current.sortMode).toBe('name-desc');

    act(() => result.current.cycleSortMode());
    expect(result.current.sortMode).toBe('default');

    rerender();
    expect(result.current.sortMode).toBe('default');
  });

  it('reorders groups and rows in default sort mode and persists manual order', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows));

    act(() => result.current.reorderGroup('000660', '005930'));
    expect(result.current.visibleGroups.map((group) => group.code)).toEqual(['000660', '005930']);

    act(() => result.current.reorderRow('005930', 'c', 'a'));
    expect(result.current.visibleGroups.find((group) => group.code === '005930')?.rows.map((row) => row.id)).toEqual(['c', 'a']);
    expect(JSON.parse(localStorage.getItem('studyViews.treeManualOrder.v1') ?? '{}')).toEqual({
      groupKeys: ['000660', '005930'],
      rowIdsByGroup: { '005930': ['c', 'a'] },
    });
  });
});

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStudyViewTreeState } from './useStudyViewTreeState';

const rows = [
  { id: 'a', label: '삼성전자', code: '005930', group_id: '005930', name: '급등 이후', memo: 'memo one' },
  { id: 'b', label: 'SK하이닉스', code: '000660', group_id: '000660', name: '눌림', memo: 'space memo' },
  { id: 'c', label: '삼성전자', code: '005930', group_id: '005930', name: '종가 반등', memo: 'close rebound' },
];

const savedGroups = [...new Map(rows.map((r) => [r.group_id, { id: r.group_id, name: r.label }])).values()];

describe('useStudyViewTreeState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('derives visible groups from rows and query', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows, savedGroups));

    expect(result.current.visibleGroups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['a', 'c']],
      ['000660', ['b']],
    ]);

    act(() => result.current.setQuery('close rebound'));

    expect(result.current.query).toBe('close rebound');
    expect(result.current.visibleGroups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['c']],
    ]);
  });

  it('persists collapsed Code keys and prunes stale keys', () => {
    localStorage.setItem('studyViews.collapsedGroups.v2', JSON.stringify({ keys: ['005930', '999999'] }));

    const { result } = renderHook(() => useStudyViewTreeState(rows, savedGroups));

    expect(result.current.isCollapsed('005930')).toBe(true);
    expect(result.current.isCollapsed('000660')).toBe(false);
    expect(JSON.parse(localStorage.getItem('studyViews.collapsedGroups.v2') ?? '{}')).toEqual({ keys: ['005930'] });
  });

  it('temporarily expands matching groups during search and restores collapse state', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows, savedGroups));
    act(() => result.current.toggleGroup('000660'));
    act(() => result.current.setQuery('SK'));
    expect(result.current.isCollapsed('000660')).toBe(false);
    act(() => result.current.toggleVisibleGroups());
    act(() => result.current.toggleGroup('000660'));
    act(() => result.current.setQuery(''));
    expect(result.current.isCollapsed('000660')).toBe(true);
    expect(result.current.isCollapsed('005930')).toBe(false);
    act(() => result.current.toggleVisibleGroups());
    expect(result.current.visibleGroupsCollapsed).toBe(true);
    act(() => result.current.toggleVisibleGroups());
    expect(result.current.visibleGroupsCollapsed).toBe(false);
  });

  it('inserts a stable selection before a row, undoes it and rejects cross-Code moves', () => {
    const more = [...rows, { ...rows[0], id: 'd', name: 'D' }, { ...rows[0], id: 'e', name: 'E' }];
    const { result } = renderHook(() => useStudyViewTreeState(more, savedGroups));
    const order = () => result.current.visibleGroups[0].rows.map((r) => r.id);
    act(() => result.current.placeRows('005930', ['e', 'd'], 'c', 'before'));
    expect(order()).toEqual(['a', 'd', 'e', 'c']);
    act(() => result.current.undoReorder());
    expect(order()).toEqual(['a', 'c', 'd', 'e']);
    act(() => result.current.placeRows('005930', ['b'], 'c', 'before'));
    expect(order()).toEqual(['a', 'c', 'd', 'e']);
  });

  it('reports a storage failure and keeps the existing order', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows, savedGroups));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => result.current.placeRows('005930', ['c'], 'a', 'before'));
    expect(result.current.visibleGroups[0].rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(result.current.orderMessage).toContain('저장하지 못했습니다');
    expect(result.current.canUndoOrder).toBe(false);
    write.mockRestore();
  });

  it.each([
    { groupKeys: ['000660', '005930'], rowIdsByGroup: { '005930': ['c', 'a'], '000660': ['b'] } },
    { groupKeys: ['005930', '000660'], rowIdsByGroup: { '005930': ['a', 'c'], '000660': ['b'] } },
  ])('does not overwrite an externally changed order when undoing: %j', (externalOrder) => {
    const { result } = renderHook(() => useStudyViewTreeState(rows, savedGroups));
    act(() => result.current.placeRows('005930', ['c'], 'a', 'before'));
    localStorage.setItem('studyViews.treeManualOrder.v2', JSON.stringify(externalOrder));

    act(() => result.current.undoReorder());

    expect(JSON.parse(localStorage.getItem('studyViews.treeManualOrder.v2')!)).toEqual(externalOrder);
    expect(result.current.orderMessage).toContain('순서가 변경되어 되돌릴 수 없습니다');
    expect(result.current.canUndoOrder).toBe(false);
  });

  it('undoes a row move after reordering groups despite persisted object key order', () => {
    const more = [...rows, { ...rows[1], id: 'd', name: '다음 눌림' }];
    const { result } = renderHook(() => useStudyViewTreeState(more, savedGroups));
    act(() => result.current.placeGroup('000660', '005930', 'before'));
    act(() => result.current.placeRows('000660', ['d'], 'b', 'before'));
    expect(result.current.visibleGroups[0].rows.map((row) => row.id)).toEqual(['d', 'b']);

    act(() => result.current.undoReorder());

    expect(result.current.visibleGroups.map((group) => group.key)).toEqual(['000660', '005930']);
    expect(result.current.visibleGroups[0].rows.map((row) => row.id)).toEqual(['b', 'd']);
    expect(JSON.parse(localStorage.getItem('studyViews.treeManualOrder.v2')!)).toEqual({
      groupKeys: ['000660', '005930'],
      rowIdsByGroup: { '005930': ['a', 'c'], '000660': ['b', 'd'] },
    });
    expect(result.current.orderMessage).toBe('순서를 되돌렸습니다');
    expect(result.current.canUndoOrder).toBe(false);
  });

  it('does not erase persisted order or collapse keys while the first query is loading', () => {
    const manual = { groupKeys: ['000660', '005930'], rowIdsByGroup: { '005930': ['c', 'a'] } };
    localStorage.setItem('studyViews.treeManualOrder.v2', JSON.stringify(manual));
    localStorage.setItem('studyViews.collapsedGroups.v2', JSON.stringify({ keys: ['005930'] }));
    const { result, rerender } = renderHook(({ loaded }) => useStudyViewTreeState(loaded ? rows : [], savedGroups, loaded), { initialProps: { loaded: false } });
    expect(JSON.parse(localStorage.getItem('studyViews.treeManualOrder.v2')!)).toEqual(manual);
    expect(JSON.parse(localStorage.getItem('studyViews.collapsedGroups.v2')!)).toEqual({ keys: ['005930'] });
    rerender({ loaded: true });
    expect(result.current.visibleGroups.map((g) => g.key)).toEqual(['000660', '005930']);
    expect(result.current.isCollapsed('005930')).toBe(true);
  });

  it('cycles and persists the tree sort mode', () => {
    const { result, rerender } = renderHook(() => useStudyViewTreeState(rows, savedGroups));

    expect(result.current.sortAction).toMatchObject({ label: '이름 오름차순 정렬', direction: 'default', pressed: false });

    act(() => result.current.cycleSortMode());

    expect(result.current.sortMode).toBe('name-asc');
    expect(result.current.sortAction).toMatchObject({ label: '이름 내림차순 정렬', direction: 'asc', pressed: true });
    expect(JSON.parse(localStorage.getItem('studyViews.treeSortMode.v2') ?? '{}')).toEqual({ sortMode: 'name-asc' });

    act(() => result.current.cycleSortMode());
    expect(result.current.sortMode).toBe('name-desc');

    act(() => result.current.cycleSortMode());
    expect(result.current.sortMode).toBe('default');

    rerender();
    expect(result.current.sortMode).toBe('default');
  });

  it('reorders groups and rows in default sort mode and persists manual order', () => {
    const { result } = renderHook(() => useStudyViewTreeState(rows, savedGroups));

    act(() => result.current.reorderGroup('000660', '005930'));
    expect(result.current.visibleGroups.map((group) => group.key)).toEqual(['000660', '005930']);

    act(() => result.current.reorderRow('005930', 'c', 'a'));
    expect(result.current.visibleGroups.find((group) => group.key === '005930')?.rows.map((row) => row.id)).toEqual(['c', 'a']);
    expect(JSON.parse(localStorage.getItem('studyViews.treeManualOrder.v2') ?? '{}')).toEqual({
      groupKeys: ['000660', '005930'],
      rowIdsByGroup: { '005930': ['c', 'a'], '000660': ['b'] },
    });
  });
});

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
    act(() => result.current.collapseVisibleGroups());

    expect(result.current.isCollapsed('000660')).toBe(true);
    expect(result.current.isCollapsed('005930')).toBe(false);

    act(() => result.current.setQuery(''));
    act(() => result.current.toggleGroup('005930'));

    expect(result.current.isCollapsed('005930')).toBe(true);

    act(() => result.current.expandVisibleGroups());

    expect(result.current.isCollapsed('005930')).toBe(false);
    expect(result.current.isCollapsed('000660')).toBe(false);
  });
});

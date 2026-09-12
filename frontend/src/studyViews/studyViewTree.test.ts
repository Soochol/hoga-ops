import { describe, expect, it } from 'vitest';
import { filterStudyViewGroups, groupStudyViews } from './studyViewTree';

const rows = [
  { id: 'a', label: '삼성전자', code: '005930', group_id: '005930', name: '급등 이후', memo: 'memo one' },
  { id: 'b', label: 'SK하이닉스', code: '000660', group_id: '000660', name: '눌림', memo: 'space memo' },
  { id: 'c', label: '삼성전자', code: '005930', group_id: '005930', name: '종가 반등', memo: 'close rebound' },
  { id: 'd', label: '삼성전자', code: '123456', group_id: '123456', name: '동명이종목', memo: 'same label' },
];

const savedGroups = [...new Map(rows.map((r) => [r.group_id, { id: r.group_id, name: r.label }])).values()];

describe('studyViewTree', () => {
  it('groups saved views by Code preserving source order', () => {
    const groups = groupStudyViews(rows, savedGroups);

    expect(groups.map((group) => [group.key, group.label, group.rows.map((row) => row.id)])).toEqual([
      ['005930', '삼성전자', ['a', 'c']],
      ['000660', 'SK하이닉스', ['b']],
      ['123456', '삼성전자', ['d']],
    ]);
  });

  it('keeps the same visible stock label in separate groups when Codes differ', () => {
    const samsungGroups = groupStudyViews(rows, savedGroups).filter((group) => group.label === '삼성전자');

    expect(samsungGroups.map((group) => group.key)).toEqual(['005930', '123456']);
  });

  it('sorts groups and child rows by Korean name when requested', () => {
    const groups = groupStudyViews(rows, savedGroups, 'name-asc');

    expect(groups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['a', 'c']],
      ['123456', ['d']],
      ['000660', ['b']],
    ]);
  });

  it('sorts groups and child rows by Korean name descending when requested', () => {
    const groups = groupStudyViews(rows, savedGroups, 'name-desc');

    expect(groups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ['000660', ['b']],
      ['123456', ['d']],
      ['005930', ['c', 'a']],
    ]);
  });

  it('applies manual group and row order in default sort mode', () => {
    const groups = groupStudyViews(rows, savedGroups, 'default', {
      groupKeys: ['000660', '005930'],
      rowIdsByGroup: { '005930': ['c', 'a'] },
    });

    expect(groups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ['000660', ['b']],
      ['005930', ['c', 'a']],
      ['123456', ['d']],
    ]);
  });

  it('stock label search keeps all rows under matching stock groups', () => {
    const groups = filterStudyViewGroups(groupStudyViews(rows, savedGroups), '삼성');

    expect(groups.map((group) => [group.key, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['a', 'c']],
      ['123456', ['d']],
    ]);
  });

  it('Code search keeps all rows under the matching Code group', () => {
    const groups = filterStudyViewGroups(groupStudyViews(rows, savedGroups), '005 930');

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('005930');
    expect(groups[0].rows.map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('saved-view field search keeps only matching rows inside matching groups', () => {
    const groups = filterStudyViewGroups(groupStudyViews(rows, savedGroups), 'close rebound');

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('005930');
    expect(groups[0].rows.map((row) => row.id)).toEqual(['c']);
  });

  it('normalizes whitespace and case while searching name and memo', () => {
    const groups = groupStudyViews(rows, savedGroups);

    expect(filterStudyViewGroups(groups, 'SPACE MEMO')[0].rows.map((row) => row.id)).toEqual(['b']);
    expect(filterStudyViewGroups(groups, '급등이후')[0].rows.map((row) => row.id)).toEqual(['a']);
  });
});

it('retains empty user groups and mixes codes and repeated periods in one group', () => {
  const userGroups = [{ id: 'breakout', name: '돌파 복기' }, { id: 'empty', name: '다음 복기' }];
  const mixed = rows.slice(0, 3).map((row) => ({ ...row, group_id: 'breakout' }));
  const groups = groupStudyViews(mixed, userGroups);
  expect(groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([['breakout', ['a', 'b', 'c']], ['empty', []]]);
  expect(filterStudyViewGroups(groups, '000660')[0].rows.map((r) => r.id)).toEqual(['b']);
  expect(filterStudyViewGroups(groups, '돌파')[0].rows).toHaveLength(3);
});

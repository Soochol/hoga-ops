import { describe, expect, it } from 'vitest';
import { filterStudyViewGroups, groupStudyViewsByCode } from './studyViewTree';

const rows = [
  { id: 'a', label: '삼성전자', code: '005930', name: '급등 이후', memo: 'memo one' },
  { id: 'b', label: 'SK하이닉스', code: '000660', name: '눌림', memo: 'space memo' },
  { id: 'c', label: '삼성전자', code: '005930', name: '종가 반등', memo: 'close rebound' },
  { id: 'd', label: '삼성전자', code: '123456', name: '동명이종목', memo: 'same label' },
];

describe('studyViewTree', () => {
  it('groups saved views by Code preserving source order', () => {
    const groups = groupStudyViewsByCode(rows);

    expect(groups.map((group) => [group.key, group.label, group.rows.map((row) => row.id)])).toEqual([
      ['005930', '삼성전자', ['a', 'c']],
      ['000660', 'SK하이닉스', ['b']],
      ['123456', '삼성전자', ['d']],
    ]);
  });

  it('keeps the same visible stock label in separate groups when Codes differ', () => {
    const samsungGroups = groupStudyViewsByCode(rows).filter((group) => group.label === '삼성전자');

    expect(samsungGroups.map((group) => group.code)).toEqual(['005930', '123456']);
  });

  it('stock label search keeps all rows under matching stock groups', () => {
    const groups = filterStudyViewGroups(groupStudyViewsByCode(rows), '삼성');

    expect(groups.map((group) => [group.code, group.rows.map((row) => row.id)])).toEqual([
      ['005930', ['a', 'c']],
      ['123456', ['d']],
    ]);
  });

  it('Code search keeps all rows under the matching Code group', () => {
    const groups = filterStudyViewGroups(groupStudyViewsByCode(rows), '005 930');

    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe('005930');
    expect(groups[0].rows.map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('saved-view field search keeps only matching rows inside matching groups', () => {
    const groups = filterStudyViewGroups(groupStudyViewsByCode(rows), 'close rebound');

    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe('005930');
    expect(groups[0].rows.map((row) => row.id)).toEqual(['c']);
  });

  it('normalizes whitespace and case while searching name and memo', () => {
    const groups = groupStudyViewsByCode(rows);

    expect(filterStudyViewGroups(groups, 'SPACE MEMO')[0].rows.map((row) => row.id)).toEqual(['b']);
    expect(filterStudyViewGroups(groups, '급등이후')[0].rows.map((row) => row.id)).toEqual(['a']);
  });
});

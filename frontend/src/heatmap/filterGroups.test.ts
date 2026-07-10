import { describe, it, expect } from 'vitest';
import { filterGroups } from './filterGroups';
import type { FolderGroup } from '../watchlist/grouping';
import type { HeatmapEntry } from '../api/heatmap';

function e(code: string, name: string, folderId: string | null): HeatmapEntry {
  return { code, name, folder_id: folderId, order: 0 };
}

function makeGroups(): FolderGroup<HeatmapEntry>[] {
  return [
    {
      folder: { id: 'f1', name: '2차전지', order: 0 },
      entries: [e('000001', '에코프로', 'f1'), e('000002', 'LG엔솔', 'f1')],
    },
    {
      folder: { id: 'f2', name: '반도체', order: 1 },
      entries: [e('005930', '삼성전자', 'f2'), e('000660', 'SK하이닉스', 'f2')],
    },
    { folder: null, entries: [e('035420', '네이버', null)] },
  ];
}

describe('filterGroups', () => {
  it('빈 쿼리(공백 포함)는 원본을 그대로(참조 동일) 반환', () => {
    const groups = makeGroups();
    expect(filterGroups(groups, '')).toBe(groups);
    expect(filterGroups(groups, '   ')).toBe(groups);
  });

  it('그룹명 매칭 시 그 그룹 전체(모든 종목)를 유지', () => {
    const out = filterGroups(makeGroups(), '반도체');
    expect(out).toHaveLength(1);
    expect(out[0].folder?.id).toBe('f2');
    expect(out[0].entries.map((x) => x.code)).toEqual(['005930', '000660']);
  });

  it('종목명 매칭 시 해당 행만, 무매칭 그룹은 숨김', () => {
    const out = filterGroups(makeGroups(), '삼성');
    expect(out).toHaveLength(1);
    expect(out[0].folder?.id).toBe('f2');
    expect(out[0].entries.map((x) => x.name)).toEqual(['삼성전자']);
  });

  it('코드 부분일치도 매칭', () => {
    const out = filterGroups(makeGroups(), '0066');
    expect(out).toHaveLength(1);
    expect(out[0].entries.map((x) => x.code)).toEqual(['000660']);
  });

  it('대소문자 무시', () => {
    const groups: FolderGroup<HeatmapEntry>[] = [
      { folder: { id: 'f1', name: 'Tech', order: 0 }, entries: [e('AAPL', 'Apple', 'f1')] },
    ];
    expect(filterGroups(groups, 'apple')).toHaveLength(1);
    expect(filterGroups(groups, 'TECH')).toHaveLength(1);
  });

  it('미분류 그룹도 이름("미분류")·종목 매칭 대상', () => {
    expect(filterGroups(makeGroups(), '미분류')).toHaveLength(1);
    const byEntry = filterGroups(makeGroups(), '네이버');
    expect(byEntry).toHaveLength(1);
    expect(byEntry[0].folder).toBeNull();
  });

  it('무매칭 쿼리는 빈 배열', () => {
    expect(filterGroups(makeGroups(), 'zzz없는종목')).toEqual([]);
  });
});

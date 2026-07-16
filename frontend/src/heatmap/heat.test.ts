import { describe, it, expect } from 'vitest';
import {
  heatBg, sortEntries, avgPct, heatHeaderBg, groupHeatmapEntries, orderFolderGroups, makePctOf,
  type HeatmapGroup,
} from './heat';
import type { HeatmapEntry } from '../api/heatmap';
import type { LiveQuote } from '../api/liveQuotes';

const E = (code: string, order: number): HeatmapEntry => ({
  code, name: code, folder_id: 'f1', order,
});

describe('makePctOf', () => {
  const q = (pct: number | null): LiveQuote => ({ code: 'x', price: 0, change_pct: pct, change_won: 0 });
  it('Map miss → null, 값 있으면 change_pct, change_pct=null → null', () => {
    const m = new Map<string, LiveQuote>([['a', q(3.5)], ['b', q(null)]]);
    const pctOf = makePctOf(m);
    expect(pctOf('a')).toBe(3.5);
    expect(pctOf('b')).toBeNull();   // present-but-null
    expect(pctOf('zzz')).toBeNull(); // map miss
  });
  it('stale quote change_pct 도 값으로 쓴다 (정렬/집계 순서 안정성)', () => {
    // stale 은 백엔드가 보존한 마지막 정상값 — 정렬키/평균에는 값 없음보다 낫다.
    const m = new Map<string, LiveQuote>([['a', { code: 'a', price: 0, change_pct: 3.5, change_won: 0, stale: true }]]);
    const pctOf = makePctOf(m);
    expect(pctOf('a')).toBe(3.5);
  });
});

describe('heatBg', () => {
  it('null/0 → transparent', () => {
    expect(heatBg(null)).toBe('transparent');
    expect(heatBg(0)).toBe('transparent');
  });
  it('상승=빨강(--price-up) / 하락=파랑(--price-down) 토큰 참조', () => {
    expect(heatBg(4)).toContain('var(--price-up)');
    expect(heatBg(-4)).toContain('var(--price-down)');
  });
  it('±8%에서 max alpha 0.42로 포화 (color-mix %)', () => {
    expect(heatBg(8)).toBe('color-mix(in srgb, var(--price-up) 42.0%, transparent)');
    expect(heatBg(30)).toBe('color-mix(in srgb, var(--price-up) 42.0%, transparent)');
    expect(heatBg(4)).toBe('color-mix(in srgb, var(--price-up) 21.0%, transparent)');
  });
  it('maxAlpha 인자로 임의 농도 적용', () => {
    expect(heatBg(8, 0.72)).toBe('color-mix(in srgb, var(--price-up) 72.0%, transparent)');
    expect(heatBg(-4, 0.72)).toBe('color-mix(in srgb, var(--price-down) 36.0%, transparent)');
  });
});


describe('heatHeaderBg (헤더 밴드 — 선형 램프 max α 0.5, bg-input 합성)', () => {
  it('null/0 → 순수 var(--bg-input)', () => {
    expect(heatHeaderBg(null)).toBe('var(--bg-input)');
    expect(heatHeaderBg(0)).toBe('var(--bg-input)');
  });
  it('+8% 포화 → 빨강 max α 0.5 동색 2-stop 합성', () => {
    const heat = 'color-mix(in srgb, var(--price-up) 50.0%, transparent)';
    expect(heatHeaderBg(8)).toBe(
      `linear-gradient(0deg, ${heat}, ${heat}), var(--bg-input)`,
    );
    expect(heatHeaderBg(30)).toContain('50.0%'); // ±8% 초과 클램프
  });
  it('+4% → α 0.25, -8% → 파랑', () => {
    expect(heatHeaderBg(4)).toContain('var(--price-up) 25.0%');
    expect(heatHeaderBg(-8)).toContain('var(--price-down) 50.0%');
  });
});

describe('sortEntries', () => {
  const entries = [E('a', 0), E('b', 1), E('c', 2)];
  const pctOf = (c: string): number | null =>
    ({ a: 1.0, b: 5.0, c: null } as Record<string, number | null>)[c] ?? null;
  it('manual = order 오름차순', () => {
    expect(sortEntries(entries, 'manual', pctOf).map((e) => e.code)).toEqual(['a', 'b', 'c']);
  });
  it('desc = 등락률 내림차순, null 맨 아래', () => {
    expect(sortEntries(entries, 'desc', pctOf).map((e) => e.code)).toEqual(['b', 'a', 'c']);
  });
  it('asc = 등락률 오름차순, null 맨 아래', () => {
    expect(sortEntries(entries, 'asc', pctOf).map((e) => e.code)).toEqual(['a', 'b', 'c']);
  });
});

describe('avgPct', () => {
  const entries = [E('a', 0), E('b', 1), E('c', 2)];
  it('비가중 평균; 전부 null이면 null', () => {
    const p = (c: string): number | null => ({ a: 2, b: 4, c: null } as Record<string, number | null>)[c] ?? null;
    expect(avgPct(entries, p)).toBe(3);
    expect(avgPct(entries, () => null)).toBeNull();
  });
});

const FG = (id: string): HeatmapGroup => ({
  folder: { id, name: id, order: 0 },
  entries: [],
});
const avgMap = (m: Record<string, number | null>) => (g: HeatmapGroup): number | null =>
  m[g.folder.id] ?? null;
const ids = (gs: HeatmapGroup[]) => gs.map((x) => x.folder.id);

describe('groupHeatmapEntries', () => {
  it('폴더는 order순, 그룹 내 종목도 order순, 빈 폴더 포함', () => {
    const folders = [
      { id: 'f2', name: '반도체', order: 1 },
      { id: 'f1', name: '2차전지', order: 0 },
      { id: 'f3', name: '빈그룹', order: 2 },
    ];
    const entries: HeatmapEntry[] = [
      { code: 'b', name: 'b', folder_id: 'f1', order: 1 },
      { code: 'a', name: 'a', folder_id: 'f1', order: 0 },
      { code: 'c', name: 'c', folder_id: 'f2', order: 0 },
    ];
    const gs = groupHeatmapEntries(folders, entries);
    expect(ids(gs)).toEqual(['f1', 'f2', 'f3']);
    expect(gs[0].entries.map((e) => e.code)).toEqual(['a', 'b']);
    expect(gs[2].entries).toEqual([]);
  });
});

describe('orderFolderGroups', () => {
  it('manual = 입력 순서 그대로(동일 참조)', () => {
    const gs = [FG('a'), FG('b')];
    expect(orderFolderGroups(gs, 'manual', () => 0)).toBe(gs);
  });
  it('desc = 평균 내림차순', () => {
    const gs = [FG('a'), FG('b'), FG('c')];
    expect(ids(orderFolderGroups(gs, 'desc', avgMap({ a: 1, b: 5, c: -2 }))))
      .toEqual(['b', 'a', 'c']);
  });
  it('asc = 평균 오름차순', () => {
    const gs = [FG('a'), FG('b'), FG('c')];
    expect(ids(orderFolderGroups(gs, 'asc', avgMap({ a: 1, b: 5, c: -2 }))))
      .toEqual(['c', 'a', 'b']);
  });
  it('null-avg 폴더는 끝(원순서 안정)', () => {
    const gs = [FG('a'), FG('b'), FG('c')];
    expect(ids(orderFolderGroups(gs, 'desc', avgMap({ a: 3, b: null, c: 1 }))))
      .toEqual(['a', 'c', 'b']);
  });
  it('전부 null-avg → 원순서 보존', () => {
    const gs = [FG('a'), FG('b'), FG('c')];
    expect(ids(orderFolderGroups(gs, 'desc', () => null))).toEqual(['a', 'b', 'c']);
  });
});

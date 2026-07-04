import { describe, it, expect } from 'vitest';
import { heatBg, sortEntries, avgPct, heatHeaderBg, orderFolderGroups, makePctOf } from './heat';
import type { FolderGroup } from '../watchlist/grouping';
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
  it('stale quote change_pct 는 null로 취급한다', () => {
    const m = new Map<string, LiveQuote>([['a', { code: 'a', price: 0, change_pct: 3.5, change_won: 0, stale: true }]]);
    const pctOf = makePctOf(m);
    expect(pctOf('a')).toBeNull();
  });
});

describe('heatBg', () => {
  it('null/0 → transparent', () => {
    expect(heatBg(null)).toBe('transparent');
    expect(heatBg(0)).toBe('transparent');
  });
  it('상승=빨강 / 하락=파랑', () => {
    expect(heatBg(4)).toContain('220,38,38');
    expect(heatBg(-4)).toContain('37,99,235');
  });
  it('±8%에서 max alpha 0.42로 포화', () => {
    expect(heatBg(8)).toBe('rgba(220,38,38,0.420)');
    expect(heatBg(30)).toBe('rgba(220,38,38,0.420)');
    expect(heatBg(4)).toBe('rgba(220,38,38,0.210)');
  });
  it('maxAlpha 인자로 임의 농도 적용', () => {
    expect(heatBg(8, 0.72)).toBe('rgba(220,38,38,0.720)');
    expect(heatBg(-4, 0.72)).toBe('rgba(37,99,235,0.360)');
  });
});


describe('heatHeaderBg (헤더 밴드 — 선형 램프 max α 0.5, bg-input 합성)', () => {
  it('null/0 → 순수 var(--bg-input)', () => {
    expect(heatHeaderBg(null)).toBe('var(--bg-input)');
    expect(heatHeaderBg(0)).toBe('var(--bg-input)');
  });
  it('+8% 포화 → 빨강 max α 0.5 동색 2-stop 합성', () => {
    expect(heatHeaderBg(8)).toBe(
      'linear-gradient(0deg, rgba(220,38,38,0.500), rgba(220,38,38,0.500)), var(--bg-input)',
    );
    expect(heatHeaderBg(30)).toContain('0.500'); // ±8% 초과 클램프
  });
  it('+4% → α 0.25, -8% → 파랑', () => {
    expect(heatHeaderBg(4)).toContain('rgba(220,38,38,0.250)');
    expect(heatHeaderBg(-8)).toContain('rgba(37,99,235,0.500)');
  });
});

describe('sortEntries', () => {
  const entries = [E('a', 0), E('b', 1), E('c', 2)];
  const pctOf = (c: string): number | null =>
    ({ a: 1.0, b: 5.0, c: null } as Record<string, number | null>)[c] ?? null;
  it('manual = order 오름차순', () => {
    expect(sortEntries(entries, 'manual', pctOf).map((e) => e.code)).toEqual(['a', 'b', 'c']);
  });
  it('change = 등락률 내림차순, null 맨 아래', () => {
    expect(sortEntries(entries, 'change', pctOf).map((e) => e.code)).toEqual(['b', 'a', 'c']);
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

const FG = (id: string | null): FolderGroup<HeatmapEntry> => ({
  folder: id === null ? null : { id, name: id, order: 0 },
  entries: [],
});
const avgMap = (m: Record<string, number | null>) => (g: FolderGroup<HeatmapEntry>): number | null =>
  g.folder ? (m[g.folder.id] ?? null) : (m.__uncat__ ?? null);
const ids = (gs: FolderGroup<HeatmapEntry>[]) => gs.map((x) => x.folder?.id ?? '__uncat__');

describe('orderFolderGroups', () => {
  it('manual = 입력 순서 그대로(동일 참조)', () => {
    const gs = [FG('a'), FG('b'), FG(null)];
    expect(orderFolderGroups(gs, 'manual', () => 0)).toBe(gs);
  });
  it('desc = 평균 내림차순, 미분류 항상 맨 끝', () => {
    const gs = [FG('a'), FG('b'), FG('c'), FG(null)];
    expect(ids(orderFolderGroups(gs, 'desc', avgMap({ a: 1, b: 5, c: -2 }))))
      .toEqual(['b', 'a', 'c', '__uncat__']);
  });
  it('asc = 평균 오름차순, 미분류 항상 맨 끝', () => {
    const gs = [FG('a'), FG('b'), FG('c'), FG(null)];
    expect(ids(orderFolderGroups(gs, 'asc', avgMap({ a: 1, b: 5, c: -2 }))))
      .toEqual(['c', 'a', 'b', '__uncat__']);
  });
  it('null-avg 실폴더는 실폴더 구간 끝(원순서 안정), 미분류 더 끝', () => {
    const gs = [FG('a'), FG('b'), FG('c'), FG(null)];
    expect(ids(orderFolderGroups(gs, 'desc', avgMap({ a: 3, b: null, c: 1 }))))
      .toEqual(['a', 'c', 'b', '__uncat__']);
  });
  it('전부 null-avg → 원순서 보존, 미분류 맨 끝', () => {
    const gs = [FG('a'), FG('b'), FG(null), FG('c')];
    expect(ids(orderFolderGroups(gs, 'desc', () => null))).toEqual(['a', 'b', 'c', '__uncat__']);
  });
});

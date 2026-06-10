import { describe, it, expect } from 'vitest';
import { heatBg, sortEntries, avgPct } from './heat';
import type { WatchlistEntry } from '../api/watchlist';

const E = (code: string, order: number): WatchlistEntry => ({
  code, name: code, registered_at_kst_date: '20260101',
  last_success_date: null, folder_id: 'f1', order,
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

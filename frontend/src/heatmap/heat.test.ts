import { describe, it, expect } from 'vitest';
import { heatBg, heatChipBg, sortEntries, avgPct, HEAT_CHIP_MAX_ALPHA, heatHeaderBg } from './heat';
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
  it('maxAlpha 인자로 칩 농도(0.72) 적용', () => {
    expect(heatBg(8, HEAT_CHIP_MAX_ALPHA)).toBe('rgba(220,38,38,0.720)');
    expect(heatBg(-4, HEAT_CHIP_MAX_ALPHA)).toBe('rgba(37,99,235,0.360)');
  });
});

describe('heatChipBg (그라데이션 없음 — |등락률| ≥ 8%만 평면색)', () => {
  it('null/0/±8% 미만 → transparent (배경 없음)', () => {
    expect(heatChipBg(null)).toBe('transparent');
    expect(heatChipBg(0)).toBe('transparent');
    expect(heatChipBg(5)).toBe('transparent');
    expect(heatChipBg(-7.99)).toBe('transparent');
  });
  it('±8% 이상 → 평면 0.72 (그라데이션 없이 단일 농도)', () => {
    expect(heatChipBg(8)).toBe('rgba(220,38,38,0.720)');   // 정확히 8%도 포함(이상)
    expect(heatChipBg(9.9)).toBe('rgba(220,38,38,0.720)');
    expect(heatChipBg(30)).toBe('rgba(220,38,38,0.720)');  // 8%↑ 전부 동일(평면)
    expect(heatChipBg(-8)).toBe('rgba(37,99,235,0.720)');
    expect(heatChipBg(-15)).toBe('rgba(37,99,235,0.720)');
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

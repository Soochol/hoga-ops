import { describe, it, expect } from 'vitest';
import {
  nextRankingSortMode,
  rankingSortDirection,
  sortRankingRows,
  type RankingSortMode,
} from './rankingSort';
import type { RankingRow } from '../api/liveRankings';

const row = (rank: number, code: string, change_pct: number | null): RankingRow => ({
  rank,
  code,
  name: code,
  price: 1000,
  change_pct,
});

// TR 지표순(거래량 등)으로 내려온 리스트 — 등락률은 순위와 무관하게 흩어져 있다.
const ROWS: RankingRow[] = [
  row(1, 'A', 5.0),
  row(2, 'B', 29.9),
  row(3, 'C', -3.2),
  row(4, 'D', 12.4),
];

describe('sortRankingRows', () => {
  it('default keeps TR order (a copy)', () => {
    const out = sortRankingRows(ROWS, 'default');
    expect(out.map((r) => r.code)).toEqual(['A', 'B', 'C', 'D']);
    expect(out).not.toBe(ROWS);
  });

  it('desc sorts by change_pct high→low, rank badge unchanged', () => {
    const out = sortRankingRows(ROWS, { field: 'change_pct', direction: 'desc' });
    expect(out.map((r) => r.code)).toEqual(['B', 'D', 'A', 'C']);
    // 거래량 2위(B)가 등락률 정렬 최상단으로 — 순위번호는 TR 고유값 유지.
    expect(out[0].rank).toBe(2);
  });

  it('asc sorts low→high', () => {
    const out = sortRankingRows(ROWS, { field: 'change_pct', direction: 'asc' });
    expect(out.map((r) => r.code)).toEqual(['C', 'A', 'D', 'B']);
  });

  it('null change_pct always sinks to the bottom, stable among ties', () => {
    const rows = [row(1, 'X', null), row(2, 'Y', 3.0), row(3, 'Z', null)];
    const out = sortRankingRows(rows, { field: 'change_pct', direction: 'desc' });
    expect(out.map((r) => r.code)).toEqual(['Y', 'X', 'Z']); // X,Z null → 원래 순서 유지
  });
});

describe('nextRankingSortMode cycle', () => {
  it('default → desc → asc → default', () => {
    let m: RankingSortMode = 'default';
    m = nextRankingSortMode(m);
    expect(m).toEqual({ field: 'change_pct', direction: 'desc' });
    m = nextRankingSortMode(m);
    expect(m).toEqual({ field: 'change_pct', direction: 'asc' });
    m = nextRankingSortMode(m);
    expect(m).toBe('default');
  });

  it('rankingSortDirection maps mode → icon direction', () => {
    expect(rankingSortDirection('default')).toBe('none');
    expect(rankingSortDirection({ field: 'change_pct', direction: 'desc' })).toBe('desc');
    expect(rankingSortDirection({ field: 'change_pct', direction: 'asc' })).toBe('asc');
  });
});

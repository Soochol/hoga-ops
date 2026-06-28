import { describe, expect, it } from 'vitest';
import { sortScreenerRows, type ScreenerResultSortMode } from './sortResults';

const rows = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 1.2 },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 180000, trade_value_won: 600_000_000_000, change_pct: -0.8 },
  { code: '035420', name: 'NAVER', market: 'KOSDAQ', price: 210000, trade_value_won: 300_000_000_000, change_pct: 3.4 },
  { code: '051910', name: 'LG화학', market: 'KOSPI', price: 420000, trade_value_won: 100_000_000_000, change_pct: null },
];

function codes(mode: ScreenerResultSortMode, input = rows) {
  return sortScreenerRows(input, mode).map((r) => r.code);
}

describe('sortScreenerRows', () => {
  it('keeps scan order in default mode', () => {
    expect(codes('default')).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('sorts by displayed change_pct ascending and keeps missing values last', () => {
    expect(codes({ field: 'change_pct', direction: 'asc' })).toEqual(['000660', '005930', '035420', '051910']);
  });

  it('sorts by displayed change_pct descending and keeps missing values last', () => {
    expect(codes({ field: 'change_pct', direction: 'desc' })).toEqual(['035420', '005930', '000660', '051910']);
  });

  it('sorts by code, name, market, price, and trade value', () => {
    expect(codes({ field: 'code', direction: 'asc' })).toEqual(['000660', '005930', '035420', '051910']);
    expect(codes({ field: 'name', direction: 'asc' })).toEqual(['051910', '035420', '000660', '005930']);
    expect(codes({ field: 'market', direction: 'asc' })).toEqual(['035420', '005930', '000660', '051910']);
    expect(codes({ field: 'price', direction: 'asc' })).toEqual(['005930', '000660', '035420', '051910']);
    expect(codes({ field: 'trade_value_won', direction: 'desc' })).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('preserves scan order for equal change_pct values', () => {
    const tied = rows.map((r) => ({ ...r, change_pct: 1.2 }));
    expect(codes({ field: 'change_pct', direction: 'desc' }, tied)).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('treats undefined and non-finite values as missing and does not mutate input', () => {
    const input = [
      { code: 'A', change_pct: Number.NaN },
      { code: 'B', change_pct: undefined },
      { code: 'C', change_pct: 2 },
    ];
    const before = input.map((r) => ({ ...r }));
    expect(sortScreenerRows(input, { field: 'change_pct', direction: 'desc' }).map((r) => r.code)).toEqual(['C', 'A', 'B']);
    expect(input).toEqual(before);
  });

  it('keeps rows with duplicate codes independent and sorted by their own pct', () => {
    const duplicateCodes = [
      { code: 'A', name: 'first', change_pct: 3.1 },
      { code: 'A', name: 'second', change_pct: 0.4 },
      { code: 'B', name: 'other', change_pct: 2.2 },
    ];
    expect(sortScreenerRows(duplicateCodes, { field: 'change_pct', direction: 'asc' }).map((row) => `${row.code}:${row.name}`))
      .toEqual(['A:second', 'B:other', 'A:first']);
  });

  it('uses change_pct_sort when live and EOD change percentages must not mix', () => {
    const mixedFreshness = [
      { code: 'A', change_pct: 30, change_pct_sort: null },
      { code: 'B', change_pct: -1, change_pct_sort: 1.2 },
      { code: 'C', change_pct: 2, change_pct_sort: 5.4 },
    ];
    expect(sortScreenerRows(mixedFreshness, { field: 'change_pct', direction: 'desc' }).map((row) => row.code))
      .toEqual(['C', 'B', 'A']);
  });
});

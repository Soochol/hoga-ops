import { describe, expect, it } from 'vitest';
import type { WatchlistEntry } from '../api/watchlist';
import type { LiveQuote } from '../api/liveQuotes';
import { makeChangePctOf, sortEntriesByChangePct, type QuoteSortMode } from './quoteSort';

const entries: WatchlistEntry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 1 },
  { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 2 },
  { code: '051910', name: 'LG화학', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 3 },
];

function quotes(items: Array<Pick<LiveQuote, 'code' | 'change_pct'>>): Map<string, LiveQuote> {
  return new Map(items.map((x) => [x.code, {
    code: x.code,
    price: 1000,
    change_pct: x.change_pct,
    change_won: null,
  }]));
}

function codes(mode: QuoteSortMode, q = quotes([
  { code: '005930', change_pct: 1.2 },
  { code: '000660', change_pct: -0.8 },
  { code: '035420', change_pct: 3.4 },
  { code: '051910', change_pct: null },
])) {
  return sortEntriesByChangePct(entries, makeChangePctOf(q), mode).map((e) => e.code);
}

describe('sortEntriesByChangePct', () => {
  it('keeps existing order in default mode', () => {
    expect(codes('default')).toEqual(['005930', '000660', '035420', '051910']);
  });

  it('sorts by change_pct ascending and keeps missing values last', () => {
    expect(codes('change_pct_asc')).toEqual(['000660', '005930', '035420', '051910']);
  });

  it('sorts by change_pct descending and keeps missing values last', () => {
    expect(codes('change_pct_desc')).toEqual(['035420', '005930', '000660', '051910']);
  });

  it('preserves original order for equal change_pct values', () => {
    const tied = quotes([
      { code: '005930', change_pct: 1.2 },
      { code: '000660', change_pct: 1.2 },
      { code: '035420', change_pct: 1.2 },
      { code: '051910', change_pct: 1.2 },
    ]);
    expect(sortEntriesByChangePct(entries, makeChangePctOf(tied), 'change_pct_desc').map((e) => e.code))
      .toEqual(['005930', '000660', '035420', '051910']);
  });
});

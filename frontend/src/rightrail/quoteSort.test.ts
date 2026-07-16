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

function quotes(items: Array<Pick<LiveQuote, 'code' | 'change_pct' | 'stale'>>): Map<string, LiveQuote> {
  return new Map(items.map((x) => [x.code, {
    code: x.code,
    price: 1000,
    change_pct: x.change_pct,
    change_won: null,
    stale: x.stale,
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

  it('ranks stale change_pct like a normal value (마지막 정상값 유지, 정렬 리셋 방지)', () => {
    const mixed = quotes([
      { code: '005930', change_pct: 9.9, stale: true },
      { code: '000660', change_pct: -0.8 },
      { code: '035420', change_pct: 3.4 },
      { code: '051910', change_pct: null },
    ]);
    // 005930 은 stale 이지만 9.9 로 정렬에 참여 → 맨 위. null(051910)만 맨 아래.
    expect(sortEntriesByChangePct(entries, makeChangePctOf(mixed), 'change_pct_desc').map((e) => e.code))
      .toEqual(['005930', '035420', '000660', '051910']);
  });

  it('전 종목 stale 배치에서도 등락률 순서가 유지된다 (주기적 리셋 회귀 가드)', () => {
    // 235종목 폴링에서 kis_capacity_timeout 배치가 오면 전 종목 stale — 이때 정렬키를
    // 값 없음으로 접으면 order 폴백으로 리셋된다. stale 값을 그대로 써 순서를 보존한다.
    const allStale = quotes([
      { code: '005930', change_pct: 1.2, stale: true },
      { code: '000660', change_pct: -0.8, stale: true },
      { code: '035420', change_pct: 3.4, stale: true },
      { code: '051910', change_pct: 0.5, stale: true },
    ]);
    expect(sortEntriesByChangePct(entries, makeChangePctOf(allStale), 'change_pct_desc').map((e) => e.code))
      .toEqual(['035420', '005930', '051910', '000660']);
  });
});

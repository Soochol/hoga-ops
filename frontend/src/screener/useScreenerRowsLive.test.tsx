import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useScreenerRowsLive } from './useScreenerRowsLive';
import * as liveQuotes from '../api/liveQuotes';
import type { ScreenerRow } from '../api/screener';

const ROWS: ScreenerRow[] = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', price: 70000, trade_value_won: 1e11, change_pct: 2.1 },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 180000, trade_value_won: 2e11, change_pct: -1.2 },
];

describe('useScreenerRowsLive', () => {
  it('덮어쓴다: 라이브 quote 가 있으면 현재가·등락률·등락액을 라이브로', () => {
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map([
      ['005930', { code: '005930', price: 80000, change_pct: 7.7, change_won: 5000 }],
    ]));
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    expect(result.current[0]).toMatchObject({
      code: '005930', price: 80000, change_pct: 7.7, change_won: 5000, change_pct_sort: 7.7,
    });
  });

  it('유지한다: 라이브 quote 가 없으면 EOD 현재가·등락률, change_won 은 null', () => {
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map([
      ['005930', { code: '005930', price: 80000, change_pct: 7.7, change_won: 5000 }],
    ]));
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    // 000660 has no quote → EOD price/pct preserved, change_won null (라이브 전용 필드)
    expect(result.current[1]).toMatchObject({
      code: '000660', price: 180000, change_pct: -1.2, change_won: null, change_pct_sort: null,
    });
  });

  it('빈 행이면 빈 배열을 돌려준다 (codes 비어 폴링 비활성)', () => {
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map());
    const { result } = renderHook(() => useScreenerRowsLive([]));
    expect(result.current).toEqual([]);
  });

  it('라이브 quote 가 change_pct=null(장전/파싱실패)이면 EOD 로 폴백하지 않고 null 유지', () => {
    // 백엔드: 장전엔 모든 코드 change_pct=null + price 유효(api.py), 장중 파싱실패도 동일.
    // quote 가 왔으므로(미폴링 아님) EOD 등락률로 폴백하면 안 된다 — null 유지 → '—'(관심종목 동일).
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map([
      ['005930', { code: '005930', price: 72000, change_pct: null, change_won: null }],
    ]));
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    expect(result.current[0]).toMatchObject({
      code: '005930', price: 72000, change_pct: null, change_won: null, change_pct_sort: null,
    });
  });

  it('uses EOD as the sort value only before any live batch is available', () => {
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map());
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    expect(result.current.map((row) => row.change_pct_sort)).toEqual([2.1, -1.2]);
  });
});

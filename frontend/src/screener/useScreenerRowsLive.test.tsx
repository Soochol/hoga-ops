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
      code: '005930', price: 80000, change_pct: 7.7, change_won: 5000,
    });
  });

  it('비운다: 라이브 quote 가 없으면 현재가·등락률을 전부 null(순수 라이브, EOD 폴백 없음)', () => {
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map([
      ['005930', { code: '005930', price: 80000, change_pct: 7.7, change_won: 5000 }],
    ]));
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    // 000660 has no quote → 표시 필드 전부 null → '—'(관심종목과 동일 기준)
    expect(result.current[1]).toMatchObject({
      code: '000660', price: null, change_pct: null, change_won: null,
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
      code: '005930', price: 72000, change_pct: null, change_won: null,
    });
  });

  it('stale live quote 는 change_pct 에 마지막 라이브값을 유지한다 (정렬 리셋 방지)', () => {
    // stale 도 "받아온 값"이므로 change_pct 에 그대로 쓴다(표시·정렬 공용). 정렬(sortResults)
    // 이 change_pct 를 직접 읽으므로, stale 을 빼면 등락률 정렬이 스캔 원순서로 주기적 리셋된다
    // (makeChangePctOf 와 동일 규약). EOD(70000/2.1)로 되돌리지도 않는다.
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map([
      ['005930', {
        code: '005930',
        price: 72000,
        change_pct: 9.9,
        change_won: 6300,
        stale: true,
        stale_reason: 'kis_capacity_timeout',
      }],
    ]));
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    expect(result.current[0]).toMatchObject({
      code: '005930',
      price: 72000,
      change_pct: 9.9,
      change_won: 6300,
    });
  });

  it('라이브 batch 도착 전엔 change_pct 도 null(EOD 초기 정렬 없음)', () => {
    vi.spyOn(liveQuotes, 'useQuoteByCode').mockReturnValue(new Map());
    const { result } = renderHook(() => useScreenerRowsLive(ROWS));
    expect(result.current.map((row) => row.change_pct)).toEqual([null, null]);
  });
});

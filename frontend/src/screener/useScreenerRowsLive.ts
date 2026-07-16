import { useMemo } from 'react';
import type { ScreenerRow } from '../api/screener';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLiveVenueStore } from '../state/liveVenue';

/**
 * 스크리너 결과 행에 Live Quote 를 덮은 행. 표시 필드(price·change_pct·change_won)는
 * 라이브 전용이라 미도착 시 null('—') — EOD 폴백 없음. price 를 number|null 로 완화한다
 * (스캔 응답 ScreenerRow.price 자체는 number 로 유지, 표시만 라이브 기준).
 */
export interface ScreenerRowLive extends Omit<ScreenerRow, 'price'> {
  price: number | null;
  change_won: number | null;
}

/**
 * 스크리너 결과 행의 현재가·등락률을 Live Quote 로만 표시한다. 결과 코드 전체를 10초
 * 폴링하고, 라이브가 도착하면 그 값을(장전·파싱실패의 change_pct=null 포함) 쓰며, 미도착
 * 이면 표시 필드를 전부 null 로 두어 '—' 로 표시한다 — 관심종목(Watchlist)과 동일한 순수
 * 라이브 기준. EOD 코퍼스 값은 스캔 필터·정렬 초기값·localStorage 영속에만 남고 표시에는
 * 쓰지 않는다(ADR-0056, 2026-07-09 개정). 드로어/풀페이지 두 표시 컴포넌트가 공유하는 단일
 * 머지 seam — codes 추출·폴링·머지를 캡슐화하고, 호출처는 레이아웃만 책임진다.
 *
 * stale quote 는 change_pct 에 그대로 쓴다(표시·정렬 공용). 정렬(sortResults)이 change_pct
 * 를 직접 읽으므로, stale 을 빼면 등락률 정렬이 주기적으로 리셋된다 — stale 을 정렬키로
 * 유지하는 근거는 makeChangePctOf(quoteSort.ts) 주석 참조(단일 소유).
 */
export function useScreenerRowsLive(rows: ScreenerRow[]): ScreenerRowLive[] {
  const codes = useMemo(() => rows.map((r) => r.code), [rows]);
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(codes, venue);
  return useMemo(
    () =>
      rows.map((r) => {
        const q = quoteByCode.get(r.code);
        return {
          ...r,
          price: q?.price ?? null,
          change_pct: q?.change_pct ?? null,
          change_won: q?.change_won ?? null,
        };
      }),
    [rows, quoteByCode],
  );
}

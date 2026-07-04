import { useMemo } from 'react';
import type { ScreenerRow } from '../api/screener';
import { isStaleLiveQuote, useQuoteByCode } from '../api/liveQuotes';
import { useLiveVenueStore } from '../state/liveVenue';

/** 스크리너 결과 행에 Live Quote 를 덮은 행. change_won 은 라이브 전용(EOD 없음). */
export interface ScreenerRowLive extends ScreenerRow {
  change_won: number | null;
  change_pct_sort: number | null;
}

/**
 * 스크리너 결과 행(EOD 코퍼스)에 Live Quote 오버레이를 적용한다(ADR-0056). 결과 코드
 * 전체를 10초 폴링하고, 라이브가 있으면 현재가·등락률을 덮고 없으면 EOD 값을 유지한다
 * (change_won 은 intstock-multprice 에만 있어 폴백 없음). 드로어/풀페이지 두 표시
 * 컴포넌트가 공유하는 단일 머지 seam — codes 추출·폴링·머지를 캡슐화하고, 호출처는
 * 레이아웃만 책임진다. Watchlist(라이브 전용)·Live Status Bar(dual-source)는 머지
 * 의미가 달라 이 훅을 쓰지 않는다.
 */
export function useScreenerRowsLive(rows: ScreenerRow[]): ScreenerRowLive[] {
  const codes = useMemo(() => rows.map((r) => r.code), [rows]);
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(codes, venue);
  const hasFreshLiveBatch = useMemo(
    () => [...quoteByCode.values()].some((quote) => !isStaleLiveQuote(quote)),
    [quoteByCode],
  );
  return useMemo(
    () =>
      rows.map((r) => {
        const q = quoteByCode.get(r.code);
        if (isStaleLiveQuote(q)) {
          return { ...r, change_won: null, change_pct_sort: r.change_pct };
        }
        // quote 존재 여부로 분기(값의 null 여부가 아니라). 라이브가 도착하면 현재가·
        // 등락률·등락액을 그대로 쓴다 — 장전·파싱실패로 change_pct=null 이면 그 null 을
        // 유지해 '—' 로 표시(관심종목과 동일 기준). quote 미도착 행만 EOD 로 폴백한다.
        // `?? r.change_pct` 로 두면 장전에 EOD 등락률이 떠 관심종목과 어긋난다.
        // 정렬은 별도 값을 쓴다. live batch 가 일부 도착한 뒤 누락된 코드는 EOD 등락률과
        // live 등락률이 섞이지 않게 missing 취급하고, 아직 batch 자체가 없을 때만 EOD 로
        // 초기 정렬을 허용한다.
        return q
          ? { ...r, price: q.price, change_pct: q.change_pct, change_won: q.change_won, change_pct_sort: q.change_pct }
          : { ...r, change_won: null, change_pct_sort: hasFreshLiveBatch ? null : r.change_pct };
      }),
    [hasFreshLiveBatch, rows, quoteByCode],
  );
}

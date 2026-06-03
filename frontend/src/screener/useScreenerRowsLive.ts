import { useMemo } from 'react';
import type { ScreenerRow } from '../api/screener';
import { useQuoteByCode } from '../api/liveQuotes';

/** 스크리너 결과 행에 Live Quote 를 덮은 행. change_won 은 라이브 전용(EOD 없음). */
export interface ScreenerRowLive extends ScreenerRow {
  change_won: number | null;
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
  const quoteByCode = useQuoteByCode(codes);
  return useMemo(
    () =>
      rows.map((r) => {
        const q = quoteByCode.get(r.code);
        return {
          ...r,
          price: q?.price ?? r.price,
          change_pct: q?.change_pct ?? r.change_pct,
          change_won: q?.change_won ?? null,
        };
      }),
    [rows, quoteByCode],
  );
}

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';

export interface LiveQuote {
  code: string;
  price: number;
  change_pct: number | null;
  /** 전일대비 등락액(원). 장전(pre_open)·무데이터 시 null. */
  change_won: number | null;
}

export interface LiveQuotesResponse {
  phase: 'pre_open' | 'open';
  quotes: LiveQuote[];
}

export function getQuotes(codes: string[]): Promise<LiveQuotesResponse> {
  return apiCall<LiveQuotesResponse>(`/api/live/quotes?codes=${codes.join(',')}`);
}

/** 코드 목록의 현재가+등락률을 10초 폴링. codes 비면 비활성. */
export function useQuotes(codes: string[]) {
  return useQuery({
    queryKey: ['live-quotes', codes.join(',')],
    queryFn: () => getQuotes(codes),
    enabled: codes.length > 0,
    staleTime: 10_000,
    refetchInterval: 10_000,
    // codes 집합이 바뀌면 새 queryKey라 data가 잠시 undefined → 전 셀이 '—'로
    // 깜빡인다. 직전 결과를 유지해 겹치는 코드는 그대로 두고 새 코드만 채워지게
    // 한다(형제 훅 range.ts·livePastCandles.ts 와 동일 패턴).
    placeholderData: (prev) => prev,
  });
}

/** codes 의 Live Quote 를 코드→quote 조회 Map 으로 묶는다. useQuotes + Map 빌드
 *  + null-가드(quotes 미도착 시 빈 Map)를 한 곳에 캡슐화 — 관심종목/스크리너
 *  패널이 복제하던 패턴의 단일 출처. 없는 코드는 .get → undefined. */
export function useQuoteByCode(codes: string[]) {
  const { data } = useQuotes(codes);
  return useMemo(
    () => new Map((data?.quotes ?? []).map((q) => [q.code, q])),
    [data],
  );
}

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
  phase: 'pre_open' | 'open' | 'closed';
  quotes: LiveQuote[];
}

/** closed(평일 08:50–16:00 밖·주말)면 600s 하트비트 — `false`로 완전히 끄면
 *  React Query가 재평가할 계기가 없어 다음 개장에 폴링이 재개되지 않는다.
 *  600s는 08:50 후 최대 10분 내 자동 복귀하면서 일일 폴링 ~69% 절감
 *  (스펙 2026-06-08 ⑧ — 백엔드는 closed에 마지막 시세를 서빙하므로 셀 공백 없음). */
export function quotesRefetchInterval(phase: string | undefined): number {
  return phase === 'closed' ? 600_000 : 10_000;
}

export function getQuotes(codes: string[]): Promise<LiveQuotesResponse> {
  return apiCall<LiveQuotesResponse>(`/api/live/quotes?codes=${codes.join(',')}`);
}

/** 코드 목록의 현재가+등락률을 10초 폴링. codes 비면 비활성. */
export function useQuotes(codes: string[]) {
  // 순서 무관 캐시 키: 관심종목 재정렬(같은 집합·다른 순서)이 queryKey 를 바꿔
  // 전 종목 시세를 불필요하게 재요청하지 않도록 정렬한 키를 쓴다. 백엔드 응답은
  // 코드 집합에만 의존하므로 요청 자체는 원래 순서 그대로 보낸다.
  const key = [...codes].sort().join(',');
  return useQuery({
    queryKey: ['live-quotes', key],
    queryFn: () => getQuotes(codes),
    enabled: codes.length > 0,
    staleTime: 10_000,
    refetchInterval: (q) => quotesRefetchInterval(q.state.data?.phase),
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

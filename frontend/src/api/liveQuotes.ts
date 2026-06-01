import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';

export interface LiveQuote {
  code: string;
  price: number;
  change_pct: number | null;
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
  });
}

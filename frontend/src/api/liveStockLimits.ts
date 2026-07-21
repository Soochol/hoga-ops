import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';

/** GET /api/live/stock-limits — 키움 ka10001 부분집합. 상하한가·기준가는 당일
 * 고정값이고 백엔드가 KST 날짜 단위로 캐시하므로 staleTime 을 길게 잡는다.
 * 미제공 필드(신규상장 등)는 null — 소비자(BookPanel)가 대시로 렌더한다. */
export interface LiveStockLimitsResponse {
  code: string;
  base_price: number | null;
  upper_limit: number | null;
  lower_limit: number | null;
  high_250: number | null;
  low_250: number | null;
  high_250_date: string | null;
  low_250_date: string | null;
  fetched_at_ms: number;
  source: 'kiwoom';
}

export function useLiveStockLimits(code: string | null) {
  return useQuery({
    queryKey: ['live', 'stock-limits', code] as const,
    queryFn: ({ signal }) =>
      apiCall<LiveStockLimitsResponse>(`/api/live/stock-limits?code=${code}`, { signal }),
    enabled: !!code,
    // 당일 고정값 — 탭 전환·리마운트마다 재요청할 이유가 없다. 자정 넘김은
    // 드문 케이스라 1h 로 두고 백엔드 날짜 캐시가 최종 방어선이 된다.
    staleTime: 60 * 60_000,
    gcTime: 60 * 60_000,
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}

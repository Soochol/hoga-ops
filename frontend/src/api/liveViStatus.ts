import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import { isKrxRegularSessionNow } from '../live/liveDateTime';

/** 키움 1h VI 이벤트의 종목별 최신 상태 — 백엔드 kiwoom_vi_state.parse_vi_row shape.
 * legend 는 실측 확정(docs/research/2026-07-21-kiwoom-vi-price-sources.md). */
export interface LiveViEvent {
  code: string;
  direction: 'up' | 'down';
  kind: 'static' | 'dynamic' | 'both';
  trigger_price: number | null;
  static_base: number | null;
  dynamic_base: number | null;
  triggered_at: string | null; // HHMMSS
  released_at: string | null; // HHMMSS, null=발동 중
  count: number | null;
  active: boolean;
  recv_ms: number;
}

export interface LiveViStatusResponse {
  code: string;
  vi: LiveViEvent | null;
}

/** GET /api/live/vi-status — VI 는 발동 후 2분 지속이라 10s 폴링이면 강조 표시에
 * 충분하다(실시간 push 승격은 SSE 버퍼에 kind 를 추가하는 별도 작업). 정규장
 * 밖에선 새 발동이 없으므로 폴링 중단. */
export function useLiveViStatus(code: string | null) {
  return useQuery({
    queryKey: ['live', 'vi-status', code] as const,
    queryFn: ({ signal }) =>
      apiCall<LiveViStatusResponse>(`/api/live/vi-status?code=${code}`, { signal }),
    enabled: !!code,
    staleTime: 5_000,
    refetchInterval: () => (isKrxRegularSessionNow() ? 10_000 : false),
    placeholderData: (prev) => (prev && prev.code === code ? prev : undefined),
  });
}

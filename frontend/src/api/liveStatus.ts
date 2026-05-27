import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LiveStatus {
  running: boolean;
  started_at_ms: number | null;
  last_tick_ms: number | null;
  cycle_lag_ms: number;
  watchlist_count: number;
  kis_calls_today: number;
  kis_rate_limit_remaining: number | null;
}

/**
 * Polls `/api/live/status` every 5 seconds.
 *
 * The endpoint is cheap (in-memory state read) so 5s is generous; matches the
 * spec §10 LiveStatusBar cadence. The status drives banner gating
 * (`useLiveBannerState`) and the cycle-lag pill.
 */
export function useLiveStatus() {
  return useQuery({
    queryKey: ['live', 'status'],
    queryFn: () => apiCall<LiveStatus>('/api/live/status'),
    refetchInterval: 5_000,
    staleTime: 1_000,
  });
}

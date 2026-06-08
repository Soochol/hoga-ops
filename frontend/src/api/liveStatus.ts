import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export interface LiveStatus {
  running: boolean;
  started_at_ms: number | null;
  last_tick_ms: number | null;
  cycle_lag_ms: number;
  /** 캡처 헬스(spec 2026-06-08 §2.2). cycle_lag_ms(0 고정)를 대체하는 신호. */
  capture_healthy: boolean;
  capture_reason: string;
  /**
   * Codes the live poller is *actively iterating* — a poller-health metric,
   * NOT the watchlist inventory size. It is 0 whenever the poller isn't
   * running (missing KIS creds, off-hours, never started). For "how many
   * symbols are on the watchlist", read GET /api/watchlist (`useWatchlist`).
   * Keying UI empty-states off this field conflates the two (diagnose 2026-05-30).
   */
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

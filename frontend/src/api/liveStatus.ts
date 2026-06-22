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
  /** Codes the backend is *actively collecting* in the current cycle. Used for collection-status badge visibility. */
  live_set: string[];
  storage_policy: 'ws_only' | 'ws_plus_rest' | 'rest_only';
  kis_api_running: boolean;
  kis_api_targets: string[];
  kis_api_target_count: number;
  kis_api_last_cycle_ms: number | null;
  kis_api_last_error: string | null;
  kis_api_last_error_count: number;
  kis_api_degraded: boolean;
}

/**
 * Polls `/api/live/status` every 5 seconds.
 *
 * The endpoint is cheap (in-memory state read) so 5s is generous; matches the
 * spec §10 LiveStatusBar cadence. Keep this as the wire-shaped fetch hook;
 * frontend UI meaning is projected in `liveStatusProjection`.
 */
export function useLiveStatus() {
  return useQuery({
    queryKey: ['live', 'status'],
    queryFn: () => apiCall<LiveStatus>('/api/live/status'),
    refetchInterval: 5_000,
    staleTime: 1_000,
  });
}

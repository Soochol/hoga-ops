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
  kis_rest_bypass_enabled: boolean;
  // 키움 WS 수집 관측(ADR-0116). 키움 미배선/무자격(앱키 없음)이면 null. 백엔드 신규
  // 필드라 optional — 설정 상태줄·커버리지 칩이 소비한다.
  kiwoom?: KiwoomStatus | null;
}

export interface KiwoomStatus {
  enabled: boolean;
  accounts_configured: number;
  connected_accounts: number;
  subscribed_count: number;
  // 키움 WS 수집 중인 종목 코드(화질 도트용). deriveCollectionStatus가 멤버십으로
  // realtime(●) 판정. 백엔드 신규 필드라 optional — 구 응답엔 없을 수 있음.
  subscribed_codes?: string[];
  last_tick_ms: number | null;
  accounts: KiwoomAccountStatus[];
}

export interface KiwoomAccountStatus {
  account_id: number;
  connected: boolean;
  sub_expected: number;
  sub_acked: number;
  kicked_by_peer: boolean;
  last_tick_ms: number | null;
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

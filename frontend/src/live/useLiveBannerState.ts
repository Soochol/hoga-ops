import type { LiveStatus } from '../api/liveStatus';
import { useWatchlist } from '../watchlist/useWatchlist';
import { projectLiveStatus, type LiveBannerCause, type LiveBannerPrimary } from './liveStatusProjection';

export type BannerCause = LiveBannerCause;

export interface LiveStatusInput {
  running: boolean;
  cycle_lag_ms: number;
  started_at_ms?: number | null;
  capture_reason?: string;
}

export interface BannerInput {
  status: LiveStatusInput | null;
  /**
   * Authoritative watchlist inventory size from GET /api/watchlist
   * (`useWatchlist`). This is deliberately NOT `status.watchlist_count`:
   * that field counts the codes the live poller is *actively iterating*,
   * which is 0 whenever the poller isn't running (missing KIS creds,
   * off-hours, never started). Conflating the two made /live announce
   * "관심종목이 비어 있습니다" while the watchlist page listed 9 entries —
   * and worse, it masked the real `kis_credentials_missing` cause, since
   * the empty-watchlist branch is checked first (diagnose 2026-05-30).
   *
   * `null` means the watchlist query hasn't resolved yet. We defer the
   * priority-1 banners until the real size is known so first paint can't
   * flash a false "empty" state.
   */
  watchlistSize: number | null;
  tokenExpired?: boolean;
}

export interface BannerState {
  primary: LiveBannerPrimary;
  stack: BannerCause[]; // priority-2 stackable causes, ordered
}

/** Pure derivation of banner state from inputs — testable without React. */
export function deriveBannerState({ status, watchlistSize, tokenExpired = false }: BannerInput): BannerState {
  return projectLiveStatus({
    status: status && {
      ...status,
      started_at_ms: status.started_at_ms ?? null,
      capture_healthy: status.running,
      capture_reason: status.capture_reason ?? 'unknown',
      watchlist_count: 0,
    },
    inventory: { kind: 'watchlist', size: watchlistSize },
    tokenExpired,
  }).banner;
}

/** React hook wrapper deriving banner state from live status + watchlist. */
export function useLiveBannerState(status: LiveStatus | undefined | null, opts?: { tokenExpired?: boolean }): BannerState {
  // Authoritative watchlist inventory. react-query dedupes the ['watchlist']
  // key, so this shares the cache with any other mounted subscriber; on /live
  // it costs one cheap load (9-row disk read) plus the 60s poll. `undefined`
  // while loading → null = "size unknown" (defer priority-1 banners). A failed
  // fetch also stays null, so we show no banner rather than a wrong one.
  const { data: watchlist } = useWatchlist();
  const watchlistSize = watchlist === undefined ? null : watchlist.entries.length;

  if (!status) return { primary: null, stack: [] };
  return deriveBannerState({
    status: {
      running: status.running,
      cycle_lag_ms: status.cycle_lag_ms,
      started_at_ms: status.started_at_ms,
      capture_reason: status.capture_reason,
    },
    watchlistSize,
    tokenExpired: opts?.tokenExpired,
  });
}

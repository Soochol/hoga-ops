import type { LiveStatus } from '../api/liveStatus';
import { useWatchlist } from '../watchlist/useWatchlist';

export type BannerCause =
  | 'watchlist_empty'           // priority 1, workarea emptystate
  | 'kis_credentials_missing'   // priority 1, red header banner
  | 'kis_token_expired';        // priority 2, amber header banner

export interface LiveStatusInput {
  running: boolean;
  cycle_lag_ms: number;
  started_at_ms?: number | null;
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
  primary: 'watchlist_empty' | 'kis_credentials_missing' | null;
  stack: BannerCause[]; // priority-2 stackable causes, ordered
}

/** Pure derivation of banner state from inputs — testable without React. */
export function deriveBannerState({ status, watchlistSize, tokenExpired = false }: BannerInput): BannerState {
  if (status === null) return { primary: null, stack: [] };

  // Priority 1 (mutually exclusive). These hinge on the authoritative
  // inventory size, so hold them back until the watchlist query resolves
  // (`watchlistSize === null`) — otherwise first paint flashes a false
  // "empty" before /api/watchlist answers.
  if (watchlistSize !== null) {
    // Matrix ordering: watchlist_empty before kis_credentials_missing.
    if (watchlistSize === 0) {
      return { primary: 'watchlist_empty', stack: [] };
    }
    // Watchlist has entries but the poller never started — almost always
    // missing KIS creds (start_live_poller returns early before setting
    // started_at_ms). This branch was unreachable while the empty check
    // keyed off the always-zero poller count.
    if (!status.running && status.started_at_ms == null) {
      return { primary: 'kis_credentials_missing', stack: [] };
    }
  }

  // Priority 2 (stackable).
  const stack: BannerCause[] = [];
  if (tokenExpired) stack.push('kis_token_expired');

  return { primary: null, stack };
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
    },
    watchlistSize,
    tokenExpired: opts?.tokenExpired,
  });
}

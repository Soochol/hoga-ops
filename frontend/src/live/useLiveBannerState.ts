import { useEffect, useState } from 'react';
import type { LiveStatus } from '../api/liveStatus';

export type BannerCause =
  | 'watchlist_empty'           // priority 1, workarea emptystate
  | 'kis_credentials_missing'   // priority 1, red header banner
  | 'kis_token_expired'         // priority 2, amber header banner
  | 'off_hours';                // priority 3, neutral header banner

export interface LiveStatusInput {
  running: boolean;
  watchlist_count: number;
  cycle_lag_ms: number;
  started_at_ms?: number | null;
}

export interface BannerInput {
  now: Date;
  status: LiveStatusInput | null;
  tokenExpired?: boolean;
}

export interface BannerState {
  primary: 'watchlist_empty' | 'kis_credentials_missing' | null;
  stack: BannerCause[]; // priorities 2-5, ordered
}

/** Pure derivation of banner state from inputs — testable without React. */
export function deriveBannerState({ now, status, tokenExpired = false }: BannerInput): BannerState {
  if (status === null) return { primary: null, stack: [] };

  // Priority 1 (mutually exclusive).
  // Matrix ordering: watchlist_empty before kis_credentials_missing.
  if (status.watchlist_count === 0) {
    return { primary: 'watchlist_empty', stack: [] };
  }
  if (!status.running && status.started_at_ms == null) {
    return { primary: 'kis_credentials_missing', stack: [] };
  }

  // Priority 2-5 (stackable).
  const stack: BannerCause[] = [];
  if (tokenExpired) stack.push('kis_token_expired');

  // Off-hours: outside 09:00:00–16:00:00 KST.
  const kstHour = computeKstHour(now);
  if (kstHour < 9 || kstHour >= 16) {
    stack.push('off_hours');
  }

  return { primary: null, stack };
}

/**
 * Compute the KST hour from a Date instance.
 *
 * KST = UTC+9. We shift the epoch by 9h and read the UTC hours of the
 * shifted value, so the result is independent of the system timezone.
 * (The plan's formula `d.getTime() + d.getTimezoneOffset()*60_000` is
 * wrong on non-UTC systems — it double-applies the local offset.)
 */
function computeKstHour(d: Date): number {
  return new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
}

/** React hook wrapper that re-derives every minute as the wall clock advances. */
export function useLiveBannerState(status: LiveStatus | undefined | null, opts?: { tokenExpired?: boolean }): BannerState {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!status) return { primary: null, stack: [] };
  return deriveBannerState({
    now,
    status: {
      running: status.running,
      watchlist_count: status.watchlist_count,
      cycle_lag_ms: status.cycle_lag_ms,
      started_at_ms: status.started_at_ms,
    },
    tokenExpired: opts?.tokenExpired,
  });
}

import { describe, it, expect } from 'vitest';
import { deriveBannerState, type LiveStatusInput, type BannerInput } from './useLiveBannerState';

const baseStatus: LiveStatusInput = {
  running: true,
  cycle_lag_ms: 0,
};

// watchlistSize 1 keeps priority-1 banners quiet for the off-hours cases.
const offHours: BannerInput = { now: new Date('2026-05-27T03:00:00+09:00'), status: baseStatus, watchlistSize: 1 };
const regular: BannerInput = { now: new Date('2026-05-27T10:30:00+09:00'), status: baseStatus, watchlistSize: 1 };

describe('deriveBannerState', () => {
  it('shows watchlist_empty when the watchlist inventory is empty', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: baseStatus,
      watchlistSize: 0,
    });
    expect(r.primary).toBe('watchlist_empty');
  });

  it('shows kis_credentials_missing when running false + watchlist > 0 + no started_at', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: 2,
    });
    expect(r.primary).toBe('kis_credentials_missing');
  });

  // Regression (diagnose 2026-05-30): /live keyed its empty-state off
  // status.watchlist_count (poller-tracked, always 0 when the poller is down),
  // so a populated watchlist + stopped poller wrongly rendered
  // "관심종목이 비어 있습니다" AND masked the real kis_credentials_missing cause.
  // The empty decision must come from the authoritative inventory size.
  it('does NOT show watchlist_empty when the watchlist has entries but the poller is down', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: 9, // inventory is non-empty; poller-tracked count would be 0
    });
    expect(r.primary).not.toBe('watchlist_empty');
    expect(r.primary).toBe('kis_credentials_missing');
  });

  it('defers priority-1 banners while the watchlist size is still loading', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: null,
    });
    expect(r.primary).toBeNull();
  });

  it('shows off_hours when outside 09:00-16:00 KST and no priority-1 cause', () => {
    const r = deriveBannerState(offHours);
    expect(r.primary).toBeNull();
    expect(r.stack).toContain('off_hours');
  });

  it('does NOT show off_hours during regular session', () => {
    const r = deriveBannerState(regular);
    expect(r.stack).not.toContain('off_hours');
  });

  it('priority-1 causes are mutually exclusive', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: 0,
    });
    // watchlist_empty wins over kis_credentials_missing per matrix ordering
    expect(r.primary).toBe('watchlist_empty');
  });

  it('null status (loading) yields no banners', () => {
    const r = deriveBannerState({ now: regular.now, status: null, watchlistSize: 1 });
    expect(r.primary).toBeNull();
    expect(r.stack).toHaveLength(0);
  });
});

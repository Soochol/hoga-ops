import { describe, it, expect } from 'vitest';
import { deriveBannerState, type LiveStatusInput, type BannerInput } from './useLiveBannerState';

const baseStatus: LiveStatusInput = {
  running: true,
  watchlist_count: 1,
  cycle_lag_ms: 0,
};

const offHours: BannerInput = { now: new Date('2026-05-27T03:00:00+09:00'), status: baseStatus };
const regular: BannerInput = { now: new Date('2026-05-27T10:30:00+09:00'), status: baseStatus };

describe('deriveBannerState', () => {
  it('shows watchlist_empty when watchlist_count is 0', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: { ...baseStatus, watchlist_count: 0 },
    });
    expect(r.primary).toBe('watchlist_empty');
  });

  it('shows kis_credentials_missing when running false + watchlist > 0 + no started_at', () => {
    const r = deriveBannerState({
      now: regular.now,
      status: { ...baseStatus, running: false, watchlist_count: 2, started_at_ms: null },
    });
    expect(r.primary).toBe('kis_credentials_missing');
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
      status: { ...baseStatus, watchlist_count: 0, running: false, started_at_ms: null },
    });
    // watchlist_empty wins over kis_credentials_missing per matrix ordering
    expect(r.primary).toBe('watchlist_empty');
  });

  it('null status (loading) yields no banners', () => {
    const r = deriveBannerState({ now: regular.now, status: null });
    expect(r.primary).toBeNull();
    expect(r.stack).toHaveLength(0);
  });
});

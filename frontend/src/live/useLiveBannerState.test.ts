import { describe, it, expect } from 'vitest';
import { deriveBannerState, type LiveStatusInput } from './useLiveBannerState';

const baseStatus: LiveStatusInput = {
  running: true,
  cycle_lag_ms: 0,
};

describe('deriveBannerState', () => {
  it('shows watchlist_empty when the watchlist inventory is empty', () => {
    const r = deriveBannerState({
      status: baseStatus,
      watchlistSize: 0,
    });
    expect(r.primary).toBe('watchlist_empty');
  });

  it('shows kis_credentials_missing when running false + watchlist > 0 + no started_at', () => {
    const r = deriveBannerState({
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: 2,
    });
    expect(r.primary).toBe('kis_credentials_missing');
  });

  it('surfaces realtime_unavailable (not kis_credentials_missing) for market-open offline', () => {
    // ADR-0118 F2: offline(시장 열림·세션 없음)은 구 false-credentials 배너가 아니라
    // 실시간 dark를 정직하게 알리는 realtime_unavailable로 표면화한다.
    const r = deriveBannerState({
      status: { ...baseStatus, running: false, started_at_ms: null, capture_reason: 'offline' },
      watchlistSize: 2,
    });
    expect(r.primary).toBe('realtime_unavailable');
  });

  // Regression (diagnose 2026-05-30): /live keyed its empty-state off
  // status.watchlist_count (poller-tracked, always 0 when the poller is down),
  // so a populated watchlist + stopped poller wrongly rendered
  // "관심종목이 비어 있습니다" AND masked the real kis_credentials_missing cause.
  // The empty decision must come from the authoritative inventory size.
  it('does NOT show watchlist_empty when the watchlist has entries but the poller is down', () => {
    const r = deriveBannerState({
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: 9, // inventory is non-empty; poller-tracked count would be 0
    });
    expect(r.primary).not.toBe('watchlist_empty');
    expect(r.primary).toBe('kis_credentials_missing');
  });

  it('defers priority-1 banners while the watchlist size is still loading', () => {
    const r = deriveBannerState({
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: null,
    });
    expect(r.primary).toBeNull();
  });

  it('stacks kis_token_expired when the token has expired', () => {
    const r = deriveBannerState({
      status: baseStatus,
      watchlistSize: 1,
      tokenExpired: true,
    });
    expect(r.primary).toBeNull();
    expect(r.stack).toContain('kis_token_expired');
  });

  it('priority-1 causes are mutually exclusive', () => {
    const r = deriveBannerState({
      status: { ...baseStatus, running: false, started_at_ms: null },
      watchlistSize: 0,
    });
    // watchlist_empty wins over kis_credentials_missing per matrix ordering
    expect(r.primary).toBe('watchlist_empty');
  });

  it('null status (loading) yields no banners', () => {
    const r = deriveBannerState({ status: null, watchlistSize: 1 });
    expect(r.primary).toBeNull();
    expect(r.stack).toHaveLength(0);
  });
});

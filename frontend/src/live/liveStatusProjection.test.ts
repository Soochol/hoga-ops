import { describe, expect, it } from 'vitest';
import { projectLiveStatus, type LiveStatusProjectionInput } from './liveStatusProjection';
import type { LiveStatus } from '../api/liveStatus';

const baseStatus: LiveStatus = {
  running: true,
  started_at_ms: 1,
  last_tick_ms: 1,
  cycle_lag_ms: 0,
  capture_healthy: true,
  capture_reason: 'healthy',
  watchlist_count: 0,
  kis_calls_today: 0,
  kis_rate_limit_remaining: null,
  live_set: [],
  storage_policy: 'ws_plus_rest',
  kis_api_running: false,
  kis_api_targets: [],
  kis_api_target_count: 0,
  kis_api_last_cycle_ms: null,
  kis_api_last_error: null,
  kis_api_last_error_count: 0,
  kis_api_degraded: false,
};

function project(input: Partial<LiveStatusProjectionInput>) {
  return projectLiveStatus({
    status: baseStatus,
    inventory: { kind: 'watchlist', size: 1 },
    ...input,
  });
}

describe('projectLiveStatus', () => {
  it('keeps offline startup neutral instead of showing missing KIS credentials', () => {
    const projection = project({
      status: {
        ...baseStatus,
        running: false,
        started_at_ms: null,
        capture_healthy: false,
        capture_reason: 'offline',
      },
      inventory: { kind: 'watchlist', size: 2 },
    });

    expect(projection.banner.primary).toBeNull();
    expect(projection.captureHealth.severity).toBe('ok');
    expect(projection.captureHealth.label).toBe('오프라인');
  });

  it('shows missing KIS credentials for a non-empty watchlist and stopped non-offline capture', () => {
    const projection = project({
      status: {
        ...baseStatus,
        running: false,
        started_at_ms: null,
        capture_healthy: false,
        capture_reason: 'missing_credentials',
      },
      inventory: { kind: 'watchlist', size: 2 },
    });

    expect(projection.banner.primary).toBe('kis_credentials_missing');
  });

  it('uses authoritative watchlist inventory instead of status.watchlist_count', () => {
    const projection = project({
      status: {
        ...baseStatus,
        running: false,
        started_at_ms: null,
        watchlist_count: 0,
        capture_healthy: false,
        capture_reason: 'missing_credentials',
      },
      inventory: { kind: 'watchlist', size: 9 },
    });

    expect(projection.banner.primary).toBe('kis_credentials_missing');
  });

  it('defers priority banners while watchlist inventory is loading', () => {
    const projection = project({
      status: {
        ...baseStatus,
        running: false,
        started_at_ms: null,
        capture_healthy: false,
        capture_reason: 'missing_credentials',
      },
      inventory: { kind: 'watchlist', size: null },
    });

    expect(projection.banner.primary).toBeNull();
  });

  it('keeps watchlist_empty scoped to the live watchlist surface', () => {
    expect(project({ inventory: { kind: 'watchlist', size: 0 } }).banner.primary).toBe('watchlist_empty');
    expect(project({ inventory: { kind: 'heatmap', size: 0 } }).banner.primary).toBeNull();
  });

  it('stacks token expiration without overriding the primary banner', () => {
    const projection = project({
      inventory: { kind: 'watchlist', size: 0 },
      tokenExpired: true,
    });

    expect(projection.banner.primary).toBe('watchlist_empty');
    expect(projection.banner.stack).toEqual(['kis_token_expired']);
  });

  it.each([
    ['healthy', true, 'ok', 'LIVE●', true],
    ['offline', false, 'ok', '오프라인', false],
    ['closed', false, 'ok', '장 마감', false],
    ['reconnecting', false, 'warn', '재연결 중...', false],
    ['subscribing', false, 'warn', '구독 중...', false],
    ['sub_failed', false, 'error', '구독 실패', false],
    ['stale', false, 'error', '수신 끊김', false],
  ] as const)('projects capture reason %s', (reason, healthy, severity, label, showDot) => {
    const projection = project({
      status: {
        ...baseStatus,
        capture_healthy: healthy,
        capture_reason: reason,
      },
    });

    expect(projection.captureHealth.severity).toBe(severity);
    expect(projection.captureHealth.label).toBe(label);
    expect(projection.captureHealth.showDot).toBe(showDot);
  });
});

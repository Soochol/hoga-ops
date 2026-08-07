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
  live_set: [],
  rest_bypass_enabled: false,
};

function project(input: Partial<LiveStatusProjectionInput>) {
  return projectLiveStatus({
    status: baseStatus,
    inventory: { kind: 'watchlist', size: 1 },
    ...input,
  });
}

describe('projectLiveStatus', () => {
  it('surfaces realtime_unavailable when market-open capture is offline (F2)', () => {
    // ADR-0118: 실시간=키움 전담. 시장 열림(offline≠closed)인데 세션이 없으면 호가·체결이
    // 조용히 멈춘다 — F2가 이 dark 상태를 배너로 표면화. (구 false-credentials 배너는 아님.)
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

    expect(projection.banner.primary).toBe('realtime_unavailable');
    // 캡처 칩은 그대로 '오프라인'(severity ok) — 배너는 별개 표면.
    expect(projection.captureHealth.severity).toBe('ok');
    expect(projection.captureHealth.label).toBe('오프라인');
  });

  it('keeps market-closed capture neutral (no realtime_unavailable banner)', () => {
    // closed = 장 마감이라 실시간 정지는 정상 — 배너 없음(offline과 구분).
    const projection = project({
      status: {
        ...baseStatus,
        running: false,
        started_at_ms: null,
        capture_healthy: false,
        capture_reason: 'closed',
      },
      inventory: { kind: 'watchlist', size: 2 },
    });

    expect(projection.banner.primary).toBeNull();
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

    expect(projection.banner.primary).toBe('credentials_missing');
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

    expect(projection.banner.primary).toBe('credentials_missing');
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

  // 백엔드가 실제로 내는 reason 전수(lifecycle.py 의 Literal)와 1:1. 여기 없는 값을
  // 백엔드가 내보내면 CaptureReason union 이 늘고 CAPTURE_REASON_VIEW 가 컴파일
  // 에러를 내므로, 이 표가 조용히 뒤처지지 않는다. 마지막 행은 union 밖 폴백 —
  // 원문 라벨 + error 가 사고가 아니라 설계임을 못 박는다.
  it.each([
    ['healthy', true, 'ok', 'LIVE●', true],
    ['offline', false, 'ok', '오프라인', false],
    ['closed', false, 'ok', '장 마감', false],
    ['registration_incomplete', false, 'error', '구독 등록 미완', false],
    ['some_future_reason', false, 'error', 'some_future_reason', false],
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

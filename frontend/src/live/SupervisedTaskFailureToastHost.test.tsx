import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SupervisedTaskFailureToastHost from './SupervisedTaskFailureToastHost';
import { deadSupervisedTasks, type LiveStatus } from '../api/liveStatus';

function baseStatus(overrides: Partial<LiveStatus> = {}): LiveStatus {
  return {
    running: true,
    started_at_ms: 1,
    last_tick_ms: 1,
    cycle_lag_ms: 0,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: 1,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: [],
    kis_rest_bypass_enabled: false,
    ...overrides,
  };
}

function renderWith(status: LiveStatus) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(['live', 'status'], status);
  return render(
    <QueryClientProvider client={qc}>
      <SupervisedTaskFailureToastHost />
    </QueryClientProvider>,
  );
}

describe('deadSupervisedTasks', () => {
  it('죽은 태스크만 고른다 — 미기동은 죽음이 아니다', () => {
    // 이 구별이 없으면 HOGA_LIVE_TODAY_PROMOTE_ENABLED=false 인 사용자에게
    // 경보가 상시 켜진다.
    expect(
      deadSupervisedTasks(
        baseStatus({
          supervised_tasks: [
            { name: 'watchlist-daily-loop', running: true, state: 'running' },
            { name: 'today-promoter', running: false, state: 'not_started' },
            { name: 'capture-worker-1', running: false, state: 'dead' },
          ],
        }),
      ),
    ).toEqual(['capture-worker-1']);
  });

  it('필드가 없는 구버전 응답은 빈 목록으로 접는다', () => {
    expect(deadSupervisedTasks(baseStatus())).toEqual([]);
    expect(deadSupervisedTasks(undefined)).toEqual([]);
  });
});

describe('SupervisedTaskFailureToastHost', () => {
  it('모든 태스크가 살아 있으면 렌더하지 않는다', () => {
    renderWith(
      baseStatus({
        supervised_tasks: [
          { name: 'watchlist-daily-loop', running: true, state: 'running' },
        ],
      }),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('미기동만 있어도 경보하지 않는다', () => {
    renderWith(
      baseStatus({
        supervised_tasks: [
          { name: 'today-promoter', running: false, state: 'not_started' },
          { name: 'kiwoom-session-watchdog', running: false, state: 'not_started' },
        ],
      }),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('죽은 태스크를 알리고 복구 조치를 지시한다', () => {
    renderWith(
      baseStatus({
        supervised_tasks: [
          { name: 'watchlist-daily-loop', running: false, state: 'dead' },
        ],
      }),
    );

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('백그라운드 작업이 중단됐습니다');
    expect(toast).toHaveTextContent('watchlist-daily-loop');
    // ADR-0088: 자동 재시작 감독자가 없으므로 조치는 프로세스 재시작뿐이다.
    expect(toast).toHaveTextContent('재시작');
  });

  it('두 개를 넘으면 나머지를 "외 N개"로 접는다', () => {
    renderWith(
      baseStatus({
        supervised_tasks: [
          { name: 'capture-worker-0', running: false, state: 'dead' },
          { name: 'capture-worker-1', running: false, state: 'dead' },
          { name: 'capture-worker-2', running: false, state: 'dead' },
        ],
      }),
    );

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('capture-worker-0, capture-worker-1');
    expect(toast).toHaveTextContent('외 1개');
  });

  it('닫으면 사라진다', () => {
    renderWith(
      baseStatus({
        supervised_tasks: [{ name: 'today-promoter', running: false, state: 'dead' }],
      }),
    );
    expect(screen.getByRole('status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    expect(screen.queryByRole('status')).toBeNull();
  });
});

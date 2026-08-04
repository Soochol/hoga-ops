import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DiskHeadroomToastHost from './DiskHeadroomToastHost';
import type { DiskHeadroom, LiveStatus } from '../api/liveStatus';

function baseStatus(disk?: DiskHeadroom | null): LiveStatus {
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
    rest_bypass_enabled: false,
    disk,
  };
}

function renderWith(status: LiveStatus) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(['live', 'status'], status);
  const utils = render(
    <QueryClientProvider client={qc}>
      <DiskHeadroomToastHost />
    </QueryClientProvider>,
  );
  // 폴링이 새 값을 물어오는 것을 흉내 낸다. QueryClient 를 갈아 끼우는 방식은
  // 구독이 새 클라이언트를 따라가지 않아 컴포넌트가 옛 값을 계속 본다 —
  // 같은 클라이언트의 데이터를 갱신해야 실제 폴링과 같은 경로가 된다.
  return { ...utils, poll: (next: LiveStatus) => qc.setQueryData(['live', 'status'], next) };
}

describe('DiskHeadroomToastHost', () => {
  it('여유가 충분하면 아무것도 띄우지 않는다', () => {
    renderWith(baseStatus({ free_pct: 26.6, free_gib: 250, low: false }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('필드가 없는 구버전 응답에서도 조용하다', () => {
    renderWith(baseStatus(undefined));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('임계 아래면 남은 양과 함께 경고한다', () => {
    renderWith(baseStatus({ free_pct: 8.2, free_gib: 76.8, low: true }));
    expect(screen.getByText('디스크 여유가 부족합니다')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('8.2%');
    expect(screen.getByRole('status').textContent).toContain('76.8GiB');
  });

  it('위험 단계는 문구가 다르다', () => {
    renderWith(baseStatus({ free_pct: 3.1, free_gib: 29, low: true }));
    expect(screen.getByText('디스크가 거의 찼습니다')).toBeTruthy();
  });

  it('닫으면 사라진다', () => {
    renderWith(baseStatus({ free_pct: 8.2, free_gib: 76.8, low: true }));
    fireEvent.click(screen.getByLabelText('닫기'));
    expect(screen.queryByText('디스크 여유가 부족합니다')).toBeNull();
  });

  it('경고를 닫아 둔 뒤 위험으로 악화되면 다시 뜬다', async () => {
    // 한 번 닫았다고 영영 조용해지면, 정확히 가장 위험한 구간에서 신호가 없다.
    const { poll } = renderWith(baseStatus({ free_pct: 8.2, free_gib: 76.8, low: true }));
    fireEvent.click(screen.getByLabelText('닫기'));
    expect(screen.queryByText('디스크 여유가 부족합니다')).toBeNull();

    act(() => {
      poll(baseStatus({ free_pct: 3.1, free_gib: 29, low: true }));
    });
    expect(await screen.findByText('디스크가 거의 찼습니다')).toBeTruthy();
  });

  it('회복되면 닫지 않아도 사라진다', async () => {
    // 폴링 파생 값이므로 소멸을 손으로 관리하지 않는다.
    const { poll } = renderWith(baseStatus({ free_pct: 8.2, free_gib: 76.8, low: true }));
    expect(screen.getByRole('status')).toBeTruthy();

    act(() => {
      poll(baseStatus({ free_pct: 40, free_gib: 375, low: false }));
    });
    await waitFor(() => expect(screen.queryByText('디스크 여유가 부족합니다')).toBeNull());
  });
});

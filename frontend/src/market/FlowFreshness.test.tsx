import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowCollection } from '../api/market';
import { FlowFreshness } from './FlowFreshness';
import { flowStatus } from './flowStatus';

const collection: FlowCollection = {
  server_now_ms: 100_000, collection_expected: true, poll_interval_ms: 10_000, stale_after_ms: 30_000,
  targets: { KOSPI: {
    status: 'receiving', last_success_at_ms: 100_000, last_written_at_ms: 1000,
    last_attempt_at_ms: 99_000, consecutive_failures: 0, error_kind: null,
    failure_started_at_ms: null, gaps: [],
  } },
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('receipt freshness', () => {
  it('uses receipt age, not the last changed value', () => {
    expect(flowStatus(collection, collection.targets.KOSPI, 30_000)).toBe('receiving');
    expect(flowStatus(collection, collection.targets.KOSPI, 30_001)).toBe('delayed');
    expect(flowStatus({ ...collection, collection_expected: false }, {
      ...collection.targets.KOSPI, status: 'closed',
    }, 600_000)).toBe('closed');
  });

  it('ages without another server response and resets on recovery', async () => {
    vi.useFakeTimers();
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { rerender } = render(<FlowFreshness collection={collection} target="KOSPI" receivedAt={1} error={false} />);
    expect(screen.getByRole('status').textContent).toContain('정상 수신');
    monotonic.mockReturnValue(31_000);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole('status').textContent).toContain('수신 지연');
    rerender(<FlowFreshness collection={collection} target="KOSPI" receivedAt={2} error={false} />);
    expect(screen.getByRole('status').textContent).toContain('정상 수신');
  });

  it('separates a browser API failure and a missing receipt file', () => {
    const { rerender } = render(<FlowFreshness target="KOSPI" receivedAt={0} error={true} />);
    expect(screen.getByRole('status').textContent).toBe('서버 연결 확인 필요');
    rerender(<FlowFreshness collection={collection} target="KOSPI" receivedAt={1} error />);
    expect(screen.getByRole('status').textContent).toContain('마지막 데이터 유지');
    rerender(<FlowFreshness target="KOSPI" receivedAt={1} error={false} />);
    expect(screen.getByRole('status').textContent).toBe('수신 상태 확인 불가');
  });
});

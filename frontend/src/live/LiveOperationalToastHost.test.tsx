import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveStatus } from '../api/liveStatus';
import { serviceIssues, clearedIssues } from '../serviceStatus/model';
import { useServiceStatusPanel } from '../serviceStatus/controls';
import LiveOperationalToastHost from './LiveOperationalToastHost';

const query = vi.hoisted(() => ({ data: undefined as LiveStatus | undefined, isError: false }));
vi.mock('../api/liveStatus', async importOriginal => ({ ...await importOriginal<typeof import('../api/liveStatus')>(), useLiveStatus: () => query }));
const base: LiveStatus = { running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
  capture_healthy: true, capture_reason: 'healthy', watchlist_count: 1, live_set: [], rest_bypass_enabled: false };
beforeEach(() => { vi.useFakeTimers(); query.data = { ...base, capture_healthy: false, capture_reason: 'storage_error' }; query.isError = false; useServiceStatusPanel.getState().close(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('keeps a legacy collector failure in the status panel after its attention toast closes', () => {
  render(<LiveOperationalToastHost />);
  expect(screen.getByRole('status')).toHaveTextContent('실시간 데이터 저장 오류');
  fireEvent.click(screen.getByRole('button', { name: '서비스 상태 보기' }));
  expect(useServiceStatusPanel.getState().open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(serviceIssues(query.data)).toEqual([expect.objectContaining({ id: 'collector', tone: 'error' })]);
});

it('does not repeat the same incident on polls, but notifies after recovery and recurrence', () => {
  const { rerender } = render(<LiveOperationalToastHost />);
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.queryByRole('status')).toBeNull();
  query.data = { ...query.data! };
  rerender(<LiveOperationalToastHost />);
  expect(screen.queryByRole('status')).toBeNull();
  query.data = base;
  rerender(<LiveOperationalToastHost />);
  query.data = { ...base, capture_healthy: false, capture_reason: 'storage_error' };
  rerender(<LiveOperationalToastHost />);
  expect(screen.getByRole('status')).toHaveTextContent('저장 오류');
});

it('preserves the actual failing app-key names and distinguishes recovery from missing observations', () => {
  const failed = { ...base, rest_capacity_scheduler: { auth_failing_env_keys: ['KIWOOM_APP_KEY_6'] } } as LiveStatus;
  query.data = failed;
  const { rerender } = render(<LiveOperationalToastHost />);
  expect(screen.getByRole('status')).toHaveTextContent('KIWOOM_APP_KEY_6');
  const issues = serviceIssues(failed);
  expect(clearedIssues(issues, [], base, 1)).toEqual([]);
  const recovered = { ...base, rest_capacity_scheduler: { auth_failing_env_keys: [] } } as unknown as LiveStatus;
  expect(clearedIssues(issues, serviceIssues(recovered), recovered, 2)).toHaveLength(1);
  query.data = recovered;
  rerender(<LiveOperationalToastHost />);
  expect(screen.queryByRole('status')).toBeNull();
});

it('does not duplicate a modern collector issue with its legacy capture_reason', () => {
  const status = { ...query.data!, kiwoom: { collector: { ready: false, storage_errors: ['disk'], state_reason: 'storage_error' } } } as LiveStatus;
  expect(serviceIssues(status).filter(issue => issue.id === 'collector')).toHaveLength(1);
  expect(serviceIssues({ ...base, capture_reason: 'syncing', capture_healthy: false })).toEqual([]);
});

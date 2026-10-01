import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveStatus, ProviderStatus } from '../api/liveStatus';
import { ServiceStatusButton } from './ServiceStatusButton';
import { useServiceStatusPanel } from './controls';
import { clearedIssues, serviceIssues } from './model';

const query = vi.hoisted(() => ({ data: undefined as LiveStatus | undefined, isError: false, dataUpdatedAt: 1789306680000 }));
vi.mock('../api/liveStatus', () => ({ useLiveStatus: () => query }));
const provider: ProviderStatus = {
  observed_at_ms: 1789306680000, connection: 'paused', connected_accounts: 0, configured_accounts: 5,
  last_received_at_ms: null, notice: null, notice_phase: null, notice_config_error: false, failures: [],
};
function data(p: ProviderStatus): LiveStatus {
  return { provider_status: p, running: false, started_at_ms: null, last_tick_ms: null, cycle_lag_ms: 0,
    capture_healthy: true, capture_reason: 'closed', watchlist_count: 0, live_set: [], rest_bypass_enabled: false } as LiveStatus;
}
const failure = { channel: 'rest', kind: 'request', operation: 'ka90013', observed_at_ms: 1789306680000, code: '1504' } as const;
beforeEach(() => { query.data = data({ ...provider, failures: [failure] }); query.isError = false; useServiceStatusPanel.getState().close(); });
afterEach(cleanup);
function open() { fireEvent.click(screen.getByRole('button', { name: /서비스 상태/ })); return screen.getByRole('dialog', { name: '서비스 상태' }); }

it('keeps errors behind the status button; shows safe cause, details and clipboard fallback', () => {
  render(<ServiceStatusButton />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: '서비스 상태 · 문제 1건' })).toBeVisible();
  const panel = open();
  expect(panel).toHaveTextContent('API 요청 경로가 올바르지 않습니다');
  expect(panel).toHaveTextContent('운영시간 외 대기');
  expect(panel).not.toHaveTextContent('연결/응답 오류');
  fireEvent.click(within(panel).getByText('상세 보기'));
  expect(panel).toHaveTextContent('1504');
  fireEvent.click(within(panel).getByRole('button', { name: '진단 복사' }));
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '복사할 진단' }).value).toContain('ka90013');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: /서비스 상태/ })).toHaveFocus();
});
it('treats off-hours as normal and retains maintenance source inside panel', () => {
  query.data = data(provider);
  const { rerender } = render(<ServiceStatusButton />);
  open();
  expect(screen.getByRole('dialog')).toHaveTextContent('현재 확인된 문제가 없습니다');
  query.data = data({ ...provider, notice_phase: 'active', notice: { id: 'notice', starts_at_ms: 1789300000000, ends_at_ms: 1789306680000, source: '사용자 제공 공지', reason: '시스템 작업' } });
  rerender(<ServiceStatusButton />);
  expect(screen.getByRole('dialog')).toHaveTextContent('키움 점검 시간');
  expect(screen.getByRole('dialog')).toHaveTextContent('사용자 제공 공지');
});
it('failed status polls preserve errors and cannot create recovery history', () => {
  const { rerender } = render(<ServiceStatusButton />); open();
  query.isError = true;
  query.data = data(provider);
  rerender(<ServiceStatusButton />);
  expect(screen.getByRole('dialog')).toHaveTextContent('현재 상태와 복구 여부를 확인할 수 없습니다');
  fireEvent.click(screen.getByRole('button', { name: '최근 해제 0' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('최근 해제된 기록이 없습니다');
});
it('records scoped disappearance once and does not claim full recovery', () => {
  const { rerender } = render(<ServiceStatusButton />); open();
  query.data = data(provider); rerender(<ServiceStatusButton />);
  fireEvent.click(screen.getByRole('button', { name: '최근 해제 1' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('관측 해제');
  expect(screen.getByRole('dialog')).toHaveTextContent('전체 API의 복구를 보장하지 않습니다');
  query.data = data(provider); rerender(<ServiceStatusButton />);
  expect(screen.getByRole('button', { name: '최근 해제 1' })).toBeVisible();
  query.data = data({ ...provider, failures: [failure] }); rerender(<ServiceStatusButton />);
  expect(screen.getByRole('button', { name: '최근 해제 0' })).toBeVisible();
});
it('aggregates operational issues and does not clear absent observations', () => {
  const status = { ...data(provider), disk: { low: true, free_pct: 8, free_gib: 24 }, supervised_tasks: [{ name: 'capture', running: false, state: 'dead' as const }] };
  const issues = serviceIssues(status);
  expect(issues).toHaveLength(2);
  expect(clearedIssues(issues, [], data(provider), 1)).toEqual([]);
  expect(clearedIssues(issues, [], { ...status, disk: { low: false, free_pct: 20, free_gib: 60 }, supervised_tasks: [] }, 1)).toHaveLength(2);
});
it('opens related API details from a panel request without inventing its data scope', () => {
  useServiceStatusPanel.getState().show('ka90013');
  render(<ServiceStatusButton />);
  const panel = screen.getByRole('dialog');
  expect(panel).toHaveTextContent('아래는 공급사 전체 관측');
  expect(panel.querySelector('details')).toHaveAttribute('open');
});

it('distinguishes connection from subscription readiness and copies the failed account and phase', () => {
  query.data = data({ ...provider, connection: 'partial', connected_accounts: 5, ready_accounts: 4,
    failures: [{ channel: 'ws', kind: 'timeout', operation: 'session', code: null,
      observed_at_ms: provider.observed_at_ms, account_id: 0, connection_generation: 7,
      phase: 'REG', elapsed_ms: 10_000 }] });
  render(<ServiceStatusButton />);
  const panel = open();
  expect(panel).toHaveTextContent('연결 5/5계정 · 구독 준비 4/5계정');
  expect(panel).not.toHaveTextContent('실시간 연결 정상');
  fireEvent.click(within(panel).getByText('상세 보기'));
  expect(panel).toHaveTextContent('계정 · 1');
  expect(panel).toHaveTextContent('실패 단계 · 구독 등록');
  expect(panel).toHaveTextContent('단계 소요 · 10.00초');
  expect(panel).toHaveTextContent('자동 재연결 후 로그인과 구독 준비가 확인되면 관측이 해제됩니다');
  expect(panel).not.toHaveTextContent('재조회 전에는 현재 복구 여부를 알 수 없습니다');
  fireEvent.click(within(panel).getByRole('button', { name: '진단 복사' }));
  const report = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '복사할 진단' }).value;
  expect(report).toContain('계정: 1');
  expect(report).toContain('실패 단계: 구독 등록');
  expect(report).toContain('연결 세대: 7');
});

it('keeps another account failure visible when one account recovers', () => {
  const first = { channel: 'ws', kind: 'timeout', operation: 'session', code: null,
    observed_at_ms: provider.observed_at_ms, account_id: 0, phase: 'REG' } as const;
  const second = { ...first, account_id: 2 };
  query.data = data({ ...provider, failures: [first, second] });
  const { rerender } = render(<ServiceStatusButton />);
  open();
  query.data = data({ ...provider, failures: [second] });
  rerender(<ServiceStatusButton />);
  expect(screen.getByRole('button', { name: '현재 문제 1' })).toBeVisible();
  expect(screen.getByRole('button', { name: '최근 해제 1' })).toBeVisible();
  fireEvent.click(screen.getByText('상세 보기'));
  expect(screen.getByRole('dialog')).toHaveTextContent('계정 · 3');
});

it('identifies an internal data processing failure from its stage', () => {
  query.data = data({ ...provider, failures: [{ channel: 'ws', kind: 'transport',
    operation: 'session', code: null, observed_at_ms: provider.observed_at_ms,
    account_id: 0, phase: 'dispatch' }] });
  render(<ServiceStatusButton />);
  const panel = open();
  expect(panel).toHaveTextContent('서버 내부 실시간 데이터 처리 지연 또는 실패');
  expect(panel).toHaveTextContent('서버의 처리 지연과 자동 재연결 상태를 확인하세요');
});

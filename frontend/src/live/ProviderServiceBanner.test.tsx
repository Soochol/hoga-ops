import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProviderServiceNotice } from './ProviderServiceBanner';
import type { ProviderStatus } from '../api/liveStatus';

afterEach(cleanup);
const status: ProviderStatus = {
  observed_at_ms: 1789180000000, connection: 'unavailable', connected_accounts: 0,
  configured_accounts: 5, last_received_at_ms: null, notice_config_error: false,
  notice: { id: 'kiwoom-20260912', starts_at_ms: 1789169400000, ends_at_ms: 1789210800000,
    reason: 'KRX 애프터마켓 이행 관련 시스템 작업', source: '사용자 제공 키움 공지' },
  notice_phase: 'active',
};
it('shows sourced maintenance and actual connectivity together', () => {
  render(<ProviderServiceNotice status={status} error={false} />);
  const banner = screen.getByRole('status', { name: '키움 서비스 상태' });
  expect(banner).toHaveTextContent('키움 점검 시간');
  expect(banner).toHaveTextContent('연결 0/5계정');
  expect(banner).toHaveTextContent('사용자 제공 키움 공지');
  expect(banner).toHaveTextContent('저장 데이터일 수 있습니다');
});
it('retains overdue notice until actual recovery and shows API failure over cached success', () => {
  const { rerender } = render(<ProviderServiceNotice status={{ ...status, notice_phase: 'overdue' }} error={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('실제 실시간 연결 복구 확인 중');
  rerender(<ProviderServiceNotice status={{ ...status, notice: null, notice_phase: null, connection: 'connected' }} error={false} />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<ProviderServiceNotice status={{ ...status, notice: null, connection: 'connected' }} error />);
  expect(screen.getByRole('status')).toHaveTextContent('상태 서버 연결 실패');
  expect(screen.getByRole('status')).not.toHaveTextContent('실시간 연결 정상');
});
it('shows disconnected service without inventing maintenance', () => {
  render(<ProviderServiceNotice status={{ ...status, notice: null, notice_phase: null }} error={false} />);
  expect(screen.getByRole('status')).toHaveTextContent('키움 연결 불가');
  expect(screen.getByRole('status')).not.toHaveTextContent('점검');
});

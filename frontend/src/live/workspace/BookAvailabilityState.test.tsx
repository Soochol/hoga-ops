import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BookAvailabilityState } from './BookAvailabilityState';

it('shows only the retained timestamp for quiet stale diagnostics', () => {
  render(<BookAvailabilityState state={{ kind: 'stale', message: '호가 갱신 확인 중',
    detail: '현재 서버의 호가 수신 상태를 확인할 수 없습니다', action: 'status',
    lastBookMs: Date.parse('2026-10-23T19:41:39+09:00'), quiet: true }} onRetry={vi.fn()} />);
  expect(screen.getByTestId('book-last-update')).toHaveTextContent('마지막 호가 · 19:41:39');
  expect(screen.queryByTestId('book-availability')).not.toBeInTheDocument();
  expect(screen.queryByText('호가 갱신 확인 중')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('keeps the notice and retry action for confirmed delivery delays', () => {
  render(<BookAvailabilityState state={{ kind: 'display_delayed', message: '화면 호가 갱신 지연',
    action: 'status', retryTarget: 'series', lastBookMs: 0, quiet: false }} onRetry={vi.fn()} />);
  expect(screen.getByTestId('book-availability')).toHaveTextContent('화면 호가 갱신 지연');
  expect(screen.getByRole('button', { name: '연결 상태' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '다시 조회' })).toBeInTheDocument();
});

it('retains compound failures in details and dispatches retries for the selected cause', () => {
  const retry = vi.fn();
  const { container } = render(<BookAvailabilityState state={{ kind: 'rest_error', message: '최신 호가 조회 실패',
    action: 'retry', retryTarget: 'last_orderbook', issues: [
      { kind: 'rest_error', message: '최신 호가 조회 실패', retryTarget: 'last_orderbook' },
      { kind: 'storage_error', message: '호가 저장 실패', retryTarget: 'last_orderbook' },
      { kind: 'status_error', message: '호가 수신 상태 확인 실패', retryTarget: 'status' },
    ] }} onRetry={retry} />);
  expect(screen.getAllByTestId('book-availability')).toHaveLength(1);
  expect(container.querySelector('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: '다시 조회' }));
  expect(retry).toHaveBeenLastCalledWith('last_orderbook');
  fireEvent.click(screen.getByText('상세'));
  fireEvent.click(screen.getByRole('button', { name: '호가 수신 상태 확인 실패 다시 조회' }));
  expect(retry).toHaveBeenLastCalledWith('status');
});

it('does not send pointer or double-click actions through to the ladder', () => {
  const pointer = vi.fn();
  const click = vi.fn();
  render(<div onPointerDown={pointer} onDoubleClick={click}>
    <BookAvailabilityState state={{ kind: 'query_error', message: '호가 불러오기 실패', action: 'retry', retryTarget: 'series' }} onRetry={vi.fn()} />
  </div>);
  const notice = screen.getByText('호가 불러오기 실패');
  fireEvent.pointerDown(notice);
  fireEvent.doubleClick(notice);
  expect(pointer).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});

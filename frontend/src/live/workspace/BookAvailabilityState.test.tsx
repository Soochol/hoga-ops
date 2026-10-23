import { render, screen } from '@testing-library/react';
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
    action: 'status', lastBookMs: 0, quiet: false }} onRetry={vi.fn()} />);
  expect(screen.getByTestId('book-availability')).toHaveTextContent('화면 호가 갱신 지연');
  expect(screen.getByRole('button', { name: '연결 상태' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '다시 조회' })).toBeInTheDocument();
});

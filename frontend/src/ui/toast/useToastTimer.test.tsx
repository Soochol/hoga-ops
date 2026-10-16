import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastCard } from './ToastCard';
import { useToastTimer } from './useToastTimer';

const expire = vi.fn();
function Harness({ id = 1, duration = 5000 }: { id?: number; duration?: number | null }) {
  const timer = useToastTimer({ visible: true, resetKey: id, durationMs: duration, onExpire: expire });
  return <ToastCard visible role="status" progress={timer.progress} {...timer.interactionProps}
    action={{ label: '실행 취소', onClick: () => {} }}>그림 삭제됨</ToastCard>;
}
beforeEach(() => { vi.useFakeTimers(); expire.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('pauses both dismissal and progress, then resumes only the remaining duration', () => {
  render(<Harness />);
  const card = screen.getByRole('status');
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.mouseEnter(card);
  expect(card.querySelector('.toast-progress')).toHaveStyle({ animationPlayState: 'paused' });
  act(() => vi.advanceTimersByTime(10000));
  expect(expire).not.toHaveBeenCalled();
  fireEvent.mouseLeave(card);
  expect(card.querySelector('.toast-progress')).toHaveStyle({ animationPlayState: 'running' });
  act(() => vi.advanceTimersByTime(2999));
  expect(expire).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(expire).toHaveBeenCalledOnce();
});

it('keeps keyboard actions available until focus leaves the entire toast', () => {
  render(<Harness />);
  const card = screen.getByRole('status');
  const button = screen.getByRole('button');
  act(() => vi.advanceTimersByTime(1000));
  fireEvent.focus(button);
  fireEvent.mouseEnter(card);
  fireEvent.mouseLeave(card);
  act(() => vi.advanceTimersByTime(10000));
  expect(expire).not.toHaveBeenCalled();
  fireEvent.blur(button, { relatedTarget: card });
  act(() => vi.advanceTimersByTime(10000));
  expect(expire).not.toHaveBeenCalled();
  fireEvent.blur(button, { relatedTarget: null });
  act(() => vi.advanceTimersByTime(4000));
  expect(expire).toHaveBeenCalledOnce();
});

it('starts a fresh timer and progress bar for a new notification even while hovered', () => {
  const { rerender, unmount } = render(<Harness />);
  const card = screen.getByRole('status');
  act(() => vi.advanceTimersByTime(4000));
  fireEvent.mouseEnter(card);
  const oldBar = card.querySelector('.toast-progress');
  rerender(<Harness id={2} />);
  expect(card.querySelector('.toast-progress')).not.toBe(oldBar);
  act(() => vi.advanceTimersByTime(10000));
  fireEvent.mouseLeave(card);
  act(() => vi.advanceTimersByTime(4999));
  expect(expire).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(expire).toHaveBeenCalledOnce();
  unmount();
  act(() => vi.advanceTimersByTime(10000));
  expect(expire).toHaveBeenCalledOnce();
});

it('does not auto-dismiss persistent notices', () => {
  render(<Harness duration={null} />);
  act(() => vi.advanceTimersByTime(60000));
  expect(expire).not.toHaveBeenCalled();
  expect(screen.getByRole('status').querySelector('.toast-progress')).toBeNull();
});

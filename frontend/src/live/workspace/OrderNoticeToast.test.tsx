import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrderNoticeToast, type OrderReceipt } from './OrderNoticeToast';
import type { OrderNotice } from './orderFeedback';

const warning: OrderNotice = { title: '주문 접수 불가', message: '현재 주문을 접수할 수 없는 시간입니다.', tone: 'warn' };
const expired = vi.fn();
const retry = vi.fn();
beforeEach(() => { vi.useFakeTimers(); expired.mockClear(); retry.mockClear(); });
afterEach(() => vi.useRealTimers());

function Harness({ initial = warning }: { initial?: OrderNotice }) {
  const [notice, setNotice] = useState<OrderNotice | null>(initial);
  return <OrderNoticeToast notice={notice} receipt={null} busy={false}
    onDismiss={() => { expired(); setNotice(null); }} onExpireReceipt={expired} onRetry={retry} />;
}

it('첫 알림 전에는 별도 호스트를 만들지 않고 앱의 전역 알림 영역을 사용한다', () => {
  const content = (notice: OrderNotice | null) => <><div id="toast-viewport" data-testid="global-toasts" />
    <OrderNoticeToast notice={notice} receipt={null} busy={false} onDismiss={expired} onExpireReceipt={expired} onRetry={retry} /></>;
  const view = render(content(null));
  expect(document.querySelectorAll('#toast-viewport')).toHaveLength(1);
  view.rerender(content(warning));
  expect(document.querySelectorAll('#toast-viewport')).toHaveLength(1);
  expect(screen.getByTestId('global-toasts')).toContainElement(screen.getByRole('alert', { name: '주문 알림' }));
});

it('8초 경고의 진행바와 자동 닫기를 호버·키보드 포커스 동안 함께 멈춘다', () => {
  render(<Harness />);
  const card = screen.getByRole('alert', { name: '주문 알림' });
  expect(card).toHaveTextContent(warning.message);
  expect(within(card).queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.mouseEnter(card);
  act(() => vi.advanceTimersByTime(10000));
  expect(expired).not.toHaveBeenCalled();
  expect(card.querySelector('.toast-progress')).toHaveStyle({ animationPlayState: 'paused' });
  const close = within(card).getByRole('button', { name: '주문 알림 닫기' });
  fireEvent.focus(close);
  fireEvent.mouseLeave(card);
  act(() => vi.advanceTimersByTime(10000));
  expect(expired).not.toHaveBeenCalled();
  fireEvent.blur(close, { relatedTarget: null });
  act(() => vi.advanceTimersByTime(5999));
  expect(expired).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(expired).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('같은 사유를 다시 안내하면 카드를 쌓지 않고 8초 시계를 다시 시작한다', () => {
  const content = (notice: OrderNotice) => <OrderNoticeToast notice={notice} receipt={null} busy={false}
    onDismiss={expired} onExpireReceipt={expired} onRetry={retry} />;
  const view = render(content(warning));
  act(() => vi.advanceTimersByTime(7000));
  view.rerender(content({ ...warning }));
  act(() => vi.advanceTimersByTime(7999));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(expired).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(expired).toHaveBeenCalledOnce();
});

it('결과 불명확 알림은 진행바·자동 만료 없이 남기고 재확인 액션을 유지한다', () => {
  render(<OrderNoticeToast notice={{ title: '주문 결과 확인 필요', message: '접수 여부를 확인하세요', tone: 'error', persistent: true, retry: true }}
    receipt={null} busy={false} onDismiss={expired} onExpireReceipt={expired} onRetry={retry} />);
  act(() => vi.advanceTimersByTime(60000));
  expect(expired).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').querySelector('.toast-progress')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('전송 중에는 만료하지 않고 접수 성공으로 바뀐 시점부터 4초를 센다', () => {
  const content = (receipt: OrderReceipt) => <OrderNoticeToast notice={null} receipt={receipt} busy={receipt.sending}
    onDismiss={expired} onExpireReceipt={expired} onRetry={retry} />;
  const view = render(content({ text: '주문 요청 중', sending: true, commandId: 'one' }));
  act(() => vi.advanceTimersByTime(60000));
  expect(expired).not.toHaveBeenCalled();
  view.rerender(content({ text: '주문 요청 접수됨', sending: false, commandId: 'one' }));
  act(() => vi.advanceTimersByTime(3999));
  expect(expired).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(expired).toHaveBeenCalledOnce();
});

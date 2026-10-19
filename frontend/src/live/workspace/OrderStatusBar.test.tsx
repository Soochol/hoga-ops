import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrderStatusBar, type OrderReceipt } from './OrderStatusBar';
import type { OrderNotice } from './orderFeedback';

const warning: OrderNotice = { title: '주문 접수 불가', message: '현재 주문을 접수할 수 없는 시간입니다.', tone: 'warn' };
const expired = vi.fn();
const retry = vi.fn();
beforeEach(() => { vi.useFakeTimers(); expired.mockClear(); retry.mockClear(); });
afterEach(() => vi.useRealTimers());

function Harness({ initial = warning }: { initial?: OrderNotice }) {
  const [notice, setNotice] = useState<OrderNotice | null>(initial);
  return <OrderStatusBar notice={notice} receipt={null} busy={false}
    onDismiss={() => { expired(); setNotice(null); }} onExpireReceipt={expired} onRetry={retry} />;
}

it('알림이 없어도 대기 상태줄을 유지하고 주문창 안에서만 결과를 표시한다', () => {
  const content = (notice: OrderNotice | null) => <><div id="toast-viewport" data-testid="global-toasts" />
    <OrderStatusBar notice={notice} receipt={null} busy={false} onDismiss={expired} onExpireReceipt={expired} onRetry={retry} /></>;
  const view = render(content(null));
  expect(screen.getByRole('status', { name: '주문 상태' })).toHaveTextContent('주문 대기');
  const bar = screen.getByTestId('order-status-bar');
  expect(document.querySelectorAll('#toast-viewport')).toHaveLength(1);
  view.rerender(content(warning));
  expect(document.querySelectorAll('#toast-viewport')).toHaveLength(1);
  expect(screen.getByRole('alert', { name: '주문 알림' })).toBe(bar);
  expect(screen.getByTestId('global-toasts')).toBeEmptyDOMElement();
});

it('8초 경고의 자동 닫기를 호버·키보드 포커스 동안 멈추고 대기 상태로 돌아간다', () => {
  render(<Harness />);
  const card = screen.getByRole('alert', { name: '주문 알림' });
  expect(card).toHaveTextContent(warning.message);
  expect(within(card).queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.mouseEnter(card);
  act(() => vi.advanceTimersByTime(10000));
  expect(expired).not.toHaveBeenCalled();
  expect(card.querySelector('.toast-progress')).toBeNull();
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
  expect(screen.getByTestId('order-status-bar')).toBe(card);
  expect(card).toHaveTextContent('주문 대기');
});

it('같은 사유를 다시 안내하면 카드를 쌓지 않고 8초 시계를 다시 시작한다', () => {
  const content = (notice: OrderNotice) => <OrderStatusBar notice={notice} receipt={null} busy={false}
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
  render(<OrderStatusBar notice={{ title: '주문 결과 확인 필요', message: '접수 여부를 확인하세요', tone: 'error', persistent: true, retry: true }}
    receipt={null} busy={false} onDismiss={expired} onExpireReceipt={expired} onRetry={retry} />);
  act(() => vi.advanceTimersByTime(60000));
  expect(expired).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').querySelector('.toast-progress')).toBeNull();
  expect(screen.queryByRole('button', { name: '주문 알림 닫기' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '같은 요청 다시 확인' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '내역 확인' }));
  expect(screen.getByRole('dialog', { name: '주문 알림 상세' })).toHaveTextContent('접수 여부를 확인하세요');
  fireEvent.click(screen.getByRole('button', { name: '같은 요청 다시 확인' }));
  expect(retry).toHaveBeenCalledOnce();
});

it('긴 오류는 본문 상세 팝업으로 열고 Escape로 닫으면 상태줄에 포커스를 복원한다', () => {
  const view = render(<Harness />);
  const message = screen.getByRole('button', { name: '주문 알림 상세 보기' });
  fireEvent.click(message);
  const details = screen.getByRole('dialog', { name: '주문 알림 상세' });
  expect(view.container).not.toContainElement(details);
  expect(details).toHaveTextContent(warning.message);
  act(() => vi.advanceTimersByTime(60000));
  expect(expired).not.toHaveBeenCalled();
  fireEvent.keyDown(details, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(message).toHaveFocus();
});

it('일반 오류 상태줄은 수량 수정이나 내역 확인 버튼 없이 문구와 닫기만 표시한다', () => {
  render(<Harness />);
  expect(screen.queryByRole('button', { name: '수량 수정' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '내역 확인' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '주문 알림 닫기' })).toBeInTheDocument();
});

it('이전 오류가 다시 표시돼도 닫힌 상세 팝업을 자동으로 열지 않는다', () => {
  const content = (notice: OrderNotice | null, receipt: OrderReceipt | null = null) => <OrderStatusBar notice={notice} receipt={receipt} busy={false}
    onDismiss={expired} onExpireReceipt={expired} onRetry={retry} />;
  const view = render(content(warning));
  fireEvent.click(screen.getByRole('button', { name: '주문 알림 상세 보기' }));
  expect(screen.getByRole('dialog', { name: '주문 알림 상세' })).toBeInTheDocument();
  view.rerender(content(null, { text: '주문 요청 접수됨', commandId: 'accepted' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  view.rerender(content(warning));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('alert', { name: '주문 알림' })).toHaveTextContent(warning.message);
});

it('전송 중에는 알리지 않고 접수 성공 시점부터 4초를 센다', () => {
  const content = (receipt: OrderReceipt | null) => <OrderStatusBar notice={null} receipt={receipt} busy={receipt === null}
    onDismiss={expired} onExpireReceipt={expired} onRetry={retry} />;
  const view = render(content(null));
  expect(screen.queryByRole('status', { name: '주문 접수 알림' })).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(60000));
  expect(expired).not.toHaveBeenCalled();
  view.rerender(content({ text: '주문 요청 접수됨', commandId: 'one' }));
  act(() => vi.advanceTimersByTime(3999));
  expect(expired).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(expired).toHaveBeenCalledOnce();
});

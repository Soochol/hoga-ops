import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeBrokerOrder, type BrokerOrderWire, type OrderStateResponse, type TossOrder } from '../../api/trading';
import type { PushEvent } from '../../api/types';
import { notifyOrderFill } from './orderReceiptSound';
import { createOrderFillTracker, useOrderFillSound } from './useOrderFillSound';

const listeners = vi.hoisted(() => new Set<(event: PushEvent) => void>());
vi.mock('../../api/ws', () => ({ subscribeEvents: (listener: (event: PushEvent) => void) => {
  listeners.add(listener); return () => listeners.delete(listener);
} }));
vi.mock('./orderReceiptSound', () => ({ notifyOrderFill: vi.fn() }));
const start = Date.parse('2026-10-21T10:00:00+09:00');
const order = (filled = '0', extra: Partial<TossOrder> = {}): TossOrder => ({
  orderId: 'order-a', symbol: '005930', side: 'BUY', status: 'PARTIAL_FILLED', quantity: '100',
  orderType: 'LIMIT', timeInForce: 'DAY', price: '60000', orderAmount: null, currency: 'KRW',
  orderedAt: '2026-10-21T09:00:00+09:00', canceledAt: null,
  execution: { filledQuantity: filled, averageFilledPrice: '60000', filledAmount: null,
    commission: null, tax: null, filledAt: null, settlementDate: null }, ...extra,
});
const state = (orders: TossOrder[], recent: TossOrder[] = []): OrderStateResponse => ({
  account_seq: 1, code: '005930', orders, recent_orders: recent,
  fetched_at_ms: start, events_connected: true, unresolved_commands: [],
});
const kiwoomOrder = (extra: Partial<BrokerOrderWire> = {}) => normalizeBrokerOrder({
  order_ref: 'kiwoom-existing', account_ref: 'kiwoom:real', code: '005930', side: 'BUY', order_type: 'LIMIT',
  status: 'PENDING', quantity: '100', price: '60000', remaining_quantity: '100', filled_quantity: null,
  ordered_at: null, average_filled_price: null, editable: true, ...extra,
});
beforeEach(() => { listeners.clear(); vi.clearAllMocks(); });

describe('내 주문 체결 알림', () => {
  it.each([true, false])('기존 키움 미확정 주문의 이후 확정 체결을 한 번 알린다. 초기 조회 %s', (hasInitialState) => {
    const pending = kiwoomOrder();
    expect(pending.execution.filledQuantity).toBeNull();
    const initial: OrderStateResponse | undefined = hasInitialState ? state([pending]) : undefined;
    const hook = renderHook(({ data }: { data: OrderStateResponse | undefined }) =>
      useOrderFillSound('kiwoom:real', '005930', data, true, false), { initialProps: { data: initial } });
    if (!hasInitialState) hook.rerender({ data: state([pending]) });
    hook.rerender({ data: state([kiwoomOrder({ status: 'PARTIAL_FILLED', remaining_quantity: '70' })]) });
    expect(notifyOrderFill).not.toHaveBeenCalled();
    const filled = kiwoomOrder({ status: 'FILLED', remaining_quantity: '0', filled_quantity: '100' });
    hook.rerender({ data: state([], [filled]) });
    hook.rerender({ data: state([], [filled]) });
    expect(notifyOrderFill).toHaveBeenCalledExactlyOnceWith('kiwoom:real', '005930', 'kiwoom-existing', 'BUY', 100);
    hook.unmount();
    expect(listeners.size).toBe(0);
  });
  it.each(['PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE'])(
    '%s의 미확정 수량은 정체성만 보관하고 확정 증가를 기다린다', (status) => {
      const announce = vi.fn(), tracker = createOrderFillTracker(start, announce);
      tracker.snapshot(state([kiwoomOrder({ status, remaining_quantity: '70' })]));
      tracker.snapshot(state([kiwoomOrder({ status, remaining_quantity: '40' })]));
      expect(announce).not.toHaveBeenCalled();
      tracker.snapshot(state([], [kiwoomOrder({ status: 'FILLED', remaining_quantity: '0', filled_quantity: '100' })]));
      expect(announce.mock.calls.map(([, filled]) => filled)).toEqual([100]);
    },
  );
  it.each(['FILLED', 'CANCELED', 'REPLACED', 'EXPIRED'])(
    '뒤늦은 %s 미확정 과거 이력은 감시 중인 주문으로 등록하지 않는다', (status) => {
      const announce = vi.fn(), tracker = createOrderFillTracker(start, announce);
      tracker.snapshot(state([], [kiwoomOrder({ order_ref: 'initial-history', status: 'FILLED', filled_quantity: '100' })]));
      tracker.snapshot(state([], [kiwoomOrder({ status })]));
      tracker.snapshot(state([], [kiwoomOrder({ status, filled_quantity: '50' })]));
      tracker.snapshot(state([], [kiwoomOrder({ order_ref: 'late-history', status: 'FILLED', filled_quantity: '100' })]));
      expect(announce).not.toHaveBeenCalled();
    },
  );
  it('미확정 수량이 다시 나타나도 이미 확인한 누계는 낮아지지 않는다', () => {
    const announce = vi.fn(), tracker = createOrderFillTracker(start, announce);
    tracker.snapshot(state([kiwoomOrder({ status: 'PARTIAL_FILLED', filled_quantity: '50' })]));
    tracker.snapshot(state([kiwoomOrder({ status: 'PARTIAL_FILLED', remaining_quantity: '20' })]));
    tracker.snapshot(state([kiwoomOrder({ status: 'PARTIAL_FILLED', filled_quantity: '50' })]));
    expect(announce).not.toHaveBeenCalled();
    tracker.snapshot(state([], [kiwoomOrder({ status: 'FILLED', filled_quantity: '100', remaining_quantity: '0' })]));
    expect(announce.mock.calls.map(([, filled]) => filled)).toEqual([100]);
  });
  it('처음 조회한 체결은 조용히 읽고 부분·전량 체결 증가만 알린다', () => {
    const announce = vi.fn();
    const tracker = createOrderFillTracker(start, announce);
    tracker.snapshot(state([order('30')], [order('100', { orderId: 'old', status: 'FILLED' })]));
    expect(announce).not.toHaveBeenCalled();
    tracker.snapshot(state([order('50')]));
    tracker.event(order('50'));
    tracker.event(order('30'));
    tracker.snapshot(state([], [order('100', { status: 'FILLED' })]));
    expect(announce.mock.calls.map(([, filled]) => filled)).toEqual([50, 100]);
  });
  it('접수·취소·잘못된 체결·뒤늦게 나타난 과거 이력은 알리지 않는다', () => {
    const announce = vi.fn();
    const tracker = createOrderFillTracker(start, announce);
    tracker.snapshot(state([]));
    tracker.event(order('0', { status: 'PENDING' }));
    tracker.event(order('0', { status: 'CANCELED' }));
    for (const filled of ['NaN', '-1', '101', '1.5']) tracker.event(order(filled));
    tracker.snapshot(state([], [order('100', { orderId: 'history', status: 'FILLED' })]));
    expect(announce).not.toHaveBeenCalled();
    tracker.event(order('30', { orderId: 'immediate', side: 'SELL' }));
    tracker.snapshot(state([], [order('100', { orderId: 'fresh', orderedAt: '2026-10-21T10:01:00+09:00', status: 'FILLED' })]));
    expect(announce.mock.calls.map(([entry, filled]) => [entry.orderId, filled])).toEqual([['immediate', 30], ['fresh', 100]]);
  });
  it('현재 계좌·종목·방향만 알리고 설정 변경은 새 기준을 잡으며 구독을 정리한다', () => {
    const initial = state([order('30')]);
    const hook = renderHook(({ account, code, buy, sell, data }) => useOrderFillSound(account, code, data, buy, sell), {
      initialProps: { account: 1, code: '005930', buy: true, sell: false, data: initial },
    });
    const emit = (entry: TossOrder, account = 1) => act(() => {
      listeners.forEach(listener => listener({ type: 'trading_order', mode: 'live', account_seq: account, order: entry, revision: 2 }));
    });
    emit(order('50'), 2);
    emit(order('50', { symbol: '000660' }));
    emit(order('50', { orderId: 'sell', side: 'SELL' }));
    expect(notifyOrderFill).not.toHaveBeenCalled();
    emit(order('50'));
    expect(notifyOrderFill).toHaveBeenCalledExactlyOnceWith(1, '005930', 'order-a', 'BUY', 50);
    hook.rerender({ account: 1, code: '005930', buy: false, sell: true, data: state([order('100')]) });
    expect(notifyOrderFill).toHaveBeenCalledTimes(1);
    emit(order('100', { orderId: 'sell-new', side: 'SELL', status: 'FILLED' }));
    expect(notifyOrderFill).toHaveBeenLastCalledWith(1, '005930', 'sell-new', 'SELL', 100);
    hook.rerender({ account: 1, code: '005930', buy: false, sell: false, data: initial });
    expect(listeners.size).toBe(0);
    hook.unmount();
  });
  it('v2 증권사 이벤트도 같은 체결 경로를 사용한다', () => {
    const hook = renderHook(() => useOrderFillSound('kiwoom:real', '005930', undefined, false, true));
    act(() => listeners.forEach(listener => listener({ type: 'trading_order_v2', account_ref: 'kiwoom:real', revision: 1,
      order: { order_ref: 'sell', account_ref: 'kiwoom:real', code: '005930', side: 'SELL', order_type: 'LIMIT', status: 'FILLED',
        price: '60000', quantity: '10', remaining_quantity: '0', filled_quantity: '10', ordered_at: null, average_filled_price: '60000', editable: false },
    })));
    expect(notifyOrderFill).toHaveBeenCalledExactlyOnceWith('kiwoom:real', '005930', 'sell', 'SELL', 10);
    hook.unmount();
    expect(listeners.size).toBe(0);
  });
});

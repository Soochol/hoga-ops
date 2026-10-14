import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { OrderStateResponse, TossOrder } from './trading';
import { applyTradingOrderEvent, mergeOrderSnapshot, mergeTradingOrderEvents, resetTradingOrderEvents } from './tradingRefresh';
const order = (filled = '30', status = 'PARTIAL_FILLED'): TossOrder => ({
  orderId: 'a', symbol: '005930', side: 'BUY', orderType: 'LIMIT', timeInForce: 'DAY', status,
  price: '67200', quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '', canceledAt: null,
  execution: { filledQuantity: filled, filledAt: 'known', averageFilledPrice: null, filledAmount: null, commission: null, tax: null, settlementDate: null },
});
const state = (): OrderStateResponse => ({ account_seq: 1, code: '005930', orders: [order()], recent_orders: [], revision: 1,
  events_connected: true, fetched_at_ms: 1, unresolved_commands: ['unknown-command'] });
describe('display order event guards', () => {
  it('does not roll back fills or resurrect terminal orders', () => {
    expect(mergeOrderSnapshot(order('50'), order('30'))).toBeNull();
    expect(mergeOrderSnapshot(order('50', 'CANCELED'), order('50'))).toBeNull();
    expect(mergeOrderSnapshot(order(), { ...order(), quantity: '200' })).toBeNull();
    expect(mergeOrderSnapshot(order(), order('30', 'NEW_VENDOR_STATUS'))).toBeNull();
  });
  it('preserves processing locks and the REST-only filledAt field', () => {
    const update = order('50'); update.execution.filledAt = null;
    const next = mergeOrderSnapshot(order('30', 'PENDING_CANCEL'), update);
    expect(next?.status).toBe('PENDING_CANCEL');
    expect(next?.execution.filledQuantity).toBe('50');
    expect(next?.execution.filledAt).toBe('known');
  });
  it('late REST data and old event revisions cannot undo new fills', () => {
    const client = new QueryClient();
    const base = state(); client.setQueryData(['trading', 'live', 'state', 1, 'orders', '005930'], base);
    expect(applyTradingOrderEvent(client, 'live', 1, order('50'), 2)).toBe(true);
    applyTradingOrderEvent(client, 'live', 1, order('30'), 1);
    const next = mergeTradingOrderEvents(client, 'live', 1, '005930', base)!;
    expect(next.orders[0].execution.filledQuantity).toBe('50');
    expect(next.unresolved_commands).toEqual(['unknown-command']);
    expect(mergeTradingOrderEvents(client, 'live', 1, '005930', { ...base, revision: 3, orders: [order('60')] })?.orders[0].execution.filledQuantity).toBe('60');
    client.clear();
  });
  it('terminal events remove orders even when a stale REST response still lists them', () => {
    const client = new QueryClient();
    const base = state();
    applyTradingOrderEvent(client, 'live', 1, order('50', 'CANCELED'), 2);
    const next = mergeTradingOrderEvents(client, 'live', 1, '005930', base)!;
    expect(next.orders).toHaveLength(0);
    expect(next.recent_orders[0].status).toBe('CANCELED');
    expect(applyTradingOrderEvent(client, 'live', 1, order('50'), 3)).toBe(false);
    resetTradingOrderEvents(client, 'live', 1);
    expect(mergeTradingOrderEvents(client, 'live', 1, '005930', base)?.orders).toHaveLength(0);
    expect(applyTradingOrderEvent(client, 'live', 1, order('60', 'CANCELED'), 1)).toBe(true);
    expect(mergeTradingOrderEvents(client, 'live', 1, '005930', base)?.recent_orders[0].execution.filledQuantity).toBe('60');
    client.clear();
  });
});

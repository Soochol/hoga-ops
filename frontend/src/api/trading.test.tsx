import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTradingState } from './trading';
import { pauseTradingRefresh, scheduleTradingRefresh } from './tradingRefresh';

const mock = vi.hoisted(() => ({ call: vi.fn(), listeners: new Set<(event: { type: string; mode?: string }) => void>() }));
vi.mock('./client', () => ({ apiCall: (...args: unknown[]) => mock.call(...args) }));
vi.mock('./ws', () => ({ subscribeEvents: (listener: (event: { type: string; mode?: string }) => void) => {
  mock.listeners.add(listener); return () => mock.listeners.delete(listener);
} }));
const orders = { account_seq: 1, code: '005930', orders: [], recent_orders: [], fetched_at_ms: 1, events_connected: true, unresolved_commands: [] };
const balances = { account_seq: 1, code: '005930', buying_power: '1000', sellable_quantity: '10', holding_quantity: '20', average_purchase_price: '100', fetched_at_ms: 1 };
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
async function advance(ms = 100) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const orderCalls = () => mock.call.mock.calls.filter(([path]) => String(path).includes('part=orders')).length;
const balanceCalls = () => mock.call.mock.calls.filter(([path]) => String(path).includes('part=balances')).length;
beforeEach(() => {
  vi.useFakeTimers(); mock.call.mockReset(); mock.listeners.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  mock.call.mockImplementation((path: string) => Promise.resolve(path.includes('part=orders') ? orders : balances));
});
afterEach(() => { cleanup(); client.clear(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('independent trading reads and refresh coordination', () => {
  it('continues event display updates in all windows without REST reads during a write', async () => {
    const original = { orderId: 'a', symbol: '005930', side: 'BUY' as const, orderType: 'LIMIT', timeInForce: 'DAY',
      status: 'PARTIAL_FILLED', price: '67200', quantity: '100', orderAmount: null, currency: 'KRW', orderedAt: '', canceledAt: null,
      execution: { filledQuantity: '30', filledAt: null, averageFilledPrice: null, filledAmount: null, commission: null, tax: null, settlementDate: null } };
    mock.call.mockImplementation((path: string) => Promise.resolve(path.includes('part=orders') ? { ...orders, revision: 1, orders: [original] } : balances));
    const { result } = renderHook(() => [useTradingState(1, '005930', 'live'), useTradingState(1, '005930', 'live')], { wrapper });
    await advance();
    let finish!: () => void;
    act(() => { finish = pauseTradingRefresh(client, 'live', 1); });
    const event = { type: 'trading_order', mode: 'live', account_seq: 1, revision: 2,
      order: { ...original, execution: { ...original.execution, filledQuantity: '50' } } };
    act(() => mock.listeners.forEach(listener => listener(event)));
    await advance(200);
    expect(result.current.every(window => window.data?.orders[0].execution.filledQuantity === '50')).toBe(true);
    expect(orderCalls()).toBe(1); expect(balanceCalls()).toBe(1);
    act(() => finish());
    await advance();
    expect(orderCalls()).toBe(2);
  });
  it('publishes orders while balances are still pending or fail', async () => {
    let rejectBalance!: (error: Error) => void;
    mock.call.mockImplementation((path: string) => path.includes('part=orders') ? Promise.resolve(orders)
      : new Promise((_, reject) => { rejectBalance = reject; }));
    const { result } = renderHook(() => useTradingState(1, '005930', 'live'), { wrapper });
    await advance();
    expect(result.current.data?.orders).toEqual([]);
    expect(result.current.data?.buying_power).toBeUndefined();
    expect(result.current.isError).toBe(false);
    rejectBalance(new Error('balance unavailable'));
    await advance();
    expect(result.current.data?.orders).toEqual([]);
    expect(result.current.isError).toBe(false);
    expect(result.current.balancesError).toBe(true);
  });
  it('coalesces a burst across two windows and defers balances', async () => {
    renderHook(() => { useTradingState(1, '005930', 'live'); useTradingState(1, '005930', 'live'); }, { wrapper });
    await advance();
    expect(orderCalls()).toBe(1); expect(balanceCalls()).toBe(1);
    act(() => { for (let i = 0; i < 20; i++) mock.listeners.forEach(listener => listener({ type: 'trading_changed', mode: 'live' })); });
    await advance(100);
    expect(orderCalls()).toBe(2); expect(balanceCalls()).toBe(1);
    await advance(400);
    expect(balanceCalls()).toBe(2);
  });
  it('pauses polling and events throughout a group, then refreshes orders once', async () => {
    renderHook(() => useTradingState(1, '005930', 'live'), { wrapper });
    await advance();
    let finish!: () => void;
    act(() => { finish = pauseTradingRefresh(client, 'live', 1); });
    for (let i = 0; i < 5; i++) {
      act(() => mock.listeners.forEach(listener => listener({ type: 'trading_changed', mode: 'live' })));
      await advance(1_000);
    }
    expect(orderCalls()).toBe(1); expect(balanceCalls()).toBe(1);
    act(() => finish());
    await advance(100);
    expect(orderCalls()).toBe(2);
    await advance(400);
    expect(balanceCalls()).toBe(2);
    expect(orderCalls()).toBe(2);
  });
  it('only the last outstanding command resumes refreshes, and finish is idempotent', async () => {
    renderHook(() => useTradingState(1, '005930', 'live'), { wrapper });
    await advance();
    let first!: () => void, last!: () => void;
    act(() => { first = pauseTradingRefresh(client, 'live', 1); last = pauseTradingRefresh(client, 'live', 1); });
    act(() => { first(); first(); });
    await advance(200);
    expect(orderCalls()).toBe(1);
    act(() => last());
    await advance();
    expect(orderCalls()).toBe(2);
  });
  it('ignores paper events in a live window', async () => {
    renderHook(() => useTradingState(1, '005930', 'live'), { wrapper });
    await advance();
    act(() => mock.listeners.forEach(listener => listener({ type: 'trading_changed', mode: 'paper' })));
    await advance(500);
    expect(orderCalls()).toBe(1); expect(balanceCalls()).toBe(1);
  });
  it('an event during a read waits for it rather than aborting/restarting it', async () => {
    renderHook(() => useTradingState(1, '005930', 'live'), { wrapper });
    await advance();
    let release!: (value: typeof orders) => void;
    mock.call.mockImplementation((path: string) => path.includes('part=orders') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(balances));
    act(() => scheduleTradingRefresh(client, 'live', 1));
    await advance(100);
    expect(orderCalls()).toBe(2);
    act(() => scheduleTradingRefresh(client, 'live', 1));
    await advance(200);
    expect(orderCalls()).toBe(2);
    release(orders);
    await advance(100);
    expect(orderCalls()).toBe(3);
  });
});

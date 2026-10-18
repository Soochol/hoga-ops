import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeBrokerOrder, tradingCommand, useTradingAccounts, useTradingAccountList, useTradingState } from './trading';
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

describe('broker-independent trading', () => {
  const ref = `acc_${'b'.repeat(32)}`;
  it('discovers opaque broker accounts and falls back only on missing v2 routes', async () => {
    mock.call.mockResolvedValue({ configured: true, accounts: [{ account_ref: ref, label: '키움', broker: 'kiwoom', routes: [], order_enabled: false }] });
    const { result } = renderHook(() => useTradingAccounts('live'), { wrapper });
    await advance();
    expect(result.current.data?.accounts[0]).toMatchObject({ account_seq: ref, broker: 'kiwoom', order_enabled: false });
    expect(mock.call.mock.calls.map(([path]) => path)).toEqual(['/api/trading/v2/accounts']);
  });
  it.each([401, 503])('does not mask v2 %s failures with a legacy account', async status => {
    mock.call.mockRejectedValue({ status });
    const { result } = renderHook(() => useTradingAccounts('live'), { wrapper });
    await advance();
    expect(result.current.isError).toBe(true);
    expect(mock.call).toHaveBeenCalledOnce();
  });
  it('uses legacy accounts only on 404', async () => {
    mock.call.mockRejectedValueOnce({ status: 404 }).mockResolvedValueOnce({ configured: true, accounts: [{ account_seq: 1, label: '토스' }] });
    const { result } = renderHook(() => useTradingAccounts('live'), { wrapper });
    await advance();
    expect(result.current.data?.accounts[0].account_seq).toBe(1);
    expect(mock.call.mock.calls.map(([path]) => path)).toEqual(['/api/trading/v2/accounts', '/api/trading/accounts']);
  });
  it('preserves broker remainder and unavailable fill/balance values', async () => {
    const wire = { order_ref: 'ord_test', account_ref: ref, code: '005930', side: 'BUY' as const, order_type: 'LIMIT',
      status: 'PARTIAL_FILLED', price: '67200', quantity: '100', remaining_quantity: '50', filled_quantity: null,
      ordered_at: null, average_filled_price: null, editable: false };
    expect(normalizeBrokerOrder(wire)).toMatchObject({ remaining_quantity: '50', editable: false, execution: { filledQuantity: null } });
    mock.call.mockImplementation((path: string) => Promise.resolve(path.includes('part=orders')
      ? { account_ref: ref, orders: [wire], recent_orders: [], code: '005930', unresolved_commands: [], fetched_at_ms: 1 }
      : { account_ref: ref, code: '005930', buying_power: null, sellable_quantity: null, holding_quantity: '100' }));
    const { result } = renderHook(() => useTradingState(ref, '005930', 'live'), { wrapper });
    await advance();
    expect(result.current.data?.account_seq).toBe(ref);
    expect(result.current.data?.buying_power).toBeNull();
    expect(result.current.data?.orders[0].orderId).toBe('ord_test');
    expect(mock.call.mock.calls.every(([path]) => String(path).includes(`/api/trading/v2/state?account_ref=${ref}`))).toBe(true);
    const before = mock.call.mock.calls.length;
    act(() => mock.listeners.forEach(listener => listener({ type: 'trading_changed_v2', account_ref: 'another-account' } as { type: string })));
    await advance(500);
    expect(mock.call.mock.calls.length).toBe(before);
  });
  it('sends account_ref and explicit route, retaining operation identity', async () => {
    mock.call.mockResolvedValue({ command_id: 'new', order_ref: 'ord_target', operation_ref: 'ord_operation', status: 'accepted' });
    const result = await tradingCommand<{ order_id: string }>('/orders', { account_seq: ref, code: '005930', command_id: 'new', route: 'KRX' }, 'live');
    const [path, options] = mock.call.mock.calls[0];
    expect(path).toBe('/api/trading/v2/orders');
    expect(JSON.parse(options.body)).toEqual({ account_ref: ref, code: '005930', command_id: 'new', route: 'KRX' });
    expect(options.headers['X-Hoga-Order']).toBe('1');
    expect(result.order_id).toBe('ord_operation');
  });
});

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

it('account tabs are lazy, pause through writes, and merge events from every symbol', async () => {
  const accountOrders = { ...orders, code: '', revision: 1 };
  mock.call.mockImplementation((path: string) => Promise.resolve(path.includes('account-orders') ? accountOrders
    : { account_seq: 1, holdings: [], fetched_at_ms: 1 }));
  const { result, rerender } = renderHook(({ tab }: { tab: 'orders' | 'holdings' | null }) => useTradingAccountList(1, tab),
    { wrapper, initialProps: { tab: null as 'orders' | 'holdings' | null } });
  await advance(500); expect(mock.call).not.toHaveBeenCalled();
  rerender({ tab: 'orders' }); await advance();
  expect(mock.call).toHaveBeenCalledOnce();
  let finish!: () => void;
  act(() => { finish = pauseTradingRefresh(client, 'live', 1); });
  const event = { type: 'trading_order', mode: 'live', account_seq: 1, revision: 2, order: {
    orderId: 'other-symbol', symbol: '000660', side: 'SELL', orderType: 'LIMIT', timeInForce: 'DAY', status: 'PENDING',
    price: '180000', quantity: '22', currency: 'KRW', orderedAt: '', execution: { filledQuantity: '0' },
  } };
  act(() => mock.listeners.forEach(listener => listener(event)));
  await advance(4_000);
  expect(result.current.orders.data?.orders.map(order => order.symbol)).toEqual(['000660']);
  expect(mock.call).toHaveBeenCalledOnce();
  rerender({ tab: 'holdings' }); await advance(); expect(mock.call).toHaveBeenCalledOnce();
  act(() => finish()); await advance();
  expect(mock.call).toHaveBeenCalledTimes(2);
  expect(mock.call.mock.calls[1][0]).toContain('/holdings?account_seq=1');
  rerender({ tab: null }); await advance(12_000);
  expect(mock.call).toHaveBeenCalledTimes(2);
});

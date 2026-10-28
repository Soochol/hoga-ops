import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAccountExecutions } from './accountExecutions';

const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./client', () => ({ apiCall: (...args: unknown[]) => mock.call(...args) }));
const account = `acc_${'a'.repeat(32)}`;
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(100); });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00+09:00')); mock.call.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { cleanup(); client.clear(); vi.clearAllTimers(); vi.useRealTimers(); });
function page(path: string, cursor: string | null = null) {
  const p = new URL(path, 'http://fixture').searchParams;
  return { account_ref: p.get('account_ref'), code: p.get('code'), date: p.get('date'), price_venue: p.get('venue'),
    next_cursor: cursor, rows: [], supported: true, message: null, raw_close: '100', fetched_at_ms: Date.now() };
}

it('fetches only when enabled and paginates each visible date without duplicating individual executions', async () => {
  mock.call.mockImplementation(async (path: string) => {
    const p = new URL(path, 'http://fixture').searchParams;
    const first = p.get('date') === '20261027' && !p.has('cursor');
    return { ...page(path, first ? 'next' : null), rows: [{ execution_id: p.get('date') + (p.get('cursor') ?? ''),
      order_ref: 'ord_fixture', code: '005930', trading_date: p.get('date'), t_ms: 100,
      price: '100', quantity: '1', side: 'BUY', venue: 'KRX' }] };
  });
  const dates = ['20261027', '20261026'];
  const { result, rerender } = renderHook(({ enabled }) => useAccountExecutions(account, '005930', dates, enabled, 'KRX'),
    { wrapper, initialProps: { enabled: false } });
  await advance(); expect(mock.call).not.toHaveBeenCalled();
  rerender({ enabled: true }); await advance(); await advance(); await advance();
  expect(mock.call).toHaveBeenCalledTimes(3);
  expect(result.current.rows).toHaveLength(3);
  expect(result.current.more).toBeFalsy();
  expect(result.current.rawCloses).toEqual({ '20261027': 100, '20261026': 100 });
});

it('stops on an unsupported provider and does not label order averages as executions', async () => {
  mock.call.mockImplementation(async (path: string) => ({ ...page(path), supported: false, message: '개별 체결 미지원' }));
  const { result } = renderHook(() => useAccountExecutions(account, '005930', ['20261027', '20261026'], true, 'KRX'), { wrapper });
  await advance();
  expect(mock.call).toHaveBeenCalledOnce(); expect(result.current.rows).toEqual([]);
  expect(result.current.message).toBe('개별 체결 미지원');
});

it('retries only populated date groups; it never refetches a disabled empty current-day query', async () => {
  mock.call.mockRejectedValueOnce(new Error('failed')).mockImplementation(async (path: string) => page(path));
  const { result } = renderHook(() => useAccountExecutions(account, '005930', ['20261027'], true, 'KRX'), { wrapper });
  await advance(); expect(result.current.error).toBeTruthy();
  act(() => result.current.retry()); await advance();
  expect(result.current.error).toBeNull();
  expect(mock.call).toHaveBeenCalledTimes(2);
  expect(mock.call.mock.calls.every(([path]) => String(path).includes('date=20261027'))).toBe(true);
});

it('rejects a mismatched account response and starts fresh on account changes', async () => {
  mock.call.mockImplementation(async (path: string) => ({ ...page(path), account_ref: 'other-account' }));
  const { result, rerender } = renderHook(({ ref }) => useAccountExecutions(ref, '005930', ['20261027'], true, 'KRX'),
    { wrapper, initialProps: { ref: account } });
  await advance(); expect(result.current.error).toBeTruthy(); expect(result.current.rows).toEqual([]);
  mock.call.mockImplementation(async (path: string) => page(path));
  rerender({ ref: `acc_${'b'.repeat(32)}` }); await advance();
  expect(result.current.error).toBeNull(); expect(result.current.rows).toEqual([]);
});

it('keeps the newest Toss order summary across overlapping pages and refreshes it in place', async () => {
  let quantity = '30', price = '100.25', t_ms = 300;
  const summary = (quantity: string, price: string, t_ms: number) => ({
    execution_id: 'same-order', order_ref: 'ord_fixture', code: '005930', trading_date: '20261028',
    t_ms, price, quantity, side: 'BUY', venue: null, basis: 'order_average',
  });
  mock.call.mockImplementation(async (path: string) => {
    const cursor = new URL(path, 'http://fixture').searchParams.has('cursor');
    return { ...page(path, cursor ? null : 'older-page'),
      rows: [cursor ? summary('10', '99', 100) : summary(quantity, price, t_ms)] };
  });
  const { result } = renderHook(() => useAccountExecutions(account, '005930', ['20261028'], true, 'KRX'), { wrapper });
  await advance(); await advance();
  expect(result.current.rows).toHaveLength(1);
  expect(result.current.rows[0]).toMatchObject({ quantity: '30', price: '100.25', basis: 'order_average', t_ms: 300 });
  quantity = '40'; price = '101.125'; t_ms = 400;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await advance(); await advance();
  expect(result.current.rows).toHaveLength(1);
  expect(result.current.rows[0]).toMatchObject({ quantity: '40', price: '101.125', t_ms: 400 });
});

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useSecondAggregates, type SecondAggregates } from './secondAggregates';
import { apiCall } from './client';
vi.mock('./client', () => ({ apiCall: vi.fn() }));

describe('shared seconds query', () => {
  it('keeps bounded interval queries when the backend predates revisions', async () => {
    vi.mocked(apiCall).mockReset();
    vi.mocked(apiCall).mockImplementation(async (path) => ({ bars: [], prices: [],
      seconds: Number(new URL(String(path), 'http://test').searchParams.get('seconds')) }) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useSecondAggregates('005930', 'KRX', '20260930', 123000, false, 10), { wrapper });
    await waitFor(() => expect(view.result.current.data?.seconds).toBe(10));
    expect(apiCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('from_ms=123000');
    expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('include_prices=false');
    view.unmount(); client.clear();
  });
  it('deduplicates different intervals and profile requests, sends revision and applies old corrections', async () => {
    vi.mocked(apiCall).mockReset();
    const start = Date.parse('2026-09-30T09:00:00+09:00');
    const first: SecondAggregates = { code: '005930', venue: 'KRX', date: '20260930', seconds: 1,
      source: 'second_trades', status: 'observed', coverage: 'unverified', storage_error: null,
      first_observed_ms: start, last_observed_ms: start + 1000, revision: 'first', reset: true,
      bars: [100, 110].map((price, i) => ({ t_ms: start + i * 1000, open: price, high: price, low: price, close: price, volume: 2, trade_value: 2 * price, count: 1 })),
      prices: [{ t_ms: start, price: 100, side: 1, qty: 2, count: 1 }] };
    vi.mocked(apiCall).mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first,
      revision: 'second', reset: false, changed_ms: [start], bars: [{ ...first.bars[0], low: 95, close: 95, volume: 5 }],
      prices: [{ t_ms: start, price: 95, side: 1, qty: 5, count: 2 }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => [
      useSecondAggregates('005930', 'KRX', '20260930', start, false, 10),
      useSecondAggregates('005930', 'KRX', '20260930', null, true, 30),
    ], { wrapper });
    await waitFor(() => expect(view.result.current.every(q => q.isSuccess)).toBe(true));
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiCall).mock.calls[0][0]).toContain('seconds=1');
    expect(view.result.current[0].data?.bars[0]).toMatchObject({ open: 100, close: 110, volume: 4 });
    await client.invalidateQueries({ queryKey: ['second-source'] });
    await waitFor(() => expect(view.result.current[0].data?.bars[0].volume).toBe(7));
    expect(apiCall).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiCall).mock.calls[1][0]).toContain('since_revision=first');
    expect(view.result.current[1].data?.prices).toEqual([{ t_ms: start, price: 95, side: 1, qty: 5, count: 2 }]);
    view.unmount(); client.clear();
  });
});

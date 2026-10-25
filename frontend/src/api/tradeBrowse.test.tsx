import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useTradeBrowsePages } from './tradeBrowse';
import { apiCall } from './client';
import type { TradeSpotResponse } from './tradeSpot';
import type { TradeSpotScope } from '../live/tradeSpotScope';

vi.mock('./client', () => ({ apiCall: vi.fn() }));
const T = Date.parse('2026-09-29T09:31:00+09:00');
const scope: TradeSpotScope = { date: '20260929', fromMs: T, toMs: T + 60000, timeframe: '1m', venue: 'KRX', regularSessionOnly: false };
const base: TradeSpotResponse = { code: '005930', date: scope.date, venue: 'KRX', from_ms: T, to_ms: T + 60000,
  source_pref: 'hogaplay', source: 'hogaplay', representation: 'ticks', status: 'observed', coverage: 'unverified',
  storage_error: null, rows: [], prev_close: 100, revision: 'file-1', has_more: false, next_cursor: null, previous_observed_ms: T - 1 };
let client: QueryClient;
afterEach(() => { client?.clear(); vi.mocked(apiCall).mockReset(); });
function mount(initial = base) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useTradeBrowsePages('005930', scope, 'hogaplay', 0, initial), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}
it.each([
  { source: 'kiwoom_live' as const, representation: 'second_price_aggregate' as const },
  { revision: 'file-2' },
])('keeps existing pages and asks for restart when the archive/source is replaced: %j', async replacement => {
  vi.mocked(apiCall).mockResolvedValue({ ...base, from_ms: T - 60000, to_ms: T, previous_observed_ms: null, ...replacement });
  const view = mount();
  await act(async () => { await view.result.current.fetchNextPage(); });
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.result.current.error).toMatchObject({ status: 409 });
  expect(view.result.current.data!.pages).toHaveLength(1);
  vi.mocked(apiCall).mockResolvedValue({ ...base, revision: 'file-2' });
  await act(async () => { await view.result.current.restart(); });
  await waitFor(() => expect(view.result.current.data!.pages[0].data.revision).toBe('file-2'));
  expect(view.result.current.data!.pages).toHaveLength(1);
  expect(vi.mocked(apiCall).mock.calls.at(-1)![0]).not.toContain('cursor=');
  view.unmount();
});
it('WS revisions are range-scoped, so different previous-bar revisions can be appended', async () => {
  const ws = { ...base, source: 'kiwoom_live' as const, representation: 'second_price_aggregate' as const };
  vi.mocked(apiCall).mockResolvedValue({ ...ws, from_ms: T - 60000, to_ms: T, revision: 'other-range', previous_observed_ms: null });
  const view = mount(ws);
  await act(async () => { await view.result.current.fetchNextPage(); });
  await waitFor(() => expect(view.result.current.data!.pages).toHaveLength(2));
  expect(view.result.current.isError).toBe(false);
  view.unmount();
});

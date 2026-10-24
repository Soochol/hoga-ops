import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as api from './client';
import { useLiveRestOrderbook, type RestOrderbookResponse } from './liveRestOrderbook';
import type { LiveVenueOption } from '../state/liveVenue';

afterEach(() => vi.restoreAllMocks());
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const response: RestOrderbookResponse = {
  code: '456160', venue: 'KRX', book: { ask: [{ price: 49600, qty: 43 }], bid: [{ price: 49500, qty: 1 }],
    tot_ask: 2033, tot_bid: 1759, book_time: '20:00:00' }, source: 'kiwoom_rest',
  fetched_at_ms: 1, checked_at_ms: 1, refresh_failed: false, storage_failed: false,
};

it('같은 종목·시장의 창은 마지막 호가 조회를 공유한다', async () => {
  const fetch = vi.spyOn(api, 'apiCall').mockResolvedValue(response);
  const { result } = renderHook(() => [useLiveRestOrderbook('456160', 'KRX', true), useLiveRestOrderbook('456160', 'KRX', true)], { wrapper: wrapper() });
  await waitFor(() => expect(result.current.every(query => query.data?.book?.book_time === '20:00:00')).toBe(true));
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith('/api/live/last-orderbook?code=456160&venue=KRX', { signal: expect.any(AbortSignal) });
});

it('실시간 호가가 있으면 추가 REST 조회를 만들지 않는다', () => {
  const fetch = vi.spyOn(api, 'apiCall');
  const { result } = renderHook(() => useLiveRestOrderbook('456160', 'KRX', false), { wrapper: wrapper() });
  expect(result.current.fetchStatus).toBe('idle');
  expect(fetch).not.toHaveBeenCalled();
});

it('시장 전환 중 이전 시장의 마지막 호가를 노출하지 않는다', async () => {
  const fetch = vi.spyOn(api, 'apiCall').mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response, venue: 'NXT' });
  const { result, rerender } = renderHook(({ venue }) => useLiveRestOrderbook('456160', venue, true),
    { initialProps: { venue: 'KRX' as LiveVenueOption }, wrapper: wrapper() });
  await waitFor(() => expect(result.current.data?.venue).toBe('KRX'));
  rerender({ venue: 'NXT' });
  expect(result.current.data).toBeUndefined();
  await waitFor(() => expect(result.current.data?.venue).toBe('NXT'));
  expect(fetch).toHaveBeenCalledTimes(2);
});

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import * as api from './client';
import { useAftermarketExclusion, type AftermarketExclusionResponse } from './aftermarketExclusion';

const now = Date.parse('2026-10-22T19:30:00+09:00');
const response: AftermarketExclusionResponse = { code: '079650', date: '20261022', status: 'checked',
  reasons: ['investment_warning'], checked_at_ms: now, source: 'kiwoom_ka10100' };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const props = { code: '079650', venue: 'KRX' as 'KRX' | 'NXT', nowMs: now, live: true };
  const hook = renderHook(({ code, venue, nowMs, live }) => useAftermarketExclusion(code, venue, nowMs, live),
    { wrapper, initialProps: props });
  return { ...hook, client, props, wrapper };
}

it('shares one lookup between windows and drops the reason after a failed recheck', async () => {
  const fetch = vi.spyOn(api, 'apiCall').mockResolvedValue(response);
  const { result, client, rerender, props, wrapper } = setup();
  const second = renderHook(() => useAftermarketExclusion('079650', 'KRX', now, true), { wrapper });
  await waitFor(() => expect(result.current?.reasons).toEqual(['investment_warning']));
  await waitFor(() => expect(second.result.current?.reasons).toEqual(['investment_warning']));
  rerender({ ...props });
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockRejectedValue(new Error('offline'));
  await client.invalidateQueries({ queryKey: ['live', 'aftermarket-exclusion'] });
  await waitFor(() => expect(result.current).toBeUndefined());
  await waitFor(() => expect(second.result.current).toBeUndefined());
});

it('never shows the old code, previous day, historical cursor or other venue reason', async () => {
  vi.spyOn(api, 'apiCall').mockResolvedValue(response);
  const { result, props, rerender } = setup();
  await waitFor(() => expect(result.current).toEqual(response));
  rerender({ ...props, code: '005930' });
  expect(result.current).toBeUndefined();
  rerender({ ...props, nowMs: now + 86_400_000 });
  expect(result.current).toBeUndefined();
  rerender({ ...props, live: false });
  expect(result.current).toBeUndefined();
  rerender({ ...props, venue: 'NXT' });
  expect(result.current).toBeUndefined();
  rerender({ ...props, nowMs: now + 120_000 });
  expect(result.current).toBeUndefined();
});

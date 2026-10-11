import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as client from './client';
import { useStockNews } from './stockNews';

afterEach(() => vi.restoreAllMocks());

it('같은 종목·날짜의 창은 요청을 공유하고 다른 종목은 이전 응답을 사용하지 않는다', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url) => ({
    code: new URL(url, 'http://localhost').searchParams.get('code'), date: null, status: 'ok',
    items: [], fetched_at_ms: 1, limit: 40,
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, rerender } = renderHook(({ code, date }) => ({
    first: useStockNews(code, date), second: useStockNews(code, date),
  }), {
    initialProps: { code: '005930', date: null as string | null },
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
  expect(spy).toHaveBeenCalledTimes(1);
  rerender({ code: '000660', date: null });
  expect(result.current.first.data).toBeUndefined();
  await waitFor(() => expect(result.current.second.data?.code).toBe('000660'));
  rerender({ code: '000660', date: '20261007' });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  expect(spy.mock.calls[2][0]).toBe('/api/news/stock?code=000660&date=20261007');
  expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});

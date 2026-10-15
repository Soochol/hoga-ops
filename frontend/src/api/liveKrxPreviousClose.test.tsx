import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLiveKrxPreviousClose } from './liveKrxPreviousClose';
import * as client from './client';

afterEach(() => vi.restoreAllMocks());
function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
const close = { code: '005930', as_of: '20261015', session_date: '20261015', date: '20261014', price: 220000, fetched_at_ms: 1 };

describe('useLiveKrxPreviousClose', () => {
  it('두 창은 거래소와 무관하게 같은 종목·날짜 조회를 공유한다', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(close);
    const { result } = renderHook(() => [useLiveKrxPreviousClose('005930', '20261015'), useLiveKrxPreviousClose('005930', '20261015')], { wrapper: wrapper() });
    await waitFor(() => expect(result.current.every(query => query.data?.price === 220000)).toBe(true));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('/api/live/krx-previous-close?code=005930&as_of=20261015', { signal: expect.any(AbortSignal) });
  });

  it('스팟 모드 등 코드가 없는 상태에서는 조회하지 않는다', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(() => useLiveKrxPreviousClose(null, '20261015'), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('날짜가 바뀌면 이전 종가를 표시하지 않고 새 날짜를 조회한다', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(close).mockResolvedValueOnce({ ...close, as_of: '20261016', date: '20261015', price: 225000 });
    const { result, rerender } = renderHook(({ asOf }) => useLiveKrxPreviousClose('005930', asOf), { initialProps: { asOf: '20261015' }, wrapper: wrapper() });
    await waitFor(() => expect(result.current.data?.price).toBe(220000));
    rerender({ asOf: '20261016' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.price).toBe(225000));
    expect(spy).toHaveBeenLastCalledWith('/api/live/krx-previous-close?code=005930&as_of=20261016', { signal: expect.any(AbortSignal) });
  });
});

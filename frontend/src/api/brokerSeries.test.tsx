import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { useBrokerSeriesForDay } from './brokerSeries';
import * as client from './client';
import type { BrokerSeriesResponse } from './types';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const fakeResponse: BrokerSeriesResponse = {
  date: '20260519',
  brokers: [
    {
      broker: 'JP모간',
      final_net: 79523,
      dominant_side: 'buy',
      points: [{ ts_ms: 1747958400000, net: 79523 }],
    },
  ],
  source: 'hogaplay',
};

describe('useBrokerSeriesForDay', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('disabled when code is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useBrokerSeriesForDay(null, '20260519'),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('disabled when date is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useBrokerSeriesForDay('005930', null),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls /api/brokers/series with correct query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeResponse);
    const { result } = renderHook(
      () => useBrokerSeriesForDay('005930', '20260519'),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      '/api/brokers/series?code=005930&date=20260519',
    );
    expect(result.current.data).toEqual(fakeResponse);
  });

  it('does not refetch when re-rendered with the same (code, date)', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeResponse);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { rerender } = renderHook(
      () => useBrokerSeriesForDay('005930', '20260519'),
      { wrapper },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    rerender();
    expect(spy).toHaveBeenCalledTimes(1);   // staleTime: Infinity holds
  });
});

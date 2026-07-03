import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getLiveTabMetrics,
  liveTabMetricsQueryKey,
  useLiveTabMetricsByCode,
} from './liveTabMetrics';
import * as client from './client';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('live tab metrics API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('dedupes and sorts codes for the batched request and query key', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({ phase: 'open', metrics: [] });

    await getLiveTabMetrics(['005930', '000660', '005930'], 'KRX');

    expect(spy).toHaveBeenCalledWith('/api/live/tab-metrics?codes=000660,005930&venue=KRX');
    expect(liveTabMetricsQueryKey(['005930', '000660', '005930'], 'KRX')).toEqual([
      'live-tab-metrics',
      '000660,005930',
      'KRX',
    ]);
  });

  it('maps tab metrics by code once loaded', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      metrics: [
        {
          code: '005930',
          change_pct: 2.14,
          hoga_ratio_x: 1.32,
          hoga_available: true,
          hoga_reason: null,
          source: 'live',
        },
        {
          code: '000660',
          change_pct: -0.8,
          hoga_ratio_x: 1.11,
          hoga_available: true,
          hoga_reason: null,
          source: 'live',
        },
      ],
    });

    const { result } = renderHook(() => useLiveTabMetricsByCode(['005930', '000660']), { wrapper: wrap() });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('005930')?.change_pct).toBe(2.14);
    expect(result.current.get('000660')?.hoga_ratio_x).toBe(1.11);
  });
});

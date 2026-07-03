import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

  it('keeps last good tab metrics when a transient response returns null fields', async () => {
    const spy = vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({
        phase: 'open',
        metrics: [{
          code: '005930',
          change_pct: 2.14,
          hoga_ratio_x: 1.32,
          hoga_available: true,
          hoga_reason: null,
          source: 'live',
        }],
      })
      .mockResolvedValueOnce({
        phase: 'open',
        metrics: [{
          code: '005930',
          change_pct: null,
          hoga_ratio_x: null,
          hoga_available: false,
          hoga_reason: 'stale',
          source: 'live',
        }],
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useLiveTabMetricsByCode(['005930']), { wrapper });
    await waitFor(() => expect(result.current.get('005930')?.change_pct).toBe(2.14));

    await act(async () => {
      await qc.refetchQueries({ queryKey: liveTabMetricsQueryKey(['005930']) });
    });

    expect(spy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.get('005930')?.hoga_reason).toBe('stale'));
    expect(result.current.get('005930')?.change_pct).toBe(2.14);
    expect(result.current.get('005930')?.hoga_ratio_x).toBe(1.32);
  });

  it('keeps last good tab metrics for requested codes omitted from a transient response', async () => {
    const spy = vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({
        phase: 'open',
        metrics: [{
          code: '005930',
          change_pct: 2.14,
          hoga_ratio_x: 1.32,
          hoga_available: true,
          hoga_reason: null,
          source: 'live',
        }, {
          code: '000660',
          change_pct: 1.11,
          hoga_ratio_x: 1.05,
          hoga_available: true,
          hoga_reason: null,
          source: 'live',
        }],
      })
      .mockResolvedValueOnce({
        phase: 'open',
        metrics: [{
          code: '000660',
          change_pct: -0.8,
          hoga_ratio_x: 1.11,
          hoga_available: true,
          hoga_reason: null,
          source: 'live',
        }],
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useLiveTabMetricsByCode(['005930', '000660']), { wrapper });
    await waitFor(() => expect(result.current.get('005930')?.change_pct).toBe(2.14));

    await act(async () => {
      await qc.refetchQueries({ queryKey: liveTabMetricsQueryKey(['005930', '000660']) });
    });

    expect(spy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.get('000660')?.change_pct).toBe(-0.8));
    expect(result.current.get('005930')?.change_pct).toBe(2.14);
    expect(result.current.get('005930')?.hoga_ratio_x).toBe(1.32);
  });
});

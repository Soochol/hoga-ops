import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  indexCandlesRefetchInterval,
  useLiveIndexCandles,
  useLiveIndexInvestorNet,
  useLiveIndices,
  type LiveIndexCandlesResponse,
} from './liveIndices';
import { usIndexRefreshInterval } from './usIndexRefreshPolicy';
import { liveVenueRefetchInterval } from '../live/liveVenuePolicy';
import * as venuePolicy from '../live/liveVenuePolicy';
import * as client from './client';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveIndices', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('bounds the server poll interval and supports older servers', () => {
    expect(usIndexRefreshInterval()).toBe(60_000);
    expect(usIndexRefreshInterval(2000)).toBe(2000);
    expect(usIndexRefreshInterval(8000)).toBe(8000);
    expect(usIndexRefreshInterval(-1)).toBe(2000);
    expect(usIndexRefreshInterval(Infinity)).toBe(60_000);
    expect(usIndexRefreshInterval(900_000)).toBe(60_000);
  });

  it.each(['D', 'W', 'M', '3m'] as const)('%s keeps loaded candles when an earlier history request returns an empty failure response', async timeframe => {
    const head: LiveIndexCandlesResponse = {
      index_id: 'KOSPI', timeframe, from: '20260601', to: '20260619',
      candles: [{ t_ms: Date.UTC(2026, 5, 19), open: 2800, high: 2810, low: 2790, close: 2805, volume: 100 }],
      data_warnings: [],
    };
    vi.spyOn(client, 'apiCall').mockResolvedValueOnce(head).mockResolvedValueOnce({
      ...head, from: '20260101', candles: [],
      data_warnings: [{ reason: 'index_kis_capacity_overloaded', kind: 'deferred', is_failure: true, msg: 'busy' }],
    });
    const { result, rerender } = renderHook(
      ({ from }) => useLiveIndexCandles('KOSPI', timeframe, from, '20260619'),
      { wrapper: wrap(), initialProps: { from: '20260601' } },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    rerender({ from: '20260101' });
    await waitFor(() => expect(result.current.data?.from).toBe('20260101'));
    expect(result.current.data?.candles).toEqual(head.candles);
    expect(result.current.data?.data_warnings[0].reason).toBe('index_kis_capacity_overloaded');
  });

  it('merges partial failure rows without replacing newer rows or retaining candles outside the requested window', async () => {
    const bar = (day: number, close = 2805) => ({
      t_ms: Date.UTC(2026, 5, day), open: 2800, high: 2810, low: 2790, close, volume: 100,
    });
    const head: LiveIndexCandlesResponse = {
      index_id: 'KOSPI', timeframe: 'D', from: '20260601', to: '20260619',
      candles: [bar(1), bar(19)], data_warnings: [],
    };
    const partial: LiveIndexCandlesResponse = {
      ...head, from: '20260615', candles: [bar(15), bar(19, 2809)],
      data_warnings: [{ batch: '20260615__20260619', reason: 'api_error', is_failure: true, kind: 'vendor_api', msg: 'partial' }],
    };
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce(head).mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ ...partial, candles: [bar(19, 2807)], data_warnings: [] });
    const { result, rerender } = renderHook(
      ({ from }) => useLiveIndexCandles('KOSPI', 'D', from, '20260619'),
      { wrapper: wrap(), initialProps: { from: '20260601' } },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(2));
    rerender({ from: '20260615' });
    await waitFor(() => expect(result.current.data?.from).toBe('20260615'));
    expect(result.current.data?.candles).toEqual([bar(15), bar(19, 2809)]);
    await result.current.refetch();
    await waitFor(() => expect(result.current.data?.candles).toEqual([bar(19, 2807)]));
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not reuse candles from another index or timeframe on failure', async () => {
    const head: LiveIndexCandlesResponse = {
      index_id: 'KOSPI', timeframe: 'D', from: '20260601', to: '20260619',
      candles: [{ t_ms: Date.UTC(2026, 5, 19), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      data_warnings: [],
    };
    vi.spyOn(client, 'apiCall').mockResolvedValueOnce(head).mockResolvedValueOnce({
      ...head, index_id: 'KOSDAQ', candles: [],
      data_warnings: [{ reason: 'api_error', is_failure: true, kind: 'vendor_api', msg: 'busy' }],
    }).mockResolvedValueOnce({
      ...head, timeframe: 'W', candles: [],
      data_warnings: [{ reason: 'api_error', is_failure: true, kind: 'vendor_api', msg: 'busy' }],
    });
    const { result, rerender } = renderHook(
      ({ id, tf }: { id: 'KOSPI' | 'KOSDAQ'; tf: 'D' | 'W' }) => useLiveIndexCandles(id, tf, '20260601', '20260619'),
      { wrapper: wrap(), initialProps: { id: 'KOSPI', tf: 'D' } as { id: 'KOSPI' | 'KOSDAQ'; tf: 'D' | 'W' } },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    rerender({ id: 'KOSDAQ', tf: 'D' });
    await waitFor(() => expect(result.current.data?.index_id).toBe('KOSDAQ'));
    expect(result.current.data?.candles).toEqual([]);
    rerender({ id: 'KOSPI', tf: 'W' });
    await waitFor(() => expect(result.current.data?.timeframe).toBe('W'));
    expect(result.current.data?.candles).toEqual([]);
  });

  it('maps representative index rows from the backend', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      indices: [
        { kind: 'index', id: 'KOSPI', label: 'KOSPI', investor_scope: 'market' },
        { kind: 'index', id: 'KOSPI200', label: 'KOSPI 200', investor_scope: 'none' },
      ],
    });

    const { result } = renderHook(() => useLiveIndices(), { wrapper: wrap() });

    await waitFor(() => expect(result.current.data?.[0]).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
      investorScope: 'market',
    }));
    expect(result.current.data?.[1].investorScope).toBe('none');
    expect(spy).toHaveBeenCalledWith('/api/live/indices', { signal: expect.any(AbortSignal) });
  });

  it('fetches daily index candles for a representative index', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      index_id: 'KOSPI',
      from: '20260601',
      to: '20260619',
      timeframe: 'D',
      candles: [{ t_ms: 1, open: 2840.12, high: 2861.34, low: 2833.2, close: 2855.67, volume: 450000000 }],
      data_warnings: [],
    });

    const { result } = renderHook(
      () => useLiveIndexCandles('KOSPI', 'D', '20260601', '20260619'),
      { wrapper: wrap() },
    );

    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(result.current.data?.candles[0].close).toBe(2855.67);
    expect(spy).toHaveBeenCalledWith(
      '/api/live/index-candles?index_id=KOSPI&timeframe=D&from=20260601&to=20260619',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not fetch index candles until id and range are present', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ candles: [] });

    renderHook(
      () => useLiveIndexCandles(null, 'D', '20260601', '20260619'),
      { wrapper: wrap() },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches market investor net points for a representative index', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      points: [{ t_ms: 1, foreign_net: -3519, institution_net: 17184 }],
      data_warnings: [],
    });

    const { result } = renderHook(
      () => useLiveIndexInvestorNet('KOSPI', '20260619', '20260619', true),
      { wrapper: wrap() },
    );

    await waitFor(() => expect(result.current.data?.points).toHaveLength(1));
    expect(result.current.data?.points[0].foreign_net).toBe(-3519);
    expect(spy).toHaveBeenCalledWith(
      '/api/live/index-investor-net?index_id=KOSPI&from=20260619&to=20260619',
      { signal: expect.any(AbortSignal) },
    );
  });

  // 폴링 게이트 — 장중 여부(liveVenueRefetchInterval)에는 의존하지 않도록,
  // "돌 수 있는 창"은 그 함수와 같은 값인지로만 검증한다(벽시계 flake 방지).
  describe('indexCandlesRefetchInterval', () => {
    const today = '20260729';
    beforeEach(() => vi.spyOn(venuePolicy, 'liveVenueRefetchInterval').mockReturnValue(60_000));

    it('polls a minute timeframe whose window includes today', () => {
      expect(indexCandlesRefetchInterval('1m', today, today)).toBe(liveVenueRefetchInterval('KRX'));
    });

    it('polls the current calendar periods with the same venue gate', () => {
      for (const tf of ['D', 'W', 'M'] as const) {
        expect(indexCandlesRefetchInterval(tf, today, today)).toBe(liveVenueRefetchInterval('KRX'));
      }
    });

    it('keeps the current week/month mutable when to precedes today', () => {
      expect(indexCandlesRefetchInterval('W', '20260727', today)).toBe(liveVenueRefetchInterval('KRX'));
      expect(indexCandlesRefetchInterval('M', '20260701', today)).toBe(liveVenueRefetchInterval('KRX'));
      expect(indexCandlesRefetchInterval('W', '20260726', today)).toBe(false);
      expect(indexCandlesRefetchInterval('M', '20260630', today)).toBe(false);
    });

    it('does not poll a past-only window', () => {
      expect(indexCandlesRefetchInterval('1m', '20260728', today)).toBe(false);
    });

    it('does not poll without a range', () => {
      expect(indexCandlesRefetchInterval('1m', null, today)).toBe(false);
    });

    it('does not poll calendar candles outside the KRX session', () => {
      vi.mocked(venuePolicy.liveVenueRefetchInterval).mockReturnValue(false);
      expect(indexCandlesRefetchInterval('D', today, today)).toBe(false);
    });
  });

  it('does not fetch index investor net until explicitly enabled', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ points: [] });

    renderHook(
      () => useLiveIndexInvestorNet('KOSPI', '20260619', '20260619', false),
      { wrapper: wrap() },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });
});

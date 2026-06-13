import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { useRange, rangeFreshnessOptions, TODAY_RANGE_REFETCH_MS } from './range';
import * as client from './client';
import type { RangeBundle } from './types';
import { useSourcePreferenceStore } from '../state/sourcePreference';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const fakeBundle: RangeBundle = {
  code: '005930', from_date: '20260512', to_date: '20260512', bucket_ms: 60_000,
  segments: [], candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  investorPoints: [],
  ask_peak: null,
};

describe('useRange', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay' });
  });

  it('disabled when any input is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange(null, '20260512', '20260512', '1m'),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls /api/range with correct query string (bucket_ms from Timeframe)', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', '5m'),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('/api/range?code=005930&from=20260512&to=20260512&bucket_ms=300000'),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('appends price_min/price_max when priceRange given', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', { min: 100, max: 200 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&price_min=100&price_max=200');
  });

  it('disabled if timeframe is null even with other inputs', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', null),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('threads sourcePref into the query string and key', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({} as RangeBundle);
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_live' });

    renderHook(
      () => useRange('005930', '20260520', '20260520', '1m'),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(client.apiCall).toHaveBeenCalled());
    const calledWith = (client.apiCall as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
    expect(calledWith).toContain('source_pref=kis_live');
  });
});

describe('rangeFreshnessOptions (review C1 — pastMaxQrT advance)', () => {
  const today = '20260607';

  it('sets the 5-min refetch when the range includes today (to === today)', () => {
    // /live always requests `to = today`, so this is the live-call branch.
    expect(rangeFreshnessOptions(today, today)).toEqual({
      staleTime: TODAY_RANGE_REFETCH_MS,
      refetchInterval: TODAY_RANGE_REFETCH_MS,
    });
  });

  it('sets the 5-min refetch when the range extends past today (to > today)', () => {
    expect(rangeFreshnessOptions('20260610', today)).toEqual({
      staleTime: TODAY_RANGE_REFETCH_MS,
      refetchInterval: TODAY_RANGE_REFETCH_MS,
    });
  });

  it('freezes (Infinity, no refetch) for a past-only range (to < today)', () => {
    expect(rangeFreshnessOptions('20260606', today)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
    });
  });

  it('freezes when no todayKst is given — non-live callers stay frozen', () => {
    // capture/replay backfill omit todayKst entirely; the refetch must not leak.
    expect(rangeFreshnessOptions('20260606', null)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
    });
  });

  it('freezes when to is null (query disabled)', () => {
    expect(rangeFreshnessOptions(null, today)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
    });
  });
});

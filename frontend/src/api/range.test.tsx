import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import {
  buildRangeBundleRequest,
  useRange,
  rangeBundleQueryOptions,
  rangeFreshnessOptions,
  rangePlaceholderData,
  TODAY_RANGE_REFETCH_MS,
} from './range';
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
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

describe('buildRangeBundleRequest', () => {
  it('projects one request shape into enabled, URL params, and query key', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      priceRange: { min: 100, max: 200 },
      todayKst: '20260512',
      sourcePref: 'kis_ws_first',
      options: {
        brokerLateEntryStartHHMM: 945,
        volumeDistributionBins: 12,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
        tradeVolumePocBins: 12,
      },
    });

    expect(request.enabled).toBe(true);
    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000'
        + '&price_min=100&price_max=200'
        + '&broker_late_entry_start_hhmm=945'
        + '&volume_distribution_bins=12'
        + '&volume_distribution_price_min=69900&volume_distribution_price_max=70100'
        + '&trade_volume_poc_bins=12'
        + '&source_pref=kis_ws_first',
    );
    expect(request.queryKey).toEqual([
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      100,
      200,
      945,
      12,
      69900,
      70100,
      12,
      'kis_ws_first',
    ]);
  });

  it('keeps disabled requests representable without optional params', () => {
    const request = buildRangeBundleRequest({
      code: null,
      from: '20260512',
      to: '20260512',
      timeframe: null,
      sourcePref: 'hogaplay_first',
    });

    expect(request.enabled).toBe(false);
    expect(request.url).toBe('/api/range?from=20260512&to=20260512&source_pref=hogaplay_first');
    expect(request.queryKey).toEqual([
      'range',
      null,
      '20260512',
      '20260512',
      null,
      undefined,
      undefined,
      null,
      null,
      undefined,
      undefined,
      null,
      'hogaplay_first',
    ]);
  });
});

describe('rangeBundleQueryOptions', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('builds reusable range query options with an abortable query function', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const options = rangeBundleQueryOptions({
      code: '005930',
      from: '20260616',
      to: '20260618',
      timeframe: '5m',
      todayKst: null,
      sourcePref: 'hogaplay_first',
      options: {
        volumeDistributionBins: 12,
        tradeVolumePocBins: 12,
        volumeDistributionPriceRange: null,
      },
    });

    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual([
      'range',
      '005930',
      '20260616',
      '20260618',
      300_000,
      undefined,
      undefined,
      null,
      12,
      undefined,
      undefined,
      12,
      'hogaplay_first',
    ]);

    const signal = new AbortController().signal;
    const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<RangeBundle>;
    await queryFn({ signal });
    expect(spy).toHaveBeenCalledWith(
      '/api/range?code=005930&from=20260616&to=20260618&bucket_ms=300000&volume_distribution_bins=12&trade_volume_poc_bins=12&source_pref=hogaplay_first',
      { signal },
    );
  });
});

describe('useRange', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });
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
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_api_first' });

    renderHook(
      () => useRange('005930', '20260520', '20260520', '1m'),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(client.apiCall).toHaveBeenCalled());
    const calledWith = (client.apiCall as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
    expect(calledWith).toContain('source_pref=kis_api_first');
  });

  it('omits volume_distribution_bins when not requested', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m'),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).not.toContain('volume_distribution_bins=');
    expect(spy.mock.calls[0][0]).not.toContain('trade_volume_poc_bins=');
  });

  it('threads volume_distribution_bins into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { volumeDistributionBins: 20 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_bins=20');
  });

  it('threads volume_distribution_price_min/max into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, {
        volumeDistributionBins: 10,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_price_min=69900&volume_distribution_price_max=70100');
  });

  it('threads trade_volume_poc_bins into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { tradeVolumePocBins: 12 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&trade_volume_poc_bins=12');
  });

  it('threads broker_late_entry_start_hhmm into query string and query key', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { rerender } = renderHook(
      ({ brokerLateEntryStartHHMM }) => useRange(
        '005930',
        '20260512',
        '20260512',
        '1m',
        undefined,
        null,
        { brokerLateEntryStartHHMM },
      ),
      {
        wrapper: makeWrapper(),
        initialProps: { brokerLateEntryStartHHMM: 945 },
      },
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toContain('&broker_late_entry_start_hhmm=945');

    rerender({ brokerLateEntryStartHHMM: 950 });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toContain('&broker_late_entry_start_hhmm=950');
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

describe('rangePlaceholderData', () => {
  const baseKey: Parameters<typeof rangePlaceholderData>[1] = [
    'range',
    '005930',
    '20260512',
    '20260512',
    60_000,
    undefined,
    undefined,
    930,
    null,
    undefined,
    undefined,
    null,
    'hogaplay_first',
  ];

  it('keeps previous same-code data for date extension when option-sensitive fields are unchanged', () => {
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260510',
      '20260512',
      60_000,
      undefined,
      undefined,
      930,
      null,
      undefined,
      undefined,
      null,
      'hogaplay_first',
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBe(fakeBundle);
  });

  it('drops previous broker late-entry events when the threshold option changes', () => {
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      945,
      null,
      undefined,
      undefined,
      null,
      'hogaplay_first',
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBeUndefined();
  });
});

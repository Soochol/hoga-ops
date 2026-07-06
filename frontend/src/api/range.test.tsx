import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import {
  buildRangeBundleRequest,
  mergeRangeBundles,
  planSidecarRangeDelta,
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
        mode: 'full',
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
        + '&source_pref=kis_ws_first&mode=full',
    );
    expect(request.queryKey).toEqual([
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      100,
      200,
      null,
      945,
      12,
      69900,
      70100,
      12,
      'kis_ws_first',
      'full',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('adds mode=hoga only for the lightweight hoga request', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'hogaplay_first',
      options: { mode: 'hoga' },
    });

    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000'
        + '&source_pref=hogaplay_first&mode=hoga',
    );
    expect(request.queryKey[14]).toBe('hoga');
    expect(request.queryKey.at(-1)).toBe(null);
  });

  it('adds mode=sidecar for overlay sidecar requests', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'hogaplay_first',
      options: { mode: 'sidecar' },
    });

    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512'
        + '&bucket_ms=60000&source_pref=hogaplay_first&mode=sidecar',
    );
    expect(request.queryKey[14]).toBe('sidecar');
    expect(request.queryKey.at(-1)).toBe(null);
  });

  it('threads sidecar indicator gates into the URL params and query key', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'hogaplay_first',
      options: {
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: false,
        tradeVolumePocEnabled: false,
      },
    });

    expect(request.url).toContain('&ask_peaks_enabled=false');
    expect(request.url).toContain('&bid_peaks_enabled=false');
    expect(request.url).toContain('&program_trade_enabled=false');
    expect(request.url).toContain('&trade_volume_poc_enabled=false');
    expect(request.queryKey.slice(-4)).toEqual([false, false, false, false]);
  });

  it('adds mode=candles for lightweight candle requests', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260625',
      to: '20260705',
      timeframe: '3m',
      sourcePref: 'hogaplay_first',
      options: { mode: 'candles' },
    });

    expect(request.enabled).toBe(true);
    expect(request.url).toBe(
      '/api/range?code=005930&from=20260625&to=20260705'
        + '&bucket_ms=180000&source_pref=hogaplay_first&mode=candles',
    );
    expect(request.queryKey[14]).toBe('candles');
    expect(request.queryKey.at(-1)).toBe(null);
  });

  it('includes volumeDistributionCutoffMs in the range query key', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260625',
      to: '20260625',
      timeframe: '1m',
      sourcePref: 'hogaplay_first',
      options: {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      },
    });

    expect(request.queryKey).toContain(1_772_000_001_000);
  });

  it('can explicitly disable broker late-entry events', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'hogaplay_first',
      options: { mode: 'full', brokerLateEntriesEnabled: false },
    });

    expect(request.url).toContain('&broker_late_entries_enabled=false');
    expect(request.queryKey[7]).toBe(false);
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
      null,
      undefined,
      undefined,
      null,
      'hogaplay_first',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('disables complete-looking requests when mode is omitted', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'hogaplay_first',
    });

    expect(request.enabled).toBe(false);
    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512'
        + '&bucket_ms=60000&source_pref=hogaplay_first',
    );
    expect(request.queryKey[14]).toBe(null);
    expect(request.queryKey.at(-1)).toBe(null);
  });
});

describe('planSidecarRangeDelta', () => {
  const previous: RangeBundle = {
    ...fakeBundle,
    code: '005930',
    from_date: '20260629',
    to_date: '20260706',
    bucket_ms: 60_000,
  };

  it('plans only the missing left delta for compatible live sidecar ranges', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'hogaplay_first',
      options: {
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: true,
        tradeVolumePocEnabled: true,
        volumeDistributionBins: 10,
        tradeVolumePocBins: 10,
        volumeDistributionPriceRange: { min: 303000, max: 325000 },
      },
    }, previous);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });

  it('serves previous data without fetching when the requested range is already covered', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260629',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'hogaplay_first',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }, previous);

    expect(plan.enabled).toBe(false);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe(null);
    expect(plan.requestInput.to).toBe(null);
  });

  it('falls back to full request when to-date changes', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260707',
      timeframe: '1m',
      todayKst: '20260707',
      sourcePref: 'hogaplay_first',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }, previous);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260707');
  });

  it('does not delta-plan cutoff sidecar profile requests', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260624',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'hogaplay_first',
      options: {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      },
    }, previous);

    expect(plan.canReusePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260624');
  });
});

describe('mergeRangeBundles', () => {
  it('merges sidecar arrays by stable date/key and keeps chronological order', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      segments: [{ date: '20260629', session_open_ms: 1, session_close_ms: 2, source: 'hogaplay' }],
      ask_peaks: [{ date: '20260629', price: 10, qty: 1, t_ms: 1, max_price: 10, max_qty: 1, max_t_ms: 1 }],
      bid_peaks: [{ date: '20260629', price: 9, qty: 1, t_ms: 1, max_price: 9, max_qty: 1, max_t_ms: 1 }],
      broker_late_entries: [{ t_ms: 2, broker: 'NH투자증권', side: 'buy', net: 100 }],
      trade_volume_pocs: [{ date: '20260629', center_price: 10, low_price: 9, high_price: 11, qty: 1, t_ms: 1, band_pct: 0.005 }],
      volume_distributions: [{
        date: '20260629',
        range_count: 10,
        price_min: 9,
        price_max: 11,
        session_open_ms: 1,
        session_close_ms: 2,
        bins: [{ price_low: 9, price_high: 10, qty: 1 }],
      }],
      program_trade: {
        source: 'kis_program_trade',
        points: [{ t: 2, net_qty: 10, net_amount: 100, delta_qty: 10, delta_amount: 100, gap_risk: false }],
      },
    };
    const next: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      segments: [{ date: '20260624', session_open_ms: 3, session_close_ms: 4, source: 'hogaplay' }],
      ask_peaks: [{ date: '20260624', price: 8, qty: 1, t_ms: 3, max_price: 8, max_qty: 1, max_t_ms: 3 }],
      bid_peaks: [{ date: '20260624', price: 7, qty: 1, t_ms: 3, max_price: 7, max_qty: 1, max_t_ms: 3 }],
      broker_late_entries: [{ t_ms: 1, broker: 'NH투자증권', side: 'sell', net: -50 }],
      trade_volume_pocs: [{ date: '20260624', center_price: 8, low_price: 7, high_price: 9, qty: 1, t_ms: 3, band_pct: 0.005 }],
      volume_distributions: [{
        date: '20260624',
        range_count: 10,
        price_min: 7,
        price_max: 9,
        session_open_ms: 3,
        session_close_ms: 4,
        bins: [{ price_low: 7, price_high: 8, qty: 1 }],
      }],
      program_trade: {
        source: 'kis_program_trade',
        points: [{ t: 1, net_qty: 5, net_amount: 50, delta_qty: 5, delta_amount: 50, gap_risk: false }],
      },
    };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.from_date).toBe('20260624');
    expect(merged.to_date).toBe('20260706');
    expect(merged.segments.map((s) => s.date)).toEqual(['20260624', '20260629']);
    expect(merged.ask_peaks.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.bid_peaks?.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.trade_volume_pocs?.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.volume_distributions.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.broker_late_entries.map((e) => e.t_ms)).toEqual([1, 2]);
    expect(merged.program_trade?.points.map((p) => p.t)).toEqual([1, 2]);
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
        mode: 'full',
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
      null,
      12,
      undefined,
      undefined,
      12,
      'hogaplay_first',
      'full',
      null,
      null,
      null,
      null,
      null,
    ]);

    const signal = new AbortController().signal;
    const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<RangeBundle>;
    await queryFn({ signal });
    expect(spy).toHaveBeenCalledWith(
      '/api/range?code=005930&from=20260616&to=20260618&bucket_ms=300000&volume_distribution_bins=12&trade_volume_poc_bins=12&source_pref=hogaplay_first&mode=full',
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
      () => useRange('005930', '20260512', '20260512', '5m', undefined, undefined, { mode: 'full' }),
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
      () => useRange('005930', '20260512', '20260512', '1m', { min: 100, max: 200 }, undefined, { mode: 'full' }),
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

  it('disabled if mode is omitted even with complete inputs', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', '1m'),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('threads sourcePref into the query string and key', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({} as RangeBundle);
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_api_first' });

    renderHook(
      () => useRange('005930', '20260520', '20260520', '1m', undefined, undefined, { mode: 'full' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(client.apiCall).toHaveBeenCalled());
    const calledWith = (client.apiCall as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
    expect(calledWith).toContain('source_pref=kis_api_first');
  });

  it('allows a caller to override the global source preference for one range query', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({} as RangeBundle);
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_api_first' });

    renderHook(
      () => useRange(
        '005930',
        '20260520',
        '20260520',
        '1m',
        undefined,
        undefined,
        { mode: 'full' },
        'hogaplay_first',
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(client.apiCall).toHaveBeenCalled());
    const calledWith = (client.apiCall as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
    expect(calledWith).toContain('source_pref=hogaplay_first');
  });

  it('omits volume_distribution_bins when not requested', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, undefined, { mode: 'full' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).not.toContain('volume_distribution_bins=');
    expect(spy.mock.calls[0][0]).not.toContain('trade_volume_poc_bins=');
  });

  it('threads volume_distribution_bins into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { mode: 'full', volumeDistributionBins: 20 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_bins=20');
  });

  it('threads volume_distribution_cutoff_ms into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260625', '20260625', '1m', undefined, null, {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_cutoff_ms=1772000001000');
  });

  it('threads volume_distribution_price_min/max into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, {
        volumeDistributionBins: 10,
        mode: 'full',
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
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { mode: 'full', tradeVolumePocBins: 12 }),
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
        { mode: 'full', brokerLateEntryStartHHMM },
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
    null,
    930,
    null,
    undefined,
    undefined,
    null,
    'hogaplay_first',
    'full',
    null,
    null,
    null,
    null,
    null,
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
      null,
      930,
      null,
      undefined,
      undefined,
      null,
      'hogaplay_first',
      'full',
      null,
      null,
      null,
      null,
      null,
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
      null,
      945,
      null,
      undefined,
      undefined,
      null,
      'hogaplay_first',
      'full',
      null,
      null,
      null,
      null,
      null,
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBeUndefined();
  });

  it('drops previous sidecar data when the volume distribution cutoff changes', () => {
    const previousKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      null,
      10,
      undefined,
      undefined,
      null,
      'hogaplay_first',
      'sidecar',
      1_772_000_001_000,
      null,
      null,
      null,
      null,
    ];
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      null,
      10,
      undefined,
      undefined,
      null,
      'hogaplay_first',
      'sidecar',
      null,
      null,
      null,
      null,
      null,
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, previousKey)).toBeUndefined();
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import * as client from '../api/client';
import type { RangeBundle } from '../api/types';
import { seedSymbolMaster } from './seedSymbolMaster';
import type { LiveRangeRequestPlan } from './useLiveBundle';
import { useLiveSidecars } from './useLiveSidecars';

vi.mock('../state/sourcePreference', async (original) => ({
  ...(await original<typeof import('../state/sourcePreference')>()),
  useOrderflowSourcePref: () => 'kiwoom_live',
}));

const PLAN: LiveRangeRequestPlan = {
  code: '005930', from: '20260901', to: '20260904', timeframe: '1m', todayKst: '20260904',
  options: {
    askPeaksEnabled: true, bidPeaksEnabled: true, depthHeatmapEnabled: true,
    brokerLateEntriesEnabled: false, brokerLateEntryStartHHMM: null, programTradeEnabled: true,
    tradeVolumePocEnabled: true, tradeVolumePocBins: 10, volumeDistributionBins: 10,
    volumeDistributionPriceRange: null,
    barPeaksEnabled: false, allBarPeaksEnabled: false, unreachedBarPeaksEnabled: false,
  },
};
const EMPTY: RangeBundle = {
  code: '005930', from_date: '20260901', to_date: '20260904', bucket_ms: 60_000,
  segments: [], candles: [], quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [], volume_distributions: [], investorPoints: [],
  ask_peaks: [], bid_peaks: [], broker_late_entries: [],
};
const INDEPENDENT: RangeBundle = {
  ...EMPTY,
  ask_peaks: [{ date: '20260904', price: 100, qty: 10, t_ms: 1,
    max_price: 100, max_qty: 10, max_t_ms: 1 }],
  program_trade: { points: [{ t: 1, net_qty: 20, net_amount: 2000, gap_risk: false }] },
};
const PRICE: RangeBundle = {
  ...EMPTY,
  volume_distributions: [{ date: '20260904', range_count: 1, price_min: 100, price_max: 200,
    session_open_ms: 1, session_close_ms: 2, bins: [{ price_low: 100, price_high: 200, qty: 10 }] }],
};

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(qc);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('split sidecars through real delta queries', () => {
  it('starts independent I/O before price, preserves its result when only price changes, and merges both', async () => {
    const { qc, wrapper } = setup();
    let completePrice!: (value: RangeBundle) => void;
    const priceResponse = new Promise<RangeBundle>((resolve) => { completePrice = resolve; });
    const calls = vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      const params = new URL(String(url), 'http://local').searchParams;
      return (params.has('volume_distribution_bins') ? priceResponse : Promise.resolve(INDEPENDENT)) as never;
    });
    const { result, rerender, unmount } = renderHook(
      ({ plan, waiting }) => useLiveSidecars(plan, waiting),
      { initialProps: { plan: PLAN, waiting: true }, wrapper },
    );
    await waitFor(() => expect(result.current.data?.ask_peaks).toEqual(INDEPENDENT.ask_peaks));
    expect(calls).toHaveBeenCalledTimes(1);
    expect(String(calls.mock.calls[0][0])).not.toContain('volume_distribution_price');
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data?.from_date).toBe(PLAN.to);
    const priced = { ...PLAN, options: { ...PLAN.options, volumeDistributionPriceRange: { min: 100, max: 200 } } };
    rerender({ plan: priced, waiting: false });
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
    expect(result.current.data?.program_trade).toEqual(INDEPENDENT.program_trade);
    expect(result.current.isHistoricalDeltaFetching).toBe(true);
    await act(async () => completePrice(PRICE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.volume_distributions).toEqual(PRICE.volume_distributions);
    expect(result.current.data?.ask_peaks).toEqual(INDEPENDENT.ask_peaks);
    expect(result.current.data?.from_date).toBe(PLAN.from);
    rerender({ plan: { ...priced, options: { ...priced.options,
      volumeDistributionPriceRange: { min: 90, max: 210 } } }, waiting: false });
    // 기존 delta 계약: 움직이는 가격 범위는 promotion/주기 갱신 때 반영한다.
    expect(calls).toHaveBeenCalledTimes(2);
    rerender({ plan: { ...priced, options: { ...priced.options, volumeDistributionBins: 15 } }, waiting: false });
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(3));
    expect(calls.mock.calls.filter(([url]) => !String(url).includes('volume_distribution_bins'))).toHaveLength(1);
    unmount(); qc.clear();
  });

  it('settles a failed price lane without dropping successful independent data', async () => {
    const { qc, wrapper } = setup();
    const error = new Error('price request failed');
    vi.spyOn(client, 'apiCall').mockImplementation((url) => (
      String(url).includes('volume_distribution_bins') ? Promise.reject(error) : Promise.resolve(INDEPENDENT)
    ) as never);
    const { result, unmount } = renderHook(() => useLiveSidecars(PLAN, false), { wrapper });
    await waitFor(() => expect(result.current.error).toBe(error));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data?.ask_peaks).toEqual(INDEPENDENT.ask_peaks);
    expect(result.current.data?.volume_distributions).toEqual([]);
    unmount(); qc.clear();
  });

  it('cancels both in-flight lanes on a code switch and never serves the previous code', async () => {
    const { qc, wrapper } = setup();
    const pending: AbortSignal[] = [];
    vi.spyOn(client, 'apiCall').mockImplementation((url, options) => {
      if (String(url).includes('code=005930')) {
        pending.push(options!.signal!);
        return new Promise(() => {}) as never;
      }
      return Promise.resolve({ ...EMPTY, code: '000660' }) as never;
    });
    const { result, rerender, unmount } = renderHook(
      ({ code }) => useLiveSidecars({ ...PLAN, code }, false),
      { initialProps: { code: '005930' }, wrapper },
    );
    await waitFor(() => expect(pending).toHaveLength(2));
    rerender({ code: '000660' });
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data?.code).toBe('000660'));
    expect(pending.every((signal) => signal.aborted)).toBe(true);
    unmount(); qc.clear();
  });
});

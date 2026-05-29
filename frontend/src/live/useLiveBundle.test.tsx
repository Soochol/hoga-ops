import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLiveBundle } from './useLiveBundle';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';

vi.mock('../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: { session_open_ms: 1779840000000, session_close_ms: 1779863400000 },
    isLoading: false,
    error: null,
    ob: [
      { t_ms: 1779840060000, total_ask_qty: 100, total_bid_qty: 80, kind: 'ob' },
    ],
    trade: [],
    broker: [],
  }),
}));

const livePastCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930',
    from: '',
    to: '',
    candles: [
      { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ],
    cached_dates: [],
    fresh_dates: [],
    data_warnings: [],
  },
  isLoading: false,
  error: null,
}));
vi.mock('../api/livePastCandles', () => ({
  useLivePastCandles: (...args: unknown[]) => livePastCandlesSpy(...args as []),
}));

const livePastDailyCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930',
    from: '',
    to: '',
    candles: [
      { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ],
    cached_batches: [],
    fresh_batches: [],
    data_warnings: [],
  },
  isLoading: false,
  error: null,
}));
vi.mock('../api/livePastDailyCandles', () => ({
  useLivePastDailyCandles: (...args: unknown[]) => livePastDailyCandlesSpy(...args as []),
}));

const useRangeSpy = vi.fn(() => ({ data: null, isLoading: false, error: null }));
vi.mock('../api/range', () => ({
  useRange: (...args: unknown[]) => useRangeSpy(...args as []),
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('useLiveBundle', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastDailyCandlesSpy.mockClear();
    useRangeSpy.mockClear();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_live' });
  });

  it('builds a today-only bundle when historicalFromDate is null', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(result.current.bundle!.segments.length).toBe(1);
    expect(result.current.bundle!.segments[0].source).toBe('kis_live');
    expect(result.current.bundle!.candles.length).toBe(1);
    expect(result.current.bundle!.quote_ratio.points.length).toBe(1);
  });

  it('returns null bundle when code is null', () => {
    const { result } = renderHook(() => useLiveBundle(null, '1m', '20260527'), { wrapper });
    expect(result.current.bundle).toBeNull();
  });

  it('clamps pastFrom to 249 days before today when historicalFromDate is older', () => {
    useLivePageStore.setState({ historicalFromDate: '20250101' });
    renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(livePastCandlesSpy).toHaveBeenCalledWith('005930', '20250920', '20260527');
    expect(useRangeSpy).toHaveBeenCalledWith('005930', '20250920', '20260527', '1m');
  });

  it('exposes clampEngaged=true when historicalFromDate older than 250 days', () => {
    useLivePageStore.setState({ historicalFromDate: '20250101' });
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(result.current.clampEngaged).toBe(true);
  });

  it('maps KIS bar shape to wire Candle shape (vol_a = volume, vol_b = 0)', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    const c = result.current.bundle!.candles[0];
    expect(c).toMatchObject({ ts_ms: 1779840000000, open: 70000, vol_a: 1000, vol_b: 0 });
    expect(c).not.toHaveProperty('t_ms');
    expect(c).not.toHaveProperty('volume');
  });
});

describe('useLiveBundle daily/minute branching (ADR-0048)', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastDailyCandlesSpy.mockClear();
    useRangeSpy.mockClear();
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_live' });
  });

  it('D timeframe calls daily hook with non-null code, minute hook with null code', () => {
    renderHook(() => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    const lastDailyCall = livePastDailyCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastDailyCall[0]).toBe('005930');
    const lastMinuteCall = livePastCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastMinuteCall[0]).toBeNull();
  });

  it('1m timeframe calls minute hook with non-null code, daily hook with null code', () => {
    renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    const lastMinuteCall = livePastCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastMinuteCall[0]).toBe('005930');
    const lastDailyCall = livePastDailyCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastDailyCall[0]).toBeNull();
  });

  it('clampEngaged is false on D when historicalFromDate is very old', () => {
    useLivePageStore.setState({ historicalFromDate: '20100101' });
    const { result } = renderHook(() => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    expect(result.current.clampEngaged).toBe(false);
  });

  it('clampEngaged is true on 1m when historicalFromDate is older than 250d', () => {
    useLivePageStore.setState({ historicalFromDate: '20100101' });
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    expect(result.current.clampEngaged).toBe(true);
  });

  it('maps minute-path KIS warnings (rate_limit / rate_limit_aborted) into bundle.data_warnings', () => {
    livePastCandlesSpy.mockReturnValueOnce({
      data: {
        code: '005930',
        from: '',
        to: '',
        candles: [
          { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
        ],
        cached_dates: [],
        fresh_dates: [],
        data_warnings: [
          { date: '20260520', reason: 'kis_rate_limit', msg: 'EGW00201 rate limited' },
          { date: '20260521', reason: 'rate_limit_aborted', msg: 'previous date hit rate limit' },
        ],
      },
      isLoading: false,
      error: null,
    } as ReturnType<typeof livePastCandlesSpy>);
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527'), { wrapper });
    const warnings = result.current.bundle?.data_warnings ?? [];
    expect(warnings.map((w) => w.date)).toEqual(['20260520', '20260521']);
    expect(warnings[0].warnings[0].invariant_id).toBe('kis_rate_limit');
    expect(warnings[1].warnings[0].invariant_id).toBe('rate_limit_aborted');
  });

  it('surfaces batch-level daily warnings under the batch FROM date', () => {
    livePastDailyCandlesSpy.mockReturnValueOnce({
      data: {
        code: '005930',
        from: '',
        to: '',
        candles: [],
        cached_batches: [],
        fresh_batches: [],
        data_warnings: [
          // No `date` field — only batch label. The fallback should map this
          // onto 20240301 (the batch's FROM) so the banner shows it.
          {
            batch: '20240301__20240315',
            reason: 'kis_rate_limit' as const,
            msg: 'EGW00201 rate limited',
          },
        ],
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof livePastDailyCandlesSpy>);
    const { result } = renderHook(() => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    const warnings = result.current.bundle?.data_warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0].date).toBe('20240301');
    expect(warnings[0].warnings[0].invariant_id).toBe('kis_rate_limit');
  });

  it('maps daily invariant_violation warnings into bundle.data_warnings (DateWarning shape)', () => {
    livePastDailyCandlesSpy.mockReturnValueOnce({
      data: {
        code: '005930',
        from: '',
        to: '',
        candles: [
          { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
        ],
        cached_batches: [],
        fresh_batches: [],
        data_warnings: [
          {
            batch: '20240103__20240103',
            date: '20240103',
            reason: 'invariant_violation' as const,
            msg: '20240103: close_nonpositive (close=0)',
          },
        ],
      },
      isLoading: false,
      error: null,
    } as ReturnType<typeof livePastDailyCandlesSpy>);
    const { result } = renderHook(() => useLiveBundle('005930', 'D', '20260527'), { wrapper });
    const warnings = result.current.bundle?.data_warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0].date).toBe('20240103');
    expect(warnings[0].warnings).toHaveLength(1);
    expect(warnings[0].warnings[0].invariant_id).toBe('invariant_violation');
    expect(warnings[0].warnings[0].severity).toBe('warn');
  });
});

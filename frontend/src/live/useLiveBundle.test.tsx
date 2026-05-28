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

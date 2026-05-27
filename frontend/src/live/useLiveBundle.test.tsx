import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLiveBundle } from './useLiveBundle';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';

vi.mock('../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: { session_open_ms: 1748275200000, session_close_ms: 1748298600000 },
    isLoading: false,
    error: null,
    ob: [
      { t_ms: 1748275260000, total_ask_qty: 100, total_bid_qty: 80, kind: 'ob' },
    ],
    trade: [],
    broker: [],
  }),
}));

vi.mock('../api/liveCandles', () => ({
  useLiveCandles: () => ({
    candles: [
      { t_ms: 1748275200000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ],
  }),
}));

vi.mock('../api/range', () => ({
  useRange: () => ({ data: null, isLoading: false, error: null }),
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('useLiveBundle', () => {
  beforeEach(() => {
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
});

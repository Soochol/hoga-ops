import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// jsdom does not implement ResizeObserver — provide a no-op stub before the
// component module is loaded so the useEffect doesn't throw.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Importing ./tabs registers the active tab prefs store as a side effect,
// required by RangeSeriesPane's projectors (useActivePrefs).
import '../state/tabs';
import { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { useLiveBundle } from './useLiveBundle';
import { createChart } from 'lightweight-charts';

vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChart: vi.fn(() => ({
      addSeries: vi.fn(() => ({
        setData: vi.fn(),
        update: vi.fn(),
        removeSeries: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn(),
        detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(),
        unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(),
        fitContent: vi.fn(),
        scrollToRealTime: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    })),
  };
});

vi.mock('./useLiveBundle', () => ({
  useLiveBundle: vi.fn(() => ({
    bundle: {
      code: '005930',
      from_date: '20260527',
      to_date: '20260527',
      bucket_ms: 60_000,
      segments: [
        { date: '20260527', session_open_ms: 1748275200000, session_close_ms: 1748298600000, source: 'kis_live' },
      ],
      candles: [],
      quote_ratio: { bucket_ms: 60_000, points: [] },
      fill_strength: { bucket_ms: 60_000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
    },
    isLoading: false,
    error: null,
  })),
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('LiveChartRoot', () => {
  it('renders root container with chart slot', () => {
    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });
    expect(screen.getByTestId('live-chart-root')).toBeTruthy();
  });

  it('shows D/W/M hoga indicator empty-state notice on D timeframe', () => {
    render(<LiveChartRoot code="005930" timeframe="D" />, { wrapper });
    expect(screen.getByTestId('indicator-disabled-note')).toBeTruthy();
  });

  it('hides D/W/M empty-state notice on minute timeframes', () => {
    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });
    expect(screen.queryByTestId('indicator-disabled-note')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lazy fetch trigger — eng review C2/C3 regression coverage
// ---------------------------------------------------------------------------

// 2026-05-27 00:00 UTC = 09:00 KST (matches the buildLiveBundle test convention).
const TODAY_OPEN_MS = Date.UTC(2026, 4, 27, 0, 0, 0);
const TODAY_CLOSE_MS = TODAY_OPEN_MS + 6.5 * 3600 * 1000;
const YESTERDAY_OPEN_MS = TODAY_OPEN_MS - 86_400_000;
const YESTERDAY_CLOSE_MS = YESTERDAY_OPEN_MS + 6.5 * 3600 * 1000;

const DEFAULT_TODAY_ONLY_BUNDLE = {
  bundle: {
    code: '005930',
    from_date: '20260527',
    to_date: '20260527',
    bucket_ms: 60_000,
    segments: [
      { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kis_live' as const },
    ],
    candles: [],
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
  },
  isLoading: false,
  error: null,
};

describe('LiveChartRoot lazy fetch trigger', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null });
    vi.useFakeTimers();
    // Freeze system time so todayKstYyyymmdd() inside LiveChartRoot returns
    // '20260527' deterministically — the initial-boundary comparison uses that
    // value, and the test segments are dated relative to it.
    vi.setSystemTime(TODAY_OPEN_MS);
    // Reset to today-only default; individual tests override as needed.
    vi.mocked(useLiveBundle).mockReturnValue(DEFAULT_TODAY_ONLY_BUNDLE as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT fire extendHistoricalRange when logical from is inside loaded data', () => {
    // logical.from >= 0 means the visible-range origin is inside loaded
    // bars — no extension needed.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });

    expect(handlers.length).toBeGreaterThan(0);
    act(() => {
      handlers.forEach((h) => h({ from: 10.5, to: 200.5 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('does NOT fire extendHistoricalRange when multi-segment axis is still inside loaded bars', () => {
    // Yesterday (today - 1) is comfortably inside the 20-day initial window,
    // so scrolling there is already covered by the seeded fetch and must NOT
    // trigger an additional extension.
    vi.mocked(useLiveBundle).mockReturnValue({
      bundle: {
        code: '005930',
        from_date: '20260526',
        to_date: '20260527',
        bucket_ms: 60_000,
        segments: [
          { date: '20260526', session_open_ms: YESTERDAY_OPEN_MS, session_close_ms: YESTERDAY_CLOSE_MS, source: 'kis_live' },
          { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kis_live' },
        ],
        candles: [],
        quote_ratio: { bucket_ms: 60_000, points: [] },
        fill_strength: { bucket_ms: 60_000, points: [] },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [],
      },
      isLoading: false,
      error: null,
    });

    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });

    act(() => {
      handlers.forEach((h) => h({ from: 1000, to: 2000 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('fires extendHistoricalRange with one chunk past current earliest when logical from goes negative', () => {
    // Axis with yesterday + today. lightweight-charts emits negative
    // logical.from when the visible-range origin is past the leftmost
    // loaded bar (fractional bar index can go negative beyond the data).
    // Handler should prepend PREFETCH_CHUNK_DAYS more past data from the
    // current earliest segment.
    vi.mocked(useLiveBundle).mockReturnValue({
      bundle: {
        code: '005930',
        from_date: '20260526',
        to_date: '20260527',
        bucket_ms: 60_000,
        segments: [
          { date: '20260526', session_open_ms: YESTERDAY_OPEN_MS, session_close_ms: YESTERDAY_CLOSE_MS, source: 'kis_live' },
          { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kis_live' },
        ],
        candles: [],
        quote_ratio: { bucket_ms: 60_000, points: [] },
        fill_strength: { bucket_ms: 60_000, points: [] },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [],
      },
      isLoading: false,
      error: null,
    });

    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(<LiveChartRoot code="005930" timeframe="1m" />, { wrapper });

    // Negative fractional logical = viewport past leftmost loaded bar.
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // currentEarliest = '20260526', minus PREFETCH_CHUNK_DAYS=10 → '20260516'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260516');
  });

  it('does NOT fire extendHistoricalRange on D timeframe (lazy fetch off for D/W/M)', () => {
    vi.mocked(useLiveBundle).mockReturnValue({
      bundle: {
        code: '005930',
        from_date: '20260526',
        to_date: '20260527',
        bucket_ms: 60_000,
        segments: [
          { date: '20260526', session_open_ms: YESTERDAY_OPEN_MS, session_close_ms: YESTERDAY_CLOSE_MS, source: 'kis_live' },
          { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kis_live' },
        ],
        candles: [],
        quote_ratio: { bucket_ms: 60_000, points: [] },
        fill_strength: { bucket_ms: 60_000, points: [] },
        volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
        volume_profile_by_day: [],
      },
      isLoading: false,
      error: null,
    });

    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(<LiveChartRoot code="005930" timeframe="D" />, { wrapper });

    act(() => {
      handlers.forEach((h) => h({ from: 1000, to: 2000 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });
});

/** Build a fresh chart mock that captures any subscribed visible-range
 * handler so the test can invoke it synchronously. */
function buildChartMockCapturing(handlers: Array<(r: unknown) => void>) {
  return {
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
      update: vi.fn(),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(),
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
      setMarkers: vi.fn(),
    })),
    removeSeries: vi.fn(),
    timeScale: vi.fn(() => ({
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: (h: (r: unknown) => void) => {
        handlers.push(h);
      },
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    })),
    panes: vi.fn(() => []),
    remove: vi.fn(),
    resize: vi.fn(),
    applyOptions: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
  };
}

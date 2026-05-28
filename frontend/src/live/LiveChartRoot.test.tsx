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
import { createChart } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';

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
        setVisibleLogicalRange: vi.fn(),
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

const DEFAULT_BUNDLE: RangeBundle = {
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
};

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('LiveChartRoot', () => {
  it('renders root container with chart slot', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('live-chart-root')).toBeTruthy();
  });

  it('shows D/W/M hoga indicator empty-state notice on D timeframe', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(screen.getByTestId('indicator-disabled-note')).toBeTruthy();
  });

  it('hides D/W/M empty-state notice on minute timeframes', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
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

const TODAY_ONLY_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kis_live' },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
};

const TWO_SEGMENT_BUNDLE: RangeBundle = {
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
};

describe('LiveChartRoot lazy fetch trigger', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT fire extendHistoricalRange when logical from is inside loaded data', () => {
    // logical.from >= 0 means the visible-range origin is inside loaded
    // bars — no extension needed.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TODAY_ONLY_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

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
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

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
    // Handler should prepend one prefetchChunkDaysFor('1m')=2 calendar-day
    // chunk (sized to ≥10 minute candles, weekend-safe) from the current
    // earliest segment.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    // Negative fractional logical = viewport past leftmost loaded bar.
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // currentEarliest = '20260526', minus prefetchChunkDaysFor('1m')=2 → '20260524'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260524');
  });

  it('fires extendHistoricalRange on D timeframe when logical from goes negative', () => {
    // Lazy fetch must run for D/W/M too. The candle backfill is timeframe-
    // independent (useLiveBundle re-aggregates the same 1m bars into D/W/M
    // on the client), so dragging past the leftmost bar on D should
    // extend the same way as on minute timeframes. Prior behavior had a
    // `!isMinuteTimeframe` early-return that blocked D/W/M users from
    // ever seeing more history; this guards against that regression.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // D-timeframe chunk is sized to ~60 daily candles (60 trading days
    // padded to 90 calendar days for weekends + holidays). axis.segments[0]
    // = '20260526', minus prefetchChunkDaysFor('D')=90 → '20260225' (May 26
    // = doy 146, 146 − 90 = doy 56 = Feb 25 in non-leap 2026).
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260225');
  });

  it('does NOT fire extendHistoricalRange when logical from is non-negative', () => {
    // The handler should only trigger when the viewport's logical origin
    // is past the leftmost loaded bar (= negative fractional index).
    // Any positive 'from' means the user is still inside the loaded
    // range and we should NOT prefetch yet.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChart).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );

    act(() => {
      handlers.forEach((h) => h({ from: 1000, to: 2000 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Crosshair → cursor store (ADR-0044)
// ---------------------------------------------------------------------------

import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';

describe('LiveChartRoot crosshair → cursor store (ADR-0044)', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.getState().setAxis(null);
    vi.mocked(createChart).mockClear();
  });

  it('publishes axis to useLiveAxisStore on mount', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(useLiveAxisStore.getState().axis).not.toBeNull();
  });

  it('subscribes to crosshair move on minute timeframe', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChart).mock.results[0].value;
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(1);
  });

  it('does NOT subscribe on calendar timeframe (D/W/M)', () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChart).mock.results[0].value;
    expect(chart.subscribeCrosshairMove).not.toHaveBeenCalled();
  });

  it('crosshair move → setCursor; crosshair leave → clearCursor', async () => {
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    const chart = vi.mocked(createChart).mock.results[0].value;
    const handler = chart.subscribeCrosshairMove.mock.calls[0][0] as (p: {
      time?: unknown;
      point?: { x: number } | null;
    }) => void;
    // Virtual second 0 → axis.toReal(0) = session_open_ms (virtualMs <= 0 clamps
    // to segments[0].sessionOpenMs per virtualAxis.ts:185).
    const SESSION_OPEN = DEFAULT_BUNDLE.segments[0].session_open_ms;
    act(() => handler({ time: 0, point: { x: 1 } }));
    // rAF coalescing — flush one frame.
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);

    act(() => handler({ time: undefined, point: null }));
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
  });

  it('clears cursor when timeframe switches from minute to calendar', () => {
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
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
      setVisibleLogicalRange: vi.fn(),
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

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

import { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { createChartEx, TickMarkType } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { createVirtualAxis } from '../util/virtualAxis';

vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChartEx: vi.fn(() => ({
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
        scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
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

  it('mounts AuctionWindowOverlay when bundle has segments', () => {
    // Phase D2 regression: the auctionWindowMask toggle (default ON) must
    // render the AuctionWindowOverlay band so the user sees visual parity
    // with the data masking it triggers on RatioPane / FillStrength /
    // TotalQtyBar. The overlay self-gates on useActivePrefs(auctionWindowMask)
    // and on axis.segments.length > 0, so mounting it inside the
    // bundle-has-segments JSX block is sufficient.
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
    expect(screen.getByTestId('auction-window-overlay')).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Initial-view application across (code, timeframe) and candle-count growth.
  //
  // Regression: on D/W/M the daily endpoint returns a small initial fetch
  // (~14 bars for 20 days) and then a much larger extension fetch (~250
  // bars for 250 days). Without re-fitting when the count grows, the chart
  // stays zoomed on the early window and the latest data ends up off the
  // right edge — the exact symptom the user hit on watchlist clicks in D.
  // ─────────────────────────────────────────────────────────────────────────

  function makeCandles(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      ts_ms: TODAY_OPEN_MS + i * 60_000,
      open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0,
    }));
  }

  function makeBundleWithCandles(n: number): RangeBundle {
    return { ...TODAY_ONLY_BUNDLE, candles: makeCandles(n) };
  }

  function buildChartMockWithStableTS() {
    const ts = {
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleRange: vi.fn(() => null),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    };
    const chart = {
      addSeries: vi.fn(() => ({
        setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(),
        applyOptions: vi.fn(), priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ts),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
    return { chart, ts };
  }

  it('D timeframe: re-applies fitContent when candle count grows (14 → 250)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(14)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.fitContent).toHaveBeenCalledTimes(1);

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(250)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // The whole point of the fix: count grew → re-fit so the extended
    // window's latest bar lands at the right edge.
    expect(ts.fitContent).toHaveBeenCalledTimes(2);
  });

  it('1m timeframe: setVisibleLogicalRange applied once even as bars grow (SSE pushes preserved)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(105)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Minute path stays "apply once" — SSE pushes inside today must not
    // snap the user's scroll back to the right edge.
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
  });

  it('1m timeframe: initial apply also pins right edge via scrollToPosition(0)', () => {
    // Regression: /diagnose 2026-05-29 found setVisibleLogicalRange alone does
    // NOT pin the latest bar to the right edge when CHART_TIMESCALE_OPTIONS.
    // rightOffset is non-zero AND the chart instance retains a prior code's
    // bar layout. scrollToPosition(0, false) explicitly snaps the right edge.
    // Removing it regresses watchlist-switch viewport to "엉뚱한 곳에서 시작".
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.scrollToPosition).toHaveBeenCalledWith(0, false);
  });

  it('1m timeframe: code change re-applies setVisibleLogicalRange with new count', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    const { chart, ts } = buildChartMockWithStableTS();
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(100)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 105 });

    // Watchlist switch: new code, new (smaller-or-larger) bundle. Without
    // resetting the ref on code change, the new code's latest candle would
    // be pinned to the previous code's right edge.
    rerender(
      <LiveChartRoot
        code="000660"
        timeframe="1m"
        bundle={makeBundleWithCandles(400)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 100, to: 405 });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(2);
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
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

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
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

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
    // Handler should prepend one prefetchChunkDaysFor('1m')=42 calendar-day
    // chunk (≈30 trading days; 2× the previous 21-day baseline per user
    // tuning request, doubly weekend- / multi-holiday-safe).
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

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

    // currentEarliest = '20260526', minus prefetchChunkDaysFor('1m')=42 → '20260414'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260414');
  });

  it('bases next chunk on historicalFromDate (not axis) when axis did not advance', () => {
    // Holiday/long-weekend regression: if the prior chunk fetched only
    // non-trading days, axis.segments[0] stays put. Without basing the
    // next chunk off historicalFromDate, the trigger would recompute the
    // same target, the store's monotonic-decrease guard would reject it,
    // and extension would freeze. Verify the next pan steps another full
    // chunk back from the already-requested boundary instead.
    useLivePageStore.setState({ historicalFromDate: '20260519' }); // earlier than axisEarliest '20260526'

    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

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
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // base = historicalFromDate '20260519' (earlier than axisEarliest
    // '20260526'), minus 42 → '20260407'. If the trigger had re-based on
    // axis instead, it would compute '20260414' and the store guard would
    // reject that as not strictly earlier than '20260519'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260407');
  });

  it('fires extendHistoricalRange on D timeframe when logical from goes negative', () => {
    // Lazy fetch must run for D/W/M too. The candle backfill is timeframe-
    // independent (useLiveBundle re-aggregates the same 1m bars into D/W/M
    // on the client), so dragging past the leftmost bar on D should
    // extend the same way as on minute timeframes. Prior behavior had a
    // `!isMinuteTimeframe` early-return that blocked D/W/M users from
    // ever seeing more history; this guards against that regression.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

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

    // D-timeframe chunk: prefetchChunkCandlesFor('D')=250 candles →
    // prefetchChunkDaysFor('D')=ceil(250 × 7/5)=350 calendar days
    // (~1 year). axis.segments[0] = '20260526', minus 350 → '20250610'
    // (crosses year boundary into 2025).
    expect(useLivePageStore.getState().historicalFromDate).toBe('20250610');
  });

  it('does NOT fire extendHistoricalRange when logical from is non-negative', () => {
    // The handler should only trigger when the viewport's logical origin
    // is past the leftmost loaded bar (= negative fractional index).
    // Any positive 'from' means the user is still inside the loaded
    // range and we should NOT prefetch yet.
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

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
// Historical-prepend viewport preservation (/diagnose 2026-05-31)
//
// Bug: panning left fetched older candles, the bundle was rebuilt with the
// older bars PREPENDED, and RangeSeriesPane's setData kept the visible LOGICAL
// range numerically fixed — so the previously-viewed bars slid right by N and
// the viewport "jumped". Fix: LiveChartRoot captures the visible range as REAL
// timestamps when the leftward pan triggers a fetch, then re-applies it via
// setVisibleRange (re-projected through the rebuilt axis) once the grown bundle
// lands. Real-ms is the stable key because the VirtualAxis re-bases virtualStart
// from 0 on every rebuild (so a logical +N or a raw time restore are both
// wrong; verified in-browser with the real lightweight-charts build).
//
// Harness: a stable timeScale object (so the setVisibleRange spy is shared
// across the handler-capture call and the restore effect) that also captures
// the logical-range handler and returns a real getVisibleRange().
describe('LiveChartRoot historical-prepend viewport preservation', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null });
    vi.useFakeTimers();
    vi.setSystemTime(TODAY_OPEN_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Visible window the user is parked on, in virtual SECONDS (both within
  // today's 6.5h session: 1h and 2h past open).
  const VR_FROM_SEC = 3600;
  const VR_TO_SEC = 7200;

  function buildStableCapturingMock(ts: Record<string, unknown>) {
    return {
      addSeries: vi.fn(() => ({
        setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(),
        applyOptions: vi.fn(), priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ts),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
  }

  function makeTs(handlers: Array<(r: unknown) => void>) {
    return {
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: (h: (r: unknown) => void) => { handlers.push(h); },
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleRange: vi.fn(() => ({ from: VR_FROM_SEC, to: VR_TO_SEC })),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
    };
  }

  const todayBundle = (candleTsList: number[]): RangeBundle => ({
    ...TODAY_ONLY_BUNDLE,
    candles: candleTsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });
  const twoSegBundle = (candleTsList: number[]): RangeBundle => ({
    ...TWO_SEGMENT_BUNDLE,
    candles: candleTsList.map((ts_ms) => ({ ts_ms, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 })),
  });

  it('restores the viewport (setVisibleRange) re-anchored to the same real time after a historical prepend', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 1) Initial paint: today-only, historicalFromDate=null. Records the
    //    earliest drawn candle and short-circuits the restore (initial-view
    //    effect owns the viewport here).
    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );

    // 2) User pans past the leftmost bar: logical.from < 0. The handler
    //    captures the current viewport as REAL ms (via getVisibleRange on the
    //    today-only axis) and debounces extendHistoricalRange.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();
    expect(ts.setVisibleRange).not.toHaveBeenCalled(); // not yet — bundle hasn't grown

    // 3) Grown bundle lands: yesterday PREPENDED (earlier earliest candle).
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    // Expected restore: the same REAL timestamps, re-projected through the
    // rebuilt (two-segment) axis — mirrors the production conversion exactly.
    const oldAxis = createVirtualAxis([
      { date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS },
    ]);
    const anchorFromMs = oldAxis.toReal(VR_FROM_SEC * 1000);
    const anchorToMs = oldAxis.toReal(VR_TO_SEC * 1000);
    const newAxis = createVirtualAxis([
      { date: '20260526', sessionOpenMs: YESTERDAY_OPEN_MS, sessionCloseMs: YESTERDAY_CLOSE_MS },
      { date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS },
    ]);
    const expFrom = Math.round(newAxis.toVirtual(anchorFromMs) / 1000);
    const expTo = Math.round(newAxis.toVirtual(anchorToMs) / 1000);

    expect(ts.setVisibleRange).toHaveBeenCalledWith({ from: expFrom, to: expTo });
    // The restore shifts RIGHT in virtual time (older day now occupies the
    // left), proving it compensated for the prepend rather than leaving the
    // window on the old logical position.
    expect(expFrom).toBeGreaterThan(VR_FROM_SEC);
    // Round-trip losslessness (advisor #1): the restored LEFT edge, projected
    // back to real time through the NEW axis, lands on the exact same real
    // timestamp that was captured before the prepend. This is the property the
    // user perceives — "the bar I was looking at stays put". Both viewport
    // edges sit mid-session (1h/2h past open) so toReal/toVirtual is exact;
    // they are never in the trailing whitespace because the restore only fires
    // after a leftward pan (historicalFromDate != null), where the right edge
    // has moved left off the latest bar.
    const restoredFromMs = newAxis.toReal(expFrom * 1000);
    expect(restoredFromMs).toBe(anchorFromMs);
  });

  it('does NOT restore on pure SSE growth while historicalFromDate is null', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    // SSE appends a bar at the right edge; earliest is unchanged, no extension.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 120_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    expect(ts.setVisibleRange).not.toHaveBeenCalled();
  });

  it('does NOT restore when the extension adds no earlier bar (holiday-only chunk)', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    // Pan left → captures anchor + sets historicalFromDate.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();
    // The fetched chunk was holiday-only: earliest drawn candle unchanged.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    expect(ts.setVisibleRange).not.toHaveBeenCalled();
  });

  it('initial-view and restore never fight on the first extension (mutual exclusion via historicalFromDate)', () => {
    // advisor #4: trace the first extension from a fresh load. The store
    // update (historicalFromDate null→non-null) and the bundle refetch land in
    // SEPARATE commits, so on the bundle-grows commit historicalFromDate is
    // already non-null — the initial-view effect early-returns (no second
    // scrollToPosition / setVisibleLogicalRange) while the restore owns the
    // viewport. This locks that the two viewport effects are mutually exclusive.
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 1) Fresh load, minute: initial-view effect applies ONCE.
    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1); // initial window
    expect(ts.scrollToPosition).toHaveBeenCalledTimes(1);       // initial right-edge snap
    expect(ts.setVisibleRange).not.toHaveBeenCalled();

    // 2) Pan left → historicalFromDate flips non-null (commit A: bundle unchanged).
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });

    // 3) Prepend lands (commit B: bundle grows, historicalFromDate already non-null).
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    // Initial-view effect did NOT re-fire (counts unchanged); restore fired once.
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    expect(ts.scrollToPosition).toHaveBeenCalledTimes(1);
    expect(ts.setVisibleRange).toHaveBeenCalledTimes(1);
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
    vi.mocked(createChartEx).mockClear();
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
    const chart = vi.mocked(createChartEx).mock.results[0].value;
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
    const chart = vi.mocked(createChartEx).mock.results[0].value;
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
    const chart = vi.mocked(createChartEx).mock.results[0].value;
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
      getVisibleRange: vi.fn(() => null),
      setVisibleRange: vi.fn(),
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

// ---------------------------------------------------------------------------
// x-axis tickMarkFormatter — adaptive tiers (2026-05-30 redesign)
//
// The chart now injects a KST horizontal-scale behavior (createChartEx) whose
// weights follow the real KST calendar, so lightweight-charts assigns the
// correct TickMarkType at real boundaries. tickMarkFormatter therefore TRUSTS
// tickType: Month→"N월", DayOfMonth→day, Time→HH:MM. Calendar (D/W/M) suppress
// the intraday Time tiers (daily bars are all anchored to 09:00).
//
// Seam: capture tickMarkFormatter from the createChartEx options (3rd arg).
describe('LiveChartRoot x-axis tickMarkFormatter', () => {
  beforeEach(() => {
    vi.mocked(createChartEx).mockClear();
  });

  function captureTickFormatter(timeframe: 'D' | '1m') {
    render(
      <LiveChartRoot
        code="005930"
        timeframe={timeframe}
        bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    // createChartEx(container, behavior, options) — options is the 3rd arg.
    const opts = vi.mocked(createChartEx).mock.calls[0][2] as {
      timeScale: { tickMarkFormatter: (t: number, k: TickMarkType) => string };
    };
    return opts.timeScale.tickMarkFormatter;
  }

  // virtual second 43201 = segment[1].virtualStart (23401s) + 5.5h (19800s)
  // → real today 14:30 KST (mid-session).
  const MID_SESSION_SEC = 43201;
  // virtual second 0 = segment[0] open = 2026-05-26 09:00 KST (TWO_SEGMENT_BUNDLE's
  // first segment is yesterday; today is segment[1]).
  const FIRST_OPEN_SEC = 0;

  it('1m: Time tick renders HH:MM', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(MID_SESSION_SEC, TickMarkType.Time)).toBe('14:30');
  });

  it('1m: DayOfMonth tick renders the day number', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.DayOfMonth)).toBe('26');
  });

  it('1m: Month tick renders "N월"', () => {
    const fmt = captureTickFormatter('1m');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.Month)).toBe('5월');
  });

  it('D (calendar): DayOfMonth tick keeps its day number', () => {
    const fmt = captureTickFormatter('D');
    expect(fmt(FIRST_OPEN_SEC, TickMarkType.DayOfMonth)).toBe('26');
  });

  it('D (calendar): Time tick is suppressed (empty)', () => {
    const fmt = captureTickFormatter('D');
    expect(fmt(MID_SESSION_SEC, TickMarkType.Time)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Regression (2026-05-30): switching minute → calendar (D/W/M) blanked the
// x-axis until a browser refresh.
//
// Root cause: axisRef was mirrored to the latest axis in a passive useEffect,
// which runs AFTER child panes' setData effects (child effects fire before
// parent effects). The injected KST behavior's fillWeightsForPoints runs inside
// that child setData, so on the commit that first pushes the new timeframe's
// candles it read the PREVIOUS axis. The new candles' large virtual times,
// mapped through the old (smaller-range) axis, clamp to a single real time →
// identical KST dates → intraday weights (<50) → the calendar formatter
// suppresses every Time tick → blank axis. Weights are cached, so it stayed
// blank until a fresh mount (refresh). Fix: write axisRef synchronously during
// render so it is current when setData fires.
//
// Harness: the createChartEx mock wires series.setData to invoke the REAL
// injected behavior (arg 1) at setData-time, capturing the weights the behavior
// computes against whatever axis it actually sees during the switch commit.
describe('LiveChartRoot timeframe-switch axis freshness (regression)', () => {
  const ONE_DAY_MINUTE_BUNDLE: RangeBundle = {
    ...TODAY_ONLY_BUNDLE,
    candles: [{ ts_ms: TODAY_OPEN_MS, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 }],
  };

  function dailyBundle(): RangeBundle {
    const DAY = 86_400_000;
    const segments = Array.from({ length: 5 }, (_, i) => ({
      date: `2026052${7 + i}`,
      session_open_ms: TODAY_OPEN_MS + i * DAY,
      session_close_ms: TODAY_CLOSE_MS + i * DAY,
      source: 'kis_live' as const,
    }));
    const candles = segments.map((s) => ({
      ts_ms: s.session_open_ms,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      vol_a: 1,
      vol_b: 0,
    }));
    return { ...TODAY_ONLY_BUNDLE, from_date: '20260527', to_date: '20260531', segments, candles };
  }

  let weightCaptures: number[][] = [];
  let restoreImpl: (() => void) | undefined;

  beforeEach(() => {
    weightCaptures = [];
    const prev = vi.mocked(createChartEx).getMockImplementation();
    restoreImpl = () => {
      if (prev) vi.mocked(createChartEx).mockImplementation(prev);
    };
    vi.mocked(createChartEx).mockImplementation(((_el: unknown, behavior: unknown) => {
      const beh = behavior as {
        fillWeightsForPoints: (pts: Array<{ originalTime: number; timeWeight: number }>, s: number) => void;
      };
      const makeSeries = () => ({
        setData: (data: Array<{ time: number }>) => {
          const points = (data ?? []).map((d) => ({ originalTime: d.time, timeWeight: -1 }));
          if (points.length) {
            beh.fillWeightsForPoints(points, 0);
            weightCaptures.push(points.map((p) => p.timeWeight));
          }
        },
        update: vi.fn(),
        applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(),
        attachPrimitive: vi.fn(),
        detachPrimitive: vi.fn(),
        setMarkers: vi.fn(),
      });
      return {
        addSeries: vi.fn(() => makeSeries()),
        removeSeries: vi.fn(),
        timeScale: vi.fn(() => ({
          subscribeVisibleTimeRangeChange: vi.fn(),
          unsubscribeVisibleTimeRangeChange: vi.fn(),
          subscribeVisibleLogicalRangeChange: vi.fn(),
          unsubscribeVisibleLogicalRangeChange: vi.fn(),
          applyOptions: vi.fn(),
          fitContent: vi.fn(),
          scrollToRealTime: vi.fn(),
          scrollToPosition: vi.fn(),
          setVisibleLogicalRange: vi.fn(),
          getVisibleRange: vi.fn(() => null),
          setVisibleRange: vi.fn(),
          timeToCoordinate: vi.fn(() => null),
        })),
        panes: vi.fn(() => []),
        remove: vi.fn(),
        resize: vi.fn(),
        applyOptions: vi.fn(),
        subscribeCrosshairMove: vi.fn(),
        unsubscribeCrosshairMove: vi.fn(),
      };
    }) as never);
  });

  afterEach(() => {
    restoreImpl?.();
  });

  it('computes calendar-tier weights for daily candles after switching from minute', () => {
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={ONE_DAY_MINUTE_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    weightCaptures = []; // discard the minute-mount captures; only the switch matters
    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={dailyBundle()}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Daily candles are one-per-day, so consecutive weights must be Day-tier
    // (50) or higher. With the stale-axis bug every daily candle clamps to one
    // real time → all weights intraday (<50) → the calendar axis renders blank.
    const maxWeight = Math.max(0, ...weightCaptures.flat());
    expect(maxWeight).toBeGreaterThanOrEqual(50);
  });
});

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
import { createVirtualAxis } from '../util/virtualAxis';
import { INTER_SEGMENT_GAP_MS } from '../util/time';
import { realMsToVirtualSeconds } from './viewportAnchor';
import type { RangeBundle } from '../api/types';

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
      chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 })),
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
  investorPoints: [],
  ask_peaks: [],
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

  it('D timeframe: re-applies fitContent when candle count changes (placeholder shrink or extension growth)', () => {
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

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="D"
        bundle={makeBundleWithCandles(80)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    // Calendar placeholder data can shrink when the real D window replaces a
    // wider previous D/W/M daily response. Refit on shrink too; otherwise the
    // chart keeps the overly compressed bar spacing.
    expect(ts.fitContent).toHaveBeenCalledTimes(3);
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
    // A code switch is a viewKey change, which REMOUNTS the chart (cross-view
    // staleness guard) — so the new count's viewport must land on the SECOND
    // chart instance, while the first keeps only its own initial placement.
    const first = buildChartMockWithStableTS();
    const second = buildChartMockWithStableTS();
    vi.mocked(createChartEx)
      .mockImplementationOnce(() => first.chart as never)
      .mockImplementationOnce(() => second.chart as never);

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
    expect(first.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 105 });

    // Watchlist switch: new code, new (smaller-or-larger) bundle. The fresh
    // chart instance must receive the new code's 300-bar window — and the
    // removed instance must NOT be touched again (keyed chart entry).
    rerender(
      <LiveChartRoot
        code="000660"
        timeframe="1m"
        bundle={makeBundleWithCandles(400)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    expect(second.ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 100, to: 405 });
    expect(first.ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cold-load reveal cover (/diagnose 2026-06-05).
  //
  // Bug: on a cold load the hoga panes resolve ~2.5s before the candles and
  // establish lightweight-charts' default ~60-bar fit on the shared timeScale;
  // when the candles land the initial-view effect re-applies the 300-bar window,
  // but lwc paints the visible-WIDTH change one frame late, so the candles flash
  // in zoomed to ~60 bars then zoom out to ~300 (the "drawn twice" feeling).
  // Fix: keep an opaque cover over the chart from the (code, timeframe) switch
  // until two rAFs after the viewport is applied, then fade it out.
  // ─────────────────────────────────────────────────────────────────────────

  // Run N animation frames, flushing React after each so a setState inside a
  // nested rAF is committed to the DOM before we assert.
  async function flushFrames(n: number) {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    }
  }

  it('mounts an opaque reveal cover before the viewport settles', () => {
    useLivePageStore.setState({ historicalFromDate: null });
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
    const cover = screen.getByTestId('chart-reveal-cover');
    // Synchronously after mount the reveal rAFs have NOT fired yet → opaque.
    expect(cover.style.opacity).toBe('1');
  });

  it('fades the cover out (opacity 0) two rAFs after the initial viewport is applied', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
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
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('keeps the cover opaque while past candles are still loading (no candles yet)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(0)}
        clampEngaged={false}
        isPastCandlesLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // Candles still loading → the reveal must wait, cover stays opaque so the
    // user never sees the candle pane paint at the wrong zoom.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
  });

  it('reveals the empty chart once the candle fetch settles with no candles', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={makeBundleWithCandles(0)}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // No candles but loading settled → reveal so the cover doesn't linger over
    // an empty (but legitimately data-less) chart.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('reveals when the load settles with a null bundle (cover must not wedge opaque)', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={null}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // Null bundle + settled fetch → no data is pending, so reveal rather than
    // leave the cover stuck over a chartless surface.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  it('keeps the cover opaque while a null-bundle load is still in flight', async () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={null}
        clampEngaged={false}
        isPastCandlesLoading={true}
      />,
      { wrapper },
    );
    await flushFrames(3);
    // Still loading → hold the cover so the candles can't appear at the wrong zoom.
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('1');
  });

  it('reveals on a cold restore of a scrolled-back tab without a saved viewport (historicalFromDate gate)', async () => {
    // Regression (ADR-0069 A안 side-fix): the historicalFromDate gate in the
    // initial-view effect used to `return` WITHOUT reveal(). Switching back to a
    // tab that had panned past history (hfd != null) but carries NO saved
    // viewport — a migrated tab, or one whose viewport was cleared by a
    // timeframe change — left the opaque cover wedged over a fully-drawn chart.
    // The fix reveals unconditionally on that gate (reveal() is idempotent, so an
    // in-session pan where the chart is already revealed is a harmless no-op).
    useLivePageStore.setState({ historicalFromDate: '20260601' }); // scrolled-back tab
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
    await flushFrames(3);
    expect(screen.getByTestId('chart-reveal-cover').style.opacity).toBe('0');
  });

  // (c) /diagnose 2026-06-09 후속: rate-limit/부분로딩 상태 표시. 백엔드 data_warnings를
  // 살려 빈칸 문구 전환 + 부분로딩 칩으로 "고장?" 오해를 없앤다.
  const RL_WARNINGS = [{ reason: 'kis_rate_limit', msg: 'rate limit' }];

  it('캔들 없음 + rate-limit 경고 → 빈칸 노트가 한도 문구로 전환', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(0)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={RL_WARNINGS} />,
      { wrapper },
    );
    expect(screen.getByTestId('past-candles-loading-note').textContent).toContain('호출 한도');
  });

  it('캔들 없음 + 로딩 중 + 경고 없음 → 기존 "분봉 불러오는 중…"', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(0)}
        clampEngaged={false} isPastCandlesLoading={true} />,
      { wrapper },
    );
    expect(screen.getByTestId('past-candles-loading-note').textContent).toContain('분봉 불러오는 중');
  });

  it('캔들 없음 + 로딩 아님 + 경고 없음 → 노트 없음(정말 데이터 없음)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(0)}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    expect(screen.queryByTestId('past-candles-loading-note')).toBeNull();
  });

  it('캔들 있음 + 경고 있음 → 부분로딩 칩 표시', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={RL_WARNINGS} />,
      { wrapper },
    );
    expect(screen.getByTestId('partial-load-chip').textContent).toContain('일부 과거구간');
  });

  it('캔들 있음 + 경고 없음 → 부분로딩 칩 미표시(회귀가드)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={false} isPastCandlesLoading={false} pastDataWarnings={[]} />,
      { wrapper },
    );
    expect(screen.queryByTestId('partial-load-chip')).toBeNull();
  });

  it('clamp + 부분로딩 동시 → 두 칩 모두 표시(bottom-left 스택)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={makeBundleWithCandles(5)}
        clampEngaged={true} isPastCandlesLoading={false} pastDataWarnings={RL_WARNINGS} />,
      { wrapper },
    );
    expect(screen.getByTestId('partial-load-chip')).toBeTruthy();
    expect(screen.getByTestId('clamp-engaged-chip')).toBeTruthy();
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

// NOTE: these two fixtures carry a candle each. The lazy-fetch trigger (3b) and
// settle-loop (3a) only run once data has loaded (candleCountRef guard, /diagnose
// 2026-06-09) — pan/fill are behaviors of a POPULATED chart. An empty-candle
// bundle exercises the cold-load guard instead; the dedicated "no candles loaded
// yet" tests below use { ...BUNDLE, candles: [] } for that.
const TODAY_ONLY_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260527', session_open_ms: TODAY_OPEN_MS, session_close_ms: TODAY_CLOSE_MS, source: 'kis_live' },
  ],
  candles: [{ ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 }],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  investorPoints: [],
  ask_peaks: [],
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
  candles: [
    { ts_ms: YESTERDAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
    { ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
  ],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  investorPoints: [],
  ask_peaks: [],
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
    // Handler should prepend one stepChunkDays('1m')=5 calendar-day chunk
    // (fixed 3-trading-day step, weekend-safe).
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

    // currentEarliest = '20260526', minus stepChunkDays('1m')=5 → '20260521'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521');
  });

  it('does NOT fire extendHistoricalRange before any candle has loaded (cold-load empty chart)', () => {
    // Regression (/diagnose 2026-06-09): a still-loading chart has zero candles
    // but a today-session axis, so lwc reports a NEGATIVE visible logical `from`
    // (no bars to clamp the origin). Without the candleCountRef guard the trigger
    // misreads this as "panned past the leftmost bar" and walks
    // historicalFromDate to the 250-day clamp, spamming uncached past-candles
    // fetches that never settle → permanent blank chart. With data loaded the
    // SAME `from` legitimately extends (test above); with NO data it must not.
    const emptyBundle = { ...TWO_SEGMENT_BUNDLE, candles: [] };
    const handlers: Array<(r: unknown) => void> = [];
    vi.mocked(createChartEx).mockImplementationOnce(() => buildChartMockCapturing(handlers) as any);

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={emptyBundle}
        clampEngaged={false}
        isPastCandlesLoading={true}
      />,
      { wrapper },
    );

    expect(handlers.length).toBeGreaterThan(0);
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    expect(useLivePageStore.getState().historicalFromDate).toBeNull();
  });

  it('(auto-fill 불변식) 캔들 로드 후 초기 빈영역(from<0)은 사용자 팬 없이 자동 백필 — small-window 보장', () => {
    // (a) 초기 창 5거래일 축소(/diagnose 2026-06-09 후속)의 안전성 고정: 받아둔 양이
    // 적어도, 화면에 빈영역이 보이면 사용자 액션 없이 채워진다. 여기선 그 시작점인 3b
    // 트리거가 candles>0(데이터 도착) + from<0(빈영역)에 자동 dispatch함을 잠근다.
    // 연속 스텝(settle-loop)은 'dispatches the next step ... while whitespace remains'가 커버.
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

    // 사용자 입력 없음 — 초기 커밋의 visibleLogicalRangeChange가 빈영역(from<0)을 보고.
    act(() => {
      handlers.forEach((h) => h({ from: -50.3, to: 100.7 }));
      vi.advanceTimersByTime(200);
    });

    // candles>0(TWO_SEGMENT_BUNDLE) → 가드 통과 → 자동으로 한 청크 백필.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521');
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
    // '20260526'), minus 5 → '20260514'. If the trigger had re-based on
    // axis instead, it would compute '20260521' and the store guard would
    // reject that as not strictly earlier than '20260519'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260514');
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

    // D-timeframe chunk: stepChunkDays('D')=350 calendar days (~1 year).
    // axis.segments[0] = '20260526', minus 350 → '20250610'
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
// Historical-prepend viewport repositioning (/diagnose 2026-05-31 → 2026-06-05 ×2)
//
// Contract (v3, 2026-06-05 round 2): a historical prepend must keep the SAME
// BARS on screen, and the reposition target must be computed from the view AS
// OF THE PREPEND COMMIT — never from a position captured earlier.
//
// Why (measured in-browser, lwc 5.2.0, stack-attributed monkey-patch + real
// synthetic-mouse drags): lwc's own setData re-anchor is position-DEPENDENT —
//   ① view at the live edge → preserved exactly (no help needed);
//   ② view deep in left whitespace → lands near the new/old data seam;
//   ③ view mid-data → logical indices FROZEN, content slides by the inserted
//     count (days-scale teleport; reproduced on the user's build).
// The original restore corrected ③ but captured its anchor at the FETCH
// TRIGGER — by the time the prepend landed the chart had moved (kept dragging,
// panned back), so the re-assert teleported (30-bar wobble fresh; thousands of
// bars stale). The v3 design closes the staleness window structurally: a
// parent useLayoutEffect snapshots the view in the SAME commit as the bundle
// swap (layout effects run before RangeSeriesPane's passive setData), and the
// post-setData repositioner re-projects that snapshot through the new axis —
// skipping the set entirely when lwc already landed on the target (case ①).
//
// Seam limit (stated, not papered over): this mock's setData is a NO-OP and
// its range getters are static, so these tests lock the CALL CONTRACT (when a
// reposition fires, its target, and the staleness-freedom of the capture); the
// rendered-pixels half is browser-only evidence (diagnose notes 2026-06-05).
//
// Harness: a stable timeScale object shared across commits, capturing the
// logical-range handler and returning controllable range getters.
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
  // today's 6.5h session: 1h and 2h past open). The /live axis is
  // real-anchored (origin = segments[0]'s real open — the stale-tick-label
  // fix), so the today-only axis the chart is initially drawn with starts at
  // TODAY_OPEN, not 0.
  const VR_FROM_SEC = TODAY_OPEN_MS / 1000 + 3600;
  const VR_TO_SEC = TODAY_OPEN_MS / 1000 + 7200;
  // Visible LOGICAL range (bar indices) the mock's getVisibleLogicalRange
  // returns — read by the settle-loop's planFillStep viewport gate.
  const LR_FROM = 100;
  const LR_TO = 400;

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
      getVisibleLogicalRange: vi.fn(() => ({ from: LR_FROM, to: LR_TO })),
      // Stand-in union index = the (integer) virtual-second value, so the test
      // can derive the expected shift from the same axis math production uses.
      timeToIndex: vi.fn((t: unknown) => Math.round(t as number)),
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

  /** Mirror production's prepend reprojection (real-anchored origins, same
   * axes LiveChartRoot builds): snapshot right edge (virtual sec on the
   * today-only axis) → real ms → two-segment axis virtual sec (rounded).
   * Returns the logical shift newIdx − refIdx under makeTs's
   * index = virtual-second stand-in. */
  function expectedPrependShift(rightEdgeSec: number): number {
    const oldAxis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    const refMs = oldAxis.toReal(rightEdgeSec * 1000);
    const newAxis = createVirtualAxis(
      [
        { date: '20260526', sessionOpenMs: YESTERDAY_OPEN_MS, sessionCloseMs: YESTERDAY_CLOSE_MS },
        { date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS },
      ],
      YESTERDAY_OPEN_MS,
    );
    return Math.round(newAxis.toVirtual(refMs) / 1000) - rightEdgeSec;
  }

  it('repositions to the pre-swap view (same bars) after a historical prepend', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 1) Initial paint: today-only, historicalFromDate=null. The initial-view
    //    effect owns the FIRST viewport placement; the layout-effect snapshot
    //    also primes prevAxisRef with the today-only axis here.
    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    const beforePan = ts.setVisibleLogicalRange.mock.calls.length; // initial-view call(s)

    // 2) User pans past the leftmost bar: logical.from < 0 → the handler
    //    debounces extendHistoricalRange. Data IS fetched ("데이터만 fetch").
    //    NOTE: nothing is captured here — that's the v3 point.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforePan);

    // 3) Grown bundle lands: yesterday PREPENDED. The layout-effect snapshot
    //    (same commit, pre-setData) reads the mock's current view (VR/LR) and
    //    converts the right edge through the PREVIOUS axis; the repositioner
    //    re-projects it through the rebuilt two-segment axis.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    // Expected shift: refIdx = timeToIndex(VR_TO_SEC) = VR_TO_SEC (mock);
    // refMs reprojects through old→new axis exactly as production does.
    const shift = expectedPrependShift(VR_TO_SEC);

    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM + shift,
      to: LR_TO + shift,
    });
    // Width invariant → barSpacing (candle scale) does not move.
    const last = ts.setVisibleLogicalRange.mock.calls.at(-1)![0] as { from: number; to: number };
    expect(last.to - last.from).toBe(LR_TO - LR_FROM);
    // The mock's timeToIndex stand-in equates union index with virtual
    // seconds, so under the real-anchored axis a prepend shifts the stand-in
    // by (stride − real gap) = 23401 − 86400 < 0 — gap compression pulls the
    // virtual value of an existing bar DOWN once the origin moves to the
    // prepended day. Production's timeToIndex returns true union list
    // indices (shift = +inserted count); only "a reposition happened with
    // preserved width" is contract here, not the stand-in's sign.
    expect(shift).not.toBe(0);
  });

  it('skips the reposition when lwc already landed on the target (live-edge case)', () => {
    // Regime ①: at the live edge lwc preserves the view natively. shift=0 here
    // (timeToIndex returns the same index pre/post), so target == current and
    // the repositioner must NOT issue a redundant setVisibleLogicalRange.
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.timeToIndex = vi.fn(() => VR_TO_SEC); // index unchanged across the swap
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    const before = ts.setVisibleLogicalRange.mock.calls.length;
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(before);
  });

  // ── 탭 viewport 복원 (ADR-0069 A안) ──
  // The restore branch runs in the initial-view effect BEFORE the
  // historicalFromDate gate / default minute window. Seam limit (same as the
  // reposition tests above): setData is a no-op so we lock the CALL CONTRACT
  // (the reprojected target / live-edge pin), not the rendered pixels.
  it('restore: a scrolled-back tab reprojects its saved time anchor to a logical range', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const rightEdgeMs = TODAY_OPEN_MS + 2 * 3600_000; // 2h past open, mid-session
    const barSpan = 120;
    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs, barSpan, atLiveEdge: false }} />,
      { wrapper },
    );
    // The component builds a today-only real-anchored axis (origin = today open).
    // idx = mock timeToIndex(realMsToVirtualSeconds(axis, rightEdgeMs)) (round of
    // an already-integer value). Computed here with the same axis math.
    const axis = createVirtualAxis(
      [{ date: '20260527', sessionOpenMs: TODAY_OPEN_MS, sessionCloseMs: TODAY_CLOSE_MS }],
      TODAY_OPEN_MS,
    );
    const idx = realMsToVirtualSeconds(axis, rightEdgeMs);
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: idx - barSpan, to: idx });
    // NOT a live-edge restore → no scrollToPosition snap.
    expect(ts.scrollToPosition).not.toHaveBeenCalled();
  });

  it('restore: a live-edge tab pins the latest bar with the saved zoom + scrollToPosition', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    // 100 candles + saved span 50 → from max(0,100-50)=50, to 105. Distinct from
    // the default 300-window ({from:0,to:105}) so this proves the live-edge branch.
    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs: TODAY_OPEN_MS + 100 * 60_000, barSpan: 50, atLiveEdge: true }} />,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 50, to: 105 });
    expect(ts.scrollToPosition).toHaveBeenCalledWith(0, false);
  });

  it('restore: no saved viewport → the default 300-bar minute window (regression)', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false} /> /* restoreViewport omitted */,
      { wrapper },
    );
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 105 });
  });

  it('restore: an anchor older than the earliest loaded bar falls through to default (no degenerate {0,0})', () => {
    // Pre-landing review P2: lwc timeToIndex(findNearest) CLAMPS a too-early
    // anchor to bar 0 (does NOT return null), which would pin a degenerate
    // {from:0,to:0} window. The earliest-bar guard must instead fall through to
    // the default view. Candles start at TODAY_OPEN+60s; anchor at TODAY_OPEN
    // (before the first bar).
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle(Array.from({ length: 100 }, (_, i) => TODAY_OPEN_MS + (i + 1) * 60_000))}
        clampEngaged={false} isPastCandlesLoading={false}
        restoreViewport={{ rightEdgeMs: TODAY_OPEN_MS, barSpan: 120, atLiveEdge: false }} />,
      { wrapper },
    );
    // Default minute window, NOT {from:0,to:0}.
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 105 });
  });

  // ── 진행 루프(스텝 2..N): isExtending falling edge + 빈영역 → 다음 스텝 자가 dispatch ──
  // makeTs는 STABLE ts를 돌려주므로 per-test로 getVisibleLogicalRange().from을
  // 덮어 viewport 상태(빈영역/꽉 참)를 제어한다. bundle은 rerender 사이 동결이라
  // 복원 effect([chart,bundle,axis])가 재실행되지 않아 우리가 덮은 from을 그대로 읽는다.
  it('dispatches the next step on isExtending falling edge while whitespace remains', () => {
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -50, to: 100 })); // 빈영역 남음
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={true} />,
      { wrapper },
    );
    act(() => {
      rerender(
        <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
          clampEngaged={false} isPastCandlesLoading={false} isExtending={false} />,
      );
    });
    // cur '20260521' − stepChunkDays('1m')=5 → '20260516'.
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260516');
  });

  it('does NOT dispatch a fill step before candles load, even with historicalFromDate set', () => {
    // Defense-in-depth companion to 3b's guard: if historicalFromDate is
    // non-null (e.g. persisted from a prior pan, then a reload) while the chart
    // is still cold (zero candles), the settle-loop must NOT keep stepping —
    // same runaway as the trigger. candleCountRef===0 stops it (/diagnose
    // 2026-06-09). With candles present this same setup DOES step (test above).
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const emptyBundle = { ...TWO_SEGMENT_BUNDLE, candles: [] };
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -50, to: 100 })); // 빈영역 남음
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={emptyBundle}
        clampEngaged={false} isPastCandlesLoading={true} isExtending={true} />,
      { wrapper },
    );
    act(() => {
      rerender(
        <LiveChartRoot code="005930" timeframe="1m" bundle={emptyBundle}
          clampEngaged={false} isPastCandlesLoading={true} isExtending={false} />,
      );
    });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521'); // 불변
  });

  it('does NOT dispatch a next step when the viewport is full (visibleFrom >= 0)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: 4, to: 100 })); // 꽉 참
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={true} />,
      { wrapper },
    );
    act(() => {
      rerender(
        <LiveChartRoot code="005930" timeframe="1m" bundle={TWO_SEGMENT_BUNDLE}
          clampEngaged={false} isPastCandlesLoading={false} isExtending={false} />,
      );
    });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521'); // 불변
    // 효과가 게이트까지 실행돼 viewport를 읽고 'full'이라 멈췄음을 국소화.
    expect(ts.getVisibleLogicalRange).toHaveBeenCalled();
  });

  it('does NOT run the fill loop on D timeframe (minute-only)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260521' });
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    ts.getVisibleLogicalRange = vi.fn(() => ({ from: -50, to: 100 }));
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="D" bundle={TWO_SEGMENT_BUNDLE}
        clampEngaged={false} isPastCandlesLoading={false} isExtending={true} />,
      { wrapper },
    );
    act(() => {
      rerender(
        <LiveChartRoot code="005930" timeframe="D" bundle={TWO_SEGMENT_BUNDLE}
          clampEngaged={false} isPastCandlesLoading={false} isExtending={false} />,
      );
    });
    expect(useLivePageStore.getState().historicalFromDate).toBe('20260521'); // D one-shot, 불변
    // (구 국소화였던 "getVisibleLogicalRange 미호출"은 v3에서 무효 — pre-swap
    // 스냅샷 layout effect가 모든 타임프레임에서 정당하게 viewport를 읽는다.
    // 잠그는 행동은 위의 단언: D에서 settle-loop가 dispatch하지 않는다.)
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
    const beforeSse = ts.setVisibleLogicalRange.mock.calls.length; // initial-view only
    // SSE appends a bar at the right edge; earliest is unchanged, no extension.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 120_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    // Restore must NOT fire (historicalFromDate null) — no new setVisibleLogicalRange.
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforeSse);
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
    // Pan left → captures the reference bar + sets historicalFromDate.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();
    const beforeHoliday = ts.setVisibleLogicalRange.mock.calls.length;
    // The fetched chunk was holiday-only: earliest drawn candle unchanged.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );
    // newEarliest >= prevEarliest → restore short-circuits, no shift.
    expect(ts.setVisibleLogicalRange.mock.calls.length).toBe(beforeHoliday);
  });

  it('initial-view applies exactly once; the first extension adds exactly one reposition', () => {
    // Trace the first extension from a fresh load. The store update
    // (historicalFromDate null→non-null) and the bundle refetch land in
    // SEPARATE commits, so on the bundle-grows commit historicalFromDate is
    // already non-null — the initial-view effect early-returns (no second
    // scrollToPosition / setVisibleLogicalRange) while the repositioner owns
    // that commit's viewport. Exactly two owners, never on the same commit:
    // initial-view (first paint) and the repositioner (prepends).
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

    // The initial-view effect did NOT re-fire (scrollToPosition stayed at 1);
    // the repositioner added exactly one setVisibleLogicalRange (1 → 2).
    expect(ts.scrollToPosition).toHaveBeenCalledTimes(1);
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(2);
  });

  // Staleness-freedom regression (/diagnose 2026-06-05, the saga's crown jewel).
  //
  // The whole 3-round bug class was ONE mistake: capturing the reposition
  // anchor at the FETCH TRIGGER and applying it at the PREPEND — the chart
  // moves in between (user keeps dragging / pans back), so the re-assert
  // teleports. v3 captures in the SAME COMMIT as the bundle swap (parent
  // useLayoutEffect, before the child's passive setData), making staleness
  // structurally impossible.
  //
  // This test moves the mock's view BETWEEN the trigger and the swap, then
  // asserts the reposition target is derived from the AT-SWAP view (B), not
  // the at-trigger view (A). Trigger-time-capture semantics fail this test.
  it('reposition target derives from the at-swap view, not the at-trigger view (no staleness)', () => {
    const handlers: Array<(r: unknown) => void> = [];
    const ts = makeTs(handlers);
    vi.mocked(createChartEx).mockImplementationOnce(() => buildStableCapturingMock(ts) as any);

    const { rerender } = render(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={todayBundle([TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
      { wrapper },
    );

    // 1) Trigger at view A (the mock's defaults) → debounced fetch armed.
    act(() => {
      handlers.forEach((h) => h({ from: -40.2, to: 120.7 }));
      vi.advanceTimersByTime(200);
    });
    expect(useLivePageStore.getState().historicalFromDate).not.toBeNull();

    // 2) User pans elsewhere BEFORE the fetch lands → the chart now shows
    //    view B. (Static mocks: just swap what the getters return.)
    const B_VR_TO = VR_TO_SEC + 1800;
    ts.getVisibleRange.mockReturnValue({ from: VR_FROM_SEC + 1800, to: B_VR_TO });
    ts.getVisibleLogicalRange.mockReturnValue({ from: LR_FROM + 30, to: LR_TO + 30 });

    // 3) Grown bundle lands. The layout-effect snapshot (same commit) reads B.
    rerender(
      <LiveChartRoot code="005930" timeframe="1m"
        bundle={twoSegBundle([YESTERDAY_OPEN_MS + 60_000, TODAY_OPEN_MS + 60_000])}
        clampEngaged={false} isPastCandlesLoading={false} />,
    );

    const shiftB = expectedPrependShift(B_VR_TO);

    // Target must be view B + shiftB. A trigger-time capture would have used
    // view A (LR_FROM..LR_TO, refIdx VR_TO_SEC) and produced different numbers.
    expect(ts.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: LR_FROM + 30 + shiftB,
      to: LR_TO + 30 + shiftB,
    });
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
    // Subscribers: (1) LiveChartRoot's cursor-publish effect, (2) PaneLegendOverlay
    // value reader, (3) CandleTooltip — subscribes exactly once, keyed on
    // [chart, enabled] (paneSeries + drawn/index map read via refs/render so SSE
    // ticks and pane registration do NOT resubscribe). A higher count would mean a
    // leaked/duplicate subscription beyond these three legitimate calls.
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(3);
  });

  it('subscribes on calendar timeframe too (publishes cursor for Pane Legend; spot stays minute-only in LiveSidebar)', () => {
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
    // Subscribers: (1) LiveChartRoot's cursor-publish effect, (2) PaneLegendOverlay
    // value reader, (3) CandleTooltip — subscribes exactly once, keyed on
    // [chart, enabled] (paneSeries + drawn/index map read via refs/render so SSE
    // ticks and pane registration do NOT resubscribe). A higher count would mean a
    // leaked/duplicate subscription beyond these three legitimate calls.
    expect(chart.subscribeCrosshairMove).toHaveBeenCalledTimes(3);
  });

  it('crosshair move → setCursor; crosshair leave → restore last hover cursor', async () => {
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
    // Both LiveChartRoot's cursor-publish handler and PaneLegendOverlay's value
    // reader subscribe; the real chart dispatches each crosshair event to ALL
    // subscribers, so fan the synthetic event out to every registered handler
    // (order-independent — only LiveChartRoot's writes the cursor store).
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    // Virtual second 0 → axis.toReal(0) = session_open_ms (virtualMs at/below
    // the origin — segments[0].virtualStart — clamps to the first session
    // open; with the real-anchored origin, 0 sits below it).
    const SESSION_OPEN = DEFAULT_BUNDLE.segments[0].session_open_ms;
    act(() => fire({ time: 0, point: { x: 1 } }));
    // rAF coalescing — flush one frame.
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);

    act(() => fire({ time: undefined, point: null }));
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
  });

  it('crosshair into the right-offset whitespace (numeric time past the last candle) → keep last hover cursor', async () => {
    // Real mechanism (verified 2026-06-11 — supersedes the original #69
    // assumption of `time: undefined`): with CrosshairMode.Normal lwc does NOT
    // report an empty time in the whitespace; it extrapolates the gap-compressed
    // virtual axis forward, so param.time is a NUMBER that maps PAST the last
    // candle (onto the session tail). The handler must treat "realMs > last
    // candle" as not-on-a-bar → clear (→ LIVE WS), not pin the cursor to a
    // future no-data slot (which is what left the sidebar blank). TODAY_ONLY_
    // BUNDLE carries one candle so lastCandleMsRef is populated.
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
    const chart = vi.mocked(createChartEx).mock.results[0].value;
    const fire = (p: { time?: unknown; point?: { x: number } | null }) =>
      chart.subscribeCrosshairMove.mock.calls.forEach(
        ([h]: [(p: { time?: unknown; point?: { x: number } | null }) => void]) => h(p),
      );
    const flush = () => act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const SESSION_OPEN = TODAY_ONLY_BUNDLE.segments[0].session_open_ms;
    const lastCandleMs = TODAY_ONLY_BUNDLE.candles[TODAY_ONLY_BUNDLE.candles.length - 1].ts_ms;
    expect(lastCandleMs).toBeGreaterThan(SESSION_OPEN); // fixture premise guard
    // On/before the last candle (virtual 0 → session open ≤ last candle) → spot.
    act(() => fire({ time: 0, point: { x: 1 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
    // Whitespace: param.time is virtual-axis seconds on a REAL-ANCHORED origin
    // (virtualStart = session_open_ms), so toReal(t·1000) = t·1000 inside the
    // session. Pick a time 10 min past the open — well past the single candle at
    // open+60s → realMs > last candle → revert to LIVE (cursor cleared), NOT
    // pinned to a future no-data slot.
    const whitespaceTimeSec = (TODAY_OPEN_MS + 600_000) / 1000;
    act(() => fire({ time: whitespaceTimeSec, point: { x: 9999 } }));
    await flush();
    expect(useLiveCursorStore.getState().cursorMs).toBe(SESSION_OPEN);
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

  // The /live axis is real-anchored: virtual time starts at segments[0]'s
  // REAL session open, not 0 (see createVirtualAxis's originMs — the
  // stale-tick-label fix). So segment[0]'s open in virtual seconds IS its
  // real open in seconds.
  const FIRST_OPEN_SEC = YESTERDAY_OPEN_MS / 1000;
  // One segment's stride on the virtual axis: session length + synthetic gap.
  const SEG_STRIDE_SEC = (TODAY_CLOSE_MS - TODAY_OPEN_MS + INTER_SEGMENT_GAP_MS) / 1000;
  // origin + segment[1].virtualStart offset + 5.5h → real today 14:30 KST
  // (mid-session).
  const MID_SESSION_SEC = FIRST_OPEN_SEC + SEG_STRIDE_SEC + 5.5 * 3600;

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

// ---------------------------------------------------------------------------
// Per-view chart remount — cross-view staleness guard
//
// lightweight-charts caches tick weights/marks/labels by time VALUE per chart
// instance, and two different (code, timeframe) views can produce
// value-identical virtual-time ladders with different real-date mappings even
// under real-anchored origins (same-first-trading-day W↔M windows; per-stock
// missing dates under gap compression). The only safe state boundary is a
// fresh chart instance per view — these tests lock that contract.
// ---------------------------------------------------------------------------

describe('LiveChartRoot per-view chart remount (cross-view staleness guard)', () => {
  beforeEach(() => {
    vi.mocked(createChartEx).mockClear();
  });

  function chartProps(code: string, timeframe: '1m' | 'D', bundle: RangeBundle) {
    return { code, timeframe, bundle, clampEngaged: false, isPastCandlesLoading: false } as const;
  }

  it('recreates the lwc chart on a timeframe switch and disposes the old one', () => {
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', TODAY_ONLY_BUNDLE)} />,
      { wrapper },
    );
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(1);
    rerender(<LiveChartRoot {...chartProps('005930', 'D', TODAY_ONLY_BUNDLE)} />);
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(createChartEx).mock.results[0].value as {
      remove: ReturnType<typeof vi.fn>;
    };
    expect(first.remove).toHaveBeenCalledTimes(1);
  });

  it('recreates the chart on a watchlist code switch', () => {
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', TODAY_ONLY_BUNDLE)} />,
      { wrapper },
    );
    rerender(<LiveChartRoot {...chartProps('000660', '1m', TODAY_ONLY_BUNDLE)} />);
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(2);
  });

  it('keeps the chart instance across bundle-only updates (SSE push)', () => {
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', TODAY_ONLY_BUNDLE)} />,
      { wrapper },
    );
    rerender(<LiveChartRoot {...chartProps('005930', '1m', { ...TODAY_ONLY_BUNDLE })} />);
    expect(vi.mocked(createChartEx)).toHaveBeenCalledTimes(1);
  });

  it('applies the initial viewport to the NEW chart after a timeframe switch', () => {
    // Regression (adversarial review F1): on a viewKey switch, the effects of
    // the switch commit still close over the REMOVED chart. lwc viewport
    // calls on a removed chart don't throw, so the one-shot initial-view
    // effect used to fire against the dead instance — consuming
    // lastAppliedCountRef and leaving the new chart at lwc's default ~60-bar
    // view. The keyed chart entry derives `chart` as null for the mismatched
    // commit; this test asserts the viewport lands on the new instance.
    // (Default mock's timeScale() returns a fresh object per call, so build
    // two charts with STABLE timeScale objects to accumulate assertions.)
    useLivePageStore.setState({ historicalFromDate: null });
    function stableChart() {
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
        getVisibleLogicalRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        timeToIndex: vi.fn(() => null),
      };
      const chart = {
        addSeries: vi.fn(() => ({
          setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
          priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
          createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
          removePriceLine: vi.fn(), attachPrimitive: vi.fn(),
          detachPrimitive: vi.fn(), setMarkers: vi.fn(),
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
      return { ts, chart };
    }
    const a = stableChart();
    const b = stableChart();
    vi.mocked(createChartEx)
      .mockImplementationOnce(() => a.chart as never)
      .mockImplementationOnce(() => b.chart as never);

    const withCandles: RangeBundle = {
      ...TODAY_ONLY_BUNDLE,
      candles: [
        { ts_ms: TODAY_OPEN_MS + 60_000, open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0 },
      ],
    };
    const { rerender } = render(
      <LiveChartRoot {...chartProps('005930', '1m', withCandles)} />,
      { wrapper },
    );
    // Minute initial view applied to chart A.
    expect(a.ts.setVisibleLogicalRange).toHaveBeenCalled();

    rerender(<LiveChartRoot {...chartProps('005930', 'D', withCandles)} />);
    // The D/W/M fit must land on chart B — with the unkeyed chart state it
    // fired on the removed chart A and B received ZERO viewport calls.
    expect(b.ts.fitContent).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wheel interactions wiring (spec 2026-06-07-live-wheel-interactions)
// ---------------------------------------------------------------------------

describe('LiveChartRoot wheel interactions wiring', () => {
  beforeEach(() => {
    useLivePageStore.setState({ historicalFromDate: null });
    vi.mocked(createChartEx).mockClear();
  });

  it('disables the library wheel zoom via handleScale.mouseWheel: false', () => {
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
    // createChartEx(el, behavior, options) — options는 3번째 인자.
    const options = vi.mocked(createChartEx).mock.calls.at(-1)![2] as Record<string, unknown>;
    expect(options).toMatchObject({ handleScale: { mouseWheel: false } });
  });

  it('container wheel → right-edge-anchored zoom via setVisibleLogicalRange', () => {
    // useWheelInteractions가 읽는 getVisibleLogicalRange / coordinateToLogical을
    // 갖춘 ts mock (기본 모듈 mock에는 둘 다 없다).
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
      getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 100 })),
      coordinateToLogical: vi.fn(() => null),
      // 줌아웃 플로어(maxSpan = width/minBarSpacing = 2000) — 이 테스트의
      // 요청 span(≈110.5)에는 발동하지 않는 값.
      width: vi.fn(() => 1000),
      // DEFAULT_BUNDLE은 candles 빈 배열이라 lastMs undefined → timeToIndex 미호출,
      // plain 앵커는 to-고정 폴백(to=100 유지). 방어적으로 둔다.
      timeToIndex: vi.fn(() => null),
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
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
    };
    vi.mocked(createChartEx).mockImplementationOnce(() => chart as never);

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

    // containerRef div = live-chart-root의 첫 번째 자식 (chart 슬롯).
    // 휠 리스너는 container의 부모(live-chart-root)에 부착되므로(형제 DrawingOverlay
    // 위 휠도 받기 위함 — useWheelInteractions 주석 참조), container에서 dispatch한
    // 이벤트가 부모 리스너에 도달하려면 bubbles:true가 필요하다(실제 브라우저 wheel과
    // 동일; jsdom 합성 이벤트의 bubbles 기본값은 false).
    const container = screen.getByTestId('live-chart-root').firstElementChild!;
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true }));

    // 마지막 호출이 휠 결과여야 한다 (초기 뷰 effect의 호출이 선행할 수 있음).
    const last = ts.setVisibleLogicalRange.mock.calls.at(-1)![0] as { from: number; to: number };
    expect(last.to).toBe(100);
    expect(last.from).toBeCloseTo(100 - 100 * Math.exp(0.1), 6); // ≈ -10.517
  });
});

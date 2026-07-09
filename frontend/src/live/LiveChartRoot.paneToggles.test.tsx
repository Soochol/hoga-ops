import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';

// jsdom lacks ResizeObserver — stub before the component module loads.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Capture which pane specs LiveChartRoot actually mounts. This closes the
// wiring blind spot: paneSpecsForTimeframe is unit-tested in isolation, but
// "store toggle → paneToggles → the pane set that reaches RangeSeriesPane" was
// never asserted end-to-end. RangeSeriesPane renders null in jsdom (imperative
// lightweight-charts wrapper), so we replace it with a prop-capturing stub.
const { mounted, paneBundles, paneContexts, candleTooltipProps, askPeakMounts, bidPeakMounts, dockedLabelMounts, chartInstances } = vi.hoisted(() => ({
  mounted: [] as string[],
  paneBundles: [] as Array<{ name: string; bundle: unknown }>,
  paneContexts: [] as Array<{ name: string; contextOverride: unknown }>,
  candleTooltipProps: [] as Array<{ bundle: unknown; quoteBundle?: unknown }>,
  askPeakMounts: [] as string[],
  bidPeakMounts: [] as string[],
  dockedLabelMounts: [] as string[],
  chartInstances: [] as Array<{
    remove: ReturnType<typeof vi.fn>;
    timeScaleApi: {
      subscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      unsubscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      fitContent: ReturnType<typeof vi.fn>;
      setVisibleLogicalRange: ReturnType<typeof vi.fn>;
    };
  }>,
}));
vi.mock('../chart/RangeSeriesPane', () => ({
  default: (props: { spec: { name: string }; bundle: unknown; contextOverride?: unknown }) => {
    mounted.push(props.spec.name);
    paneBundles.push({ name: props.spec.name, bundle: props.bundle });
    paneContexts.push({ name: props.spec.name, contextOverride: props.contextOverride });
    return null;
  },
}));

vi.mock('./CandleTooltip', () => ({
  default: (props: { bundle: unknown; quoteBundle?: unknown }) => {
    candleTooltipProps.push({ bundle: props.bundle, quoteBundle: props.quoteBundle });
    return null;
  },
}));

vi.mock('./LiveAskPeakSegments', () => ({
  default: () => {
    askPeakMounts.push('mounted');
    return null;
  },
}));

vi.mock('./LiveBidPeakSegments', () => ({
  default: () => {
    bidPeakMounts.push('mounted');
    return null;
  },
}));

vi.mock('./LivePeakWallDockedLabels', () => ({
  default: () => {
    dockedLabelMounts.push('mounted');
    return null;
  },
}));

vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChartEx: vi.fn(() => {
      const timeScaleApi = {
        subscribeVisibleTimeRangeChange: vi.fn(), unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(), fitContent: vi.fn(), scrollToRealTime: vi.fn(), scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(), getVisibleRange: vi.fn(() => null), setVisibleRange: vi.fn(),
        width: vi.fn(() => 900), timeToIndex: vi.fn(() => null),
        timeToCoordinate: vi.fn(() => null),
      };
      const chart = {
        addSeries: vi.fn(() => ({
          setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(), applyOptions: vi.fn(),
          priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
          createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
          removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), setMarkers: vi.fn(),
        })),
        removeSeries: vi.fn(),
        timeScale: vi.fn(() => timeScaleApi),
        panes: vi.fn(() => []),
        remove: vi.fn(), resize: vi.fn(), applyOptions: vi.fn(),
        subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
        chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 })),
        timeScaleApi,
      };
      chartInstances.push(chart);
      return chart;
    }),
  };
});

import { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { RangeBundle } from '../api/types';

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
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

const CALENDAR_BUNDLE: RangeBundle = {
  ...DEFAULT_BUNDLE,
  bucket_ms: 7 * 24 * 60 * 60 * 1000,
  candles: [
    { ts_ms: 1781222400000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
    { ts_ms: 1781827200000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
  ],
};

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

function renderAt(timeframe: '1m' | 'D' | 'W' | 'M', props: Partial<ComponentProps<typeof LiveChartRoot>> = {}) {
  render(
    <LiveChartRoot
      code="005930"
      timeframe={timeframe}
      bundle={DEFAULT_BUNDLE}
      clampEngaged={false}
      isPastCandlesLoading={false}
      {...props}
    />,
    { wrapper },
  );
}

describe('LiveChartRoot — pane 토글 배선 (store → 마운트된 pane 집합)', () => {
  beforeEach(() => {
    mounted.length = 0;
    paneBundles.length = 0;
    paneContexts.length = 0;
    candleTooltipProps.length = 0;
    askPeakMounts.length = 0;
    bidPeakMounts.length = 0;
    dockedLabelMounts.length = 0;
    chartInstances.length = 0;
    // Deterministic baseline: all togglable panes ON, investor OFF.
    useLivePageStore.setState({
      historicalFromDate: null,
      volumeEnabled: true,
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      programTradeEnabled: true,
      foreignNetEnabled: false,
      institutionNetEnabled: false,
      panePrefsByTimeframe: {},
    });
    useChartPrefsStore.getState().setToggle('volumeFillStrengthCumulative', false);
  });

  it('기본(전부 ON) 1m → 6 pane 마운트', () => {
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength', 'program-trade']);
  });

  it('passes the venue-specific candle auction style context from props', () => {
    renderAt('1m', { venue: 'UN' });
    expect(paneContexts.find((pane) => pane.name === 'candle')?.contextOverride).toEqual({
      muteAuctionCandles: false,
    });
  });

  it('quoteTotalsEnabled=false → 총잔량 pane 미마운트', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: false });
    renderAt('1m');
    expect(mounted).not.toContain('quote-totals');
    expect(mounted).toContain('ratio');
    expect(mounted).toContain('fill-strength');
    expect(mounted).toContain('program-trade');
  });

  it('ratio·fill 동시 off → candle·volume·총잔량·프로그램 순매수', () => {
    useLivePageStore.setState({ ratioEnabled: false, fillStrengthEnabled: false });
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals', 'program-trade']);
  });

  it('volumeEnabled=false → 거래량 pane 미마운트', () => {
    useLivePageStore.setState({ volumeEnabled: false });
    renderAt('1m');
    expect(mounted).not.toContain('volume');
    expect(mounted[0]).toBe('candle');
  });

  it('calendar(D) → 호가 토글 무관, candle·volume만', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: true, ratioEnabled: true, fillStrengthEnabled: true });
    renderAt('D');
    expect(mounted).toEqual(['candle', 'volume']);
  });

  it('uses the active timeframe pane profile instead of flat legacy fields', () => {
    useLivePageStore.setState({
      ratioEnabled: true,
      panePrefsByTimeframe: {
        minute: { ratioEnabled: false },
      },
    });
    renderAt('1m');
    expect(mounted).not.toContain('ratio');
    expect(mounted).toContain('quote-totals');
  });

  it('keeps /live D hoga panes gated even when the D profile enables them', () => {
    useLivePageStore.setState({
      panePrefsByTimeframe: {
        D: { quoteTotalsEnabled: true, ratioEnabled: true, fillStrengthEnabled: true },
      },
    });
    renderAt('D');
    expect(mounted).toEqual(['candle', 'volume']);
  });

  it('allows forced study-style D hoga panes from the D profile', () => {
    useLivePageStore.setState({
      panePrefsByTimeframe: {
        D: { ratioEnabled: true, quoteTotalsEnabled: false, fillStrengthEnabled: false },
      },
    });
    renderAt('D', { forceHogaPanes: true });
    expect(mounted).toEqual(['candle', 'volume', 'ratio', 'program-trade']);
  });

  it('paneTogglesOverride가 live store 대신 저장된 indicator pane 상태를 적용한다', () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      quoteTotalsEnabled: false,
      ratioEnabled: true,
      fillStrengthEnabled: false,
    });
    renderAt('1m', {
      paneTogglesOverride: {
        volumeEnabled: false,
        quoteTotalsEnabled: true,
        ratioEnabled: false,
        fillStrengthEnabled: true,
        programTradeEnabled: false,
      },
    });
    expect(mounted).toEqual(['candle', 'quote-totals', 'fill-strength']);
  });

  it('quote/ratio/fill panes receive the hoga-only bundle while program-trade stays on the full bundle', () => {
    const hogaPaneBundle = {
      ...DEFAULT_BUNDLE,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1748275260000, ask_total: 10, bid_total: 20, ask_max: 10, bid_max: 20, imb_max_ask: 10, imb_max_bid: 20 }] },
    } satisfies RangeBundle;
    renderAt('1m', {
      bundle: DEFAULT_BUNDLE,
      hogaPaneBundle,
    });

    const byName = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    expect(byName.get('quote-totals')).toBe(hogaPaneBundle);
    expect(byName.get('ratio')).toBe(hogaPaneBundle);
    expect(byName.get('fill-strength')).toBe(hogaPaneBundle);
    expect(byName.get('program-trade')).toBe(DEFAULT_BUNDLE);
  });

  it('volume pane uses the stable chart bundle when volume cumulative is disabled', () => {
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    } satisfies RangeBundle;
    const liveBundle = {
      ...chartBundle,
      fill_strength: { bucket_ms: 60_000, points: [{ t: 1748275260000, buy_qty: 10, sell_qty: 2 }] },
    } satisfies RangeBundle;

    renderAt('1m', {
      bundle: liveBundle,
      chartBundle,
    });

    const byName = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    expect(byName.get('volume')).toBe(chartBundle);
  });

  it('volume pane uses the live bundle only when volume cumulative is enabled', () => {
    useChartPrefsStore.getState().setToggle('volumeFillStrengthCumulative', true);
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    } satisfies RangeBundle;
    const liveBundle = {
      ...chartBundle,
      fill_strength: { bucket_ms: 60_000, points: [{ t: 1748275260000, buy_qty: 10, sell_qty: 2 }] },
    } satisfies RangeBundle;

    renderAt('1m', {
      bundle: liveBundle,
      chartBundle,
    });

    const byName = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    expect(byName.get('volume')).toBe(liveBundle);
  });

  it('candle tooltip keeps the stable candle bundle but reads hoga values from the hoga bundle', () => {
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
      quote_ratio: { bucket_ms: 60_000, points: [] },
    } satisfies RangeBundle;
    const hogaPaneBundle = {
      ...chartBundle,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1748275260000, ask_total: 10, bid_total: 20, ask_max: 10, bid_max: 20, imb_max_ask: 10, imb_max_bid: 20 }] },
    } satisfies RangeBundle;

    renderAt('1m', {
      bundle: DEFAULT_BUNDLE,
      chartBundle,
      hogaPaneBundle,
    });

    expect(candleTooltipProps.at(-1)?.bundle).toBe(chartBundle);
    expect(candleTooltipProps.at(-1)?.quoteBundle).toBe(hogaPaneBundle);
  });

  it('viewIdentity 변경은 같은 code/timeframe에서도 chart identity를 교체한다', async () => {
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        viewIdentity="view-a"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await waitFor(() => expect(chartInstances).toHaveLength(1));

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        viewIdentity="view-b"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );

    await waitFor(() => expect(chartInstances).toHaveLength(2));
    expect(chartInstances[0].remove).toHaveBeenCalled();
  });

  it('1m → 당일 매도 최대벽 오버레이 마운트', () => {
    renderAt('1m');
    expect(askPeakMounts).toEqual(['mounted']);
  });

  it.each(['D', 'W', 'M'] as const)('calendar(%s) → 당일 매도 최대벽 오버레이 미마운트', (timeframe) => {
    renderAt(timeframe);
    expect(askPeakMounts).toEqual([]);
  });

  it.each(['W', 'M'] as const)('calendar(%s) starts with candles plus right-side empty space', async (timeframe) => {
    renderAt(timeframe, { bundle: CALENDAR_BUNDLE });

    await waitFor(() => expect(chartInstances[0].timeScaleApi.setVisibleLogicalRange).toHaveBeenCalled());
    expect(chartInstances[0].timeScaleApi.fitContent).not.toHaveBeenCalled();
    expect(chartInstances[0].timeScaleApi.setVisibleLogicalRange).toHaveBeenCalledWith(expect.objectContaining({
      from: 0,
      to: expect.any(Number),
    }));
    const range = chartInstances[0].timeScaleApi.setVisibleLogicalRange.mock.calls.at(-1)?.[0];
    expect(range.to).toBeGreaterThan(CALENDAR_BUNDLE.candles.length);
  });

  it('1m mounts bid peak overlay, calendar does not', () => {
    renderAt('1m');
    expect(bidPeakMounts).toHaveLength(1);
    bidPeakMounts.length = 0;
    renderAt('D');
    expect(bidPeakMounts).toHaveLength(0);
  });

  it('mounts one shared peak-wall docked label overlay for minute charts', async () => {
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });
    renderAt('1m');

    await waitFor(() => {
      expect(askPeakMounts).toHaveLength(1);
      expect(bidPeakMounts).toHaveLength(1);
      expect(dockedLabelMounts).toHaveLength(1);
    });
  });
});

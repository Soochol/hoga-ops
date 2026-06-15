import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

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
const { mounted, askPeakMounts } = vi.hoisted(() => ({
  mounted: [] as string[],
  askPeakMounts: [] as string[],
}));
vi.mock('../chart/RangeSeriesPane', () => ({
  default: (props: { spec: { name: string } }) => {
    mounted.push(props.spec.name);
    return null;
  },
}));

vi.mock('./LiveAskPeakSegments', () => ({
  default: () => {
    askPeakMounts.push('mounted');
    return null;
  },
}));

vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChartEx: vi.fn(() => ({
      addSeries: vi.fn(() => ({
        setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(), applyOptions: vi.fn(),
        priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
        createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
        removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), setMarkers: vi.fn(),
      })),
      removeSeries: vi.fn(),
      timeScale: vi.fn(() => ({
        subscribeVisibleTimeRangeChange: vi.fn(), unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(), fitContent: vi.fn(), scrollToRealTime: vi.fn(), scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(), getVisibleRange: vi.fn(() => null), setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(), resize: vi.fn(), applyOptions: vi.fn(),
      subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
      chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 })),
    })),
  };
});

import { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
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
  investorPoints: [],
  ask_peaks: [],
};

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

function renderAt(timeframe: '1m' | 'D') {
  render(
    <LiveChartRoot
      code="005930"
      timeframe={timeframe}
      bundle={DEFAULT_BUNDLE}
      clampEngaged={false}
      isPastCandlesLoading={false}
    />,
    { wrapper },
  );
}

describe('LiveChartRoot — pane 토글 배선 (store → 마운트된 pane 집합)', () => {
  beforeEach(() => {
    mounted.length = 0;
    askPeakMounts.length = 0;
    // Deterministic baseline: all togglable panes ON, investor OFF.
    useLivePageStore.setState({
      historicalFromDate: null,
      volumeEnabled: true,
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      foreignNetEnabled: false,
      institutionNetEnabled: false,
    });
  });

  it('기본(전부 ON) 1m → 5 pane 마운트', () => {
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength']);
  });

  it('quoteTotalsEnabled=false → 총잔량 pane 미마운트', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: false });
    renderAt('1m');
    expect(mounted).not.toContain('quote-totals');
    expect(mounted).toContain('ratio');
    expect(mounted).toContain('fill-strength');
  });

  it('ratio·fill 동시 off → candle·volume·총잔량만', () => {
    useLivePageStore.setState({ ratioEnabled: false, fillStrengthEnabled: false });
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals']);
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

  it('1m → 당일 매도 최대벽 오버레이 마운트', () => {
    renderAt('1m');
    expect(askPeakMounts).toEqual(['mounted']);
  });

  it('calendar(D) → 당일 매도 최대벽 오버레이 미마운트', () => {
    renderAt('D');
    expect(askPeakMounts).toEqual([]);
  });
});

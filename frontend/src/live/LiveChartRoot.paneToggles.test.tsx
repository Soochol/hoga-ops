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
const { mounted, askPeakMounts, chartInstances, registerViewportCaptureMock, saveViewportToActiveTabMock } = vi.hoisted(() => ({
  mounted: [] as string[],
  askPeakMounts: [] as string[],
  chartInstances: [] as Array<{
    remove: ReturnType<typeof vi.fn>;
    timeScaleApi: {
      subscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      unsubscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
    };
  }>,
  registerViewportCaptureMock: vi.fn(),
  saveViewportToActiveTabMock: vi.fn(),
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

vi.mock('../state/liveTabs', () => ({
  registerViewportCapture: (capture: unknown) => {
    registerViewportCaptureMock(capture);
    return vi.fn();
  },
  saveViewportToActiveTab: saveViewportToActiveTabMock,
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
    askPeakMounts.length = 0;
    chartInstances.length = 0;
    registerViewportCaptureMock.mockClear();
    saveViewportToActiveTabMock.mockClear();
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
      },
    });
    expect(mounted).toEqual(['candle', 'quote-totals', 'fill-strength']);
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

  it('persistLiveViewport=false이면 live tab viewport capture를 등록하지 않는다', () => {
    renderAt('1m', { persistLiveViewport: false });
    expect(registerViewportCaptureMock).not.toHaveBeenCalled();
  });

  it('1m → 당일 매도 최대벽 오버레이 마운트', () => {
    renderAt('1m');
    expect(askPeakMounts).toEqual(['mounted']);
  });

  it.each(['D', 'W', 'M'] as const)('calendar(%s) → 당일 매도 최대벽 오버레이 미마운트', (timeframe) => {
    renderAt(timeframe);
    expect(askPeakMounts).toEqual([]);
  });
});

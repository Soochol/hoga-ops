import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

let drawingHover: ((point: { x: number; y: number }) => void) | undefined;

vi.mock('../chart/DrawingOverlay', () => ({
  default: (props: { onChartHoverPassthrough?: (point: { x: number; y: number }) => void }) => {
    drawingHover = props.onChartHoverPassthrough;
    return <div data-testid="drawing-overlay-stub" />;
  },
}));

vi.mock('../chart/RangeSeriesPane', () => ({
  default: () => <div data-testid="range-series-pane-stub" />,
}));

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
        getVisibleLogicalRange: vi.fn(() => null),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        timeToCoordinate: vi.fn(() => null),
        coordinateToTime: vi.fn(() => 60),
        coordinateToLogical: vi.fn(() => null),
        width: vi.fn(() => 800),
        timeToIndex: vi.fn(() => null),
      })),
      panes: vi.fn(() => []),
      remove: vi.fn(),
      resize: vi.fn(),
      applyOptions: vi.fn(),
      options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      subscribeClick: vi.fn(),
      unsubscribeClick: vi.fn(),
      chartElement: vi.fn(() => ({ clientWidth: 800, clientHeight: 400 })),
    })),
  };
});

import { LiveChartRoot } from './LiveChartRoot';
import { useLiveCursorStore } from './useLiveCursorStore';
import type { RangeBundle } from '../api/types';

const sessionOpenMs = Date.UTC(2026, 5, 19, 0, 0, 0);

const bundle: RangeBundle = {
  code: '005930',
  from_date: '20260619',
  to_date: '20260619',
  bucket_ms: 60_000,
  segments: [
    {
      date: '20260619',
      session_open_ms: sessionOpenMs,
      session_close_ms: sessionOpenMs + 23_400_000,
      source: 'kis_live',
    },
  ],
  candles: [
    { ts_ms: sessionOpenMs, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 },
    { ts_ms: sessionOpenMs + 60_000, open: 2, high: 3, low: 2, close: 3, vol_a: 1, vol_b: 0 },
  ],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('LiveChartRoot drawing hover passthrough', () => {
  beforeEach(() => {
    drawingHover = undefined;
    useLiveCursorStore.getState().resetCursor();
  });

  it('keeps live cursor indicators on the underlying candle while the drawing overlay receives hover', async () => {
    const onCursorActiveChange = vi.fn();

    render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        onCursorActiveChange={onCursorActiveChange}
      />,
      { wrapper },
    );

    expect(drawingHover).toBeTypeOf('function');

    act(() => {
      drawingHover?.({ x: 120, y: 80 });
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(onCursorActiveChange).toHaveBeenLastCalledWith(true);
    expect(useLiveCursorStore.getState().cursorMs).toBe(sessionOpenMs);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import HighLowAnnotationOverlay from './HighLowAnnotationOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Candle, RangeBundle } from '../api/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';

const OPEN = Date.UTC(2026, 5, 12, 0, 0, 0); // 09:00 KST
const CLOSE = OPEN + 6.5 * 3_600_000;
const axis = createVirtualAxis(
  [{ date: '20260612', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }],
  OPEN,
);

function candle(tsMs: number, high: number, low: number, close: number): Candle {
  return { ts_ms: tsMs, open: close, close, high, low, vol_a: 0, vol_b: 0 };
}

// 고가 38,800 @09:02 / 저가 36,750 @09:03 / 현재가(마지막 종가) 37,100.
const bundle = {
  candles: [
    candle(OPEN + 60_000, 37_000, 36_900, 36_950),
    candle(OPEN + 120_000, 38_800, 38_000, 38_200),
    candle(OPEN + 180_000, 37_500, 36_750, 37_100),
  ],
} as RangeBundle;

function makeChart(timeToCoordinate: () => number | null) {
  return {
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
      getVisibleRange: () => ({ from: OPEN / 1000, to: CLOSE / 1000 }),
      timeToCoordinate,
    }),
  } as never;
}

function paneSeries(priceToCoordinate: () => number | null): PaneSeriesMap {
  return new Map([['candle' as PaneId, { priceToCoordinate } as never]]) as never;
}

function renderOverlay(opts?: {
  timeToCoordinate?: () => number | null;
  priceToCoordinate?: () => number | null;
  bundle?: RangeBundle;
}) {
  return render(
    <HighLowAnnotationOverlay
      chart={makeChart(opts?.timeToCoordinate ?? (() => 100))}
      bundle={opts?.bundle ?? bundle}
      axis={axis}
      paneSeries={paneSeries(opts?.priceToCoordinate ?? (() => 50))}
      timeframe="1m"
    />,
  );
}

describe('HighLowAnnotationOverlay', () => {
  beforeEach(() => useChartPrefsStore.setState({ highLowLabelsEnabled: true }));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the high (빨강) and low (파랑) extreme labels when enabled', () => {
    renderOverlay();
    expect(screen.getByTestId('highlow-label-high')).toHaveTextContent('38,800원');
    expect(screen.getByTestId('highlow-label-high')).toHaveTextContent('09:02');
    expect(screen.getByTestId('highlow-label-low')).toHaveTextContent('36,750원');
    // 극값 대비율 부호: 현재가 37,100 → 고가 음수, 저가 양수.
    expect(screen.getByTestId('highlow-label-high').textContent).toMatch(/-\d+\.\d{2}%/);
    expect(screen.getByTestId('highlow-label-low').textContent).toMatch(/\+\d+\.\d{2}%/);
  });

  it('renders nothing when the toggle is off', () => {
    useChartPrefsStore.setState({ highLowLabelsEnabled: false });
    renderOverlay();
    expect(screen.queryByTestId('highlow-label-high')).toBeNull();
    expect(screen.queryByTestId('highlow-label-low')).toBeNull();
  });

  it('skips a label when its coordinate is null (right empty band / off-range)', () => {
    renderOverlay({ timeToCoordinate: () => null });
    expect(screen.queryByTestId('highlow-label-high')).toBeNull();
    expect(screen.queryByTestId('highlow-label-low')).toBeNull();
  });

  it('still renders the container (no labels) when there are no visible extremes', () => {
    // 빈 캔들 → 극값 없음. 컨테이너는 남아 ResizeObserver 가 관측할 노드를 보장(self-heal).
    renderOverlay({ bundle: { candles: [] as Candle[] } as RangeBundle });
    expect(screen.getByTestId('highlow-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('highlow-label-high')).toBeNull();
  });

  it('observes the overlay container with a ResizeObserver (resize self-heal wiring)', () => {
    let observed: Element | null = null;
    class MockRO {
      observe(el: Element) {
        observed = el;
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockRO);

    renderOverlay();

    expect(observed).not.toBeNull();
    expect(observed).toBe(screen.getByTestId('highlow-overlay'));
  });
});

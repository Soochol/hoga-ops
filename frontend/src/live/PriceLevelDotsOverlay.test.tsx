import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PriceLevelDotsOverlay from './PriceLevelDotsOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import { createVirtualAxis } from '../util/virtualAxis';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { PriceLevelHit, RangeBundle } from '../api/types';

const OPEN = Date.UTC(2026, 5, 24, 0, 0, 0);
const CLOSE = OPEN + 6.5 * 3_600_000;
const axis = createVirtualAxis(
  [{ date: '20260624', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }],
  OPEN,
);

const hits: PriceLevelHit[] = [
  { date: '20260624', t_ms: OPEN + 60_000, price: 11_000, kind: 'vi', direction: 'upper', pct: 10 },
  { date: '20260624', t_ms: OPEN + 120_000, price: 13_000, kind: 'limit', direction: 'upper', pct: 30 },
];

const bundle = {
  price_level_hits: hits,
  segments: [{ date: '20260624', session_open_ms: OPEN, session_close_ms: CLOSE }],
  candles: [{ ts_ms: OPEN + 180_000, open: 10_000, high: 13_000, low: 9_000, close: 12_000, vol_a: 0, vol_b: 0 }],
} as RangeBundle;

function makeChart(timeToCoordinate: (time: number) => number | null = () => 100) {
  return {
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
      getVisibleRange: () => ({ from: OPEN / 1000, to: CLOSE / 1000 }),
      timeToCoordinate,
    }),
  } as never;
}

function paneSeries(priceToCoordinate: () => number | null = () => 50): PaneSeriesMap {
  return new Map([['candle' as PaneId, { priceToCoordinate } as never]]) as never;
}

function renderOverlay(opts?: {
  timeToCoordinate?: (time: number) => number | null;
  priceToCoordinate?: () => number | null;
  bundle?: RangeBundle;
}) {
  return render(
    <PriceLevelDotsOverlay
      chart={makeChart(opts?.timeToCoordinate)}
      bundle={opts?.bundle ?? bundle}
      axis={axis}
      paneSeries={paneSeries(opts?.priceToCoordinate)}
    />,
  );
}

describe('PriceLevelDotsOverlay', () => {
  beforeEach(() => {
    // 토글과 스타일이 같은 스토어 — 스타일이 지표 버킷/livePage 폴백에서
    // chartPrefs 로 합쳐졌다(#759 구현 중 발견).
    useChartPrefsStore.setState({
      viLimitPriceDotsEnabled: true,
      viLimitPriceLineColor: '#A855F7',
      viLimitPriceLineWidth: 4,
    });
  });
  afterEach(() => cleanup());

  it('renders VI and limit price lines with accessible labels', () => {
    renderOverlay();

    expect(screen.getByLabelText('VI +10% 11,000원 09:01')).toBeInTheDocument();
    expect(screen.getByLabelText('상한가 13,000원 09:02')).toBeInTheDocument();
  });

  it('renders nothing when the toggle is off', () => {
    useChartPrefsStore.setState({ viLimitPriceDotsEnabled: false });
    renderOverlay();

    expect(screen.queryByTestId('price-level-lines-overlay')).toBeNull();
  });

  it('skips lines when chart coordinates are null', () => {
    renderOverlay({ timeToCoordinate: () => null });

    expect(screen.getByTestId('price-level-lines-overlay')).toBeInTheDocument();
    expect(screen.queryByLabelText('VI +10% 11,000원 09:01')).toBeNull();
  });

  it('renders foreground price lines using the configured style', () => {
    renderOverlay({
      timeToCoordinate: (time) => {
        if (time === OPEN / 1000) return 10;
        if (time === CLOSE / 1000) return 210;
        return 100;
      },
    });

    expect(screen.getByTestId('price-level-lines-overlay')).toHaveStyle({
      zIndex: '20',
    });
    expect(screen.getByTestId('price-level-line-vi-upper-10')).toHaveStyle({
      left: '10px',
      width: '200px',
      height: '4px',
      backgroundColor: '#A855F7',
    });
  });
});

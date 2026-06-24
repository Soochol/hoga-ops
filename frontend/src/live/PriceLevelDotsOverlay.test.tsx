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

const bundle = { price_level_hits: hits } as RangeBundle;

function makeChart(timeToCoordinate: () => number | null = () => 100) {
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
  timeToCoordinate?: () => number | null;
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
  beforeEach(() => useChartPrefsStore.setState({ viLimitPriceDotsEnabled: true }));
  afterEach(() => cleanup());

  it('renders VI and limit dots with accessible labels', () => {
    renderOverlay();

    expect(screen.getByLabelText('VI +10% 11,000원 09:01')).toBeInTheDocument();
    expect(screen.getByLabelText('상한가 13,000원 09:02')).toBeInTheDocument();
  });

  it('renders nothing when the toggle is off', () => {
    useChartPrefsStore.setState({ viLimitPriceDotsEnabled: false });
    renderOverlay();

    expect(screen.queryByTestId('price-level-dots-overlay')).toBeNull();
  });

  it('skips dots when chart coordinates are null', () => {
    renderOverlay({ timeToCoordinate: () => null });

    expect(screen.getByTestId('price-level-dots-overlay')).toBeInTheDocument();
    expect(screen.queryByLabelText('VI +10% 11,000원 09:01')).toBeNull();
  });

  it('uses a smaller solid VI dot and a ringed limit dot', () => {
    renderOverlay();

    expect(screen.getByTestId('price-level-dot-vi-upper-10')).toHaveStyle({
      width: '6px',
      height: '6px',
    });
    expect(screen.getByTestId('price-level-dot-limit-upper-30')).toHaveStyle({
      width: '7px',
      height: '7px',
      boxSizing: 'border-box',
    });
    expect(screen.getByTestId('price-level-dot-limit-upper-30').getAttribute('style')).toContain('border: 1px solid');
  });
});

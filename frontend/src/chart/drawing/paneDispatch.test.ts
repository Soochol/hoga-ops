// frontend/src/chart/drawing/paneDispatch.test.ts
//
// Unit tests for paneIdToIndex / paneIdAtY / clampYToPane / paneTopY. All
// four now resolve a pane's index at RUNTIME from the mounted `paneSeries`
// (each series' getPane().paneIndex()), not a static PANE_SPECS lookup — so a
// conditionally-mounted pane (volume off, investor panes) shifts every index
// below it and these helpers must track that shift. The chart stub still
// supplies pane heights via chart.panes().

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import {
  paneIdToIndex,
  paneIdAtY,
  clampYToPane,
  paneTopY,
  canvasYToPrice,
  type PaneSeriesMap,
} from './chartCoordinates';
import type { PaneId } from './types';

/** Stub IChartApi whose panes() returns objects with the given heights, in
 *  the actual mounted (runtime) order. */
function chartWithHeights(heights: number[]): IChartApi {
  return {
    panes: vi.fn(() => heights.map((h) => ({ getHeight: () => h }))),
  } as unknown as IChartApi;
}

/** Stub paneSeries: each paneId's primary series reports its runtime pane
 *  index via getPane().paneIndex(), matching the mounted order. */
function paneSeriesFor(paneIds: PaneId[]): PaneSeriesMap {
  const m = new Map<PaneId, ISeriesApi<'Line'>>();
  paneIds.forEach((id, i) => {
    m.set(id, {
      getPane: () => ({ paneIndex: () => i }),
    } as unknown as ISeriesApi<'Line'>);
  });
  return m;
}

const FULL: PaneId[] = ['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength'];
// Volume off on a minute timeframe — every pane below volume shifts up one.
const NO_VOLUME: PaneId[] = ['candle', 'quote-totals', 'ratio', 'fill-strength'];

describe('paneIdToIndex (runtime)', () => {
  it('resolves each mounted paneId to its runtime pane index', () => {
    const ps = paneSeriesFor(FULL);
    FULL.forEach((id, i) => expect(paneIdToIndex(ps, id)).toBe(i));
  });

  it('returns -1 for a paneId that is not currently mounted', () => {
    expect(paneIdToIndex(paneSeriesFor(['candle']), 'volume')).toBe(-1);
  });

  it('tracks the index shift when volume is absent (quote-totals moves 2 -> 1)', () => {
    const ps = paneSeriesFor(NO_VOLUME);
    expect(paneIdToIndex(ps, 'quote-totals')).toBe(1);
    expect(paneIdToIndex(ps, 'fill-strength')).toBe(3);
    expect(paneIdToIndex(ps, 'volume')).toBe(-1);
  });
});

describe('paneIdAtY (runtime)', () => {
  const heights = [400, 80, 80, 80, 80];

  it('returns candle for py inside pane 0', () => {
    const ps = paneSeriesFor(FULL);
    expect(paneIdAtY(chartWithHeights(heights), ps, 0)).toBe('candle');
    expect(paneIdAtY(chartWithHeights(heights), ps, 399)).toBe('candle');
  });

  it('returns volume for py inside pane 1', () => {
    const ps = paneSeriesFor(FULL);
    expect(paneIdAtY(chartWithHeights(heights), ps, 400)).toBe('volume');
    expect(paneIdAtY(chartWithHeights(heights), ps, 479)).toBe('volume');
  });

  it('returns quote-totals for py inside pane 2', () => {
    const ps = paneSeriesFor(FULL);
    expect(paneIdAtY(chartWithHeights(heights), ps, 480)).toBe('quote-totals');
  });

  it('maps pane 1 to quote-totals when volume is absent (runtime reverse-map)', () => {
    const ps = paneSeriesFor(NO_VOLUME);
    const noVolHeights = [400, 80, 80, 80];
    expect(paneIdAtY(chartWithHeights(noVolHeights), ps, 400)).toBe('quote-totals');
  });

  it('clamps to last pane when py is past the chart bottom', () => {
    const ps = paneSeriesFor(FULL);
    expect(paneIdAtY(chartWithHeights(heights), ps, 9999)).toBe('fill-strength');
  });

  it('clamps to first pane when py is negative', () => {
    const ps = paneSeriesFor(FULL);
    expect(paneIdAtY(chartWithHeights(heights), ps, -10)).toBe('candle');
  });
});

describe('clampYToPane (runtime)', () => {
  const heights = [400, 80, 80, 80, 80];
  const chart = chartWithHeights(heights);
  const ps = paneSeriesFor(FULL);

  it('passes through a py inside the candle pane unchanged', () => {
    expect(clampYToPane(chart, ps, 'candle', 250)).toBe(250);
  });

  it('clamps a py above the volume pane to the volume top', () => {
    expect(clampYToPane(chart, ps, 'volume', 100)).toBe(400);
  });

  it('clamps a py below the volume pane to volume bottom - 1', () => {
    expect(clampYToPane(chart, ps, 'volume', 600)).toBe(479);
  });

  it('clamps a py inside quote-totals that strays into ratio', () => {
    expect(clampYToPane(chart, ps, 'quote-totals', 600)).toBe(559);
  });
});

describe('paneTopY (runtime)', () => {
  const heights = [400, 80, 80, 80, 80];
  const chart = chartWithHeights(heights);

  it('returns 0 for the candle pane', () => {
    expect(paneTopY(chart, paneSeriesFor(FULL), 'candle')).toBe(0);
  });

  it('returns the cumulative height above each indicator pane', () => {
    const ps = paneSeriesFor(FULL);
    expect(paneTopY(chart, ps, 'volume')).toBe(400);
    expect(paneTopY(chart, ps, 'quote-totals')).toBe(480);
    expect(paneTopY(chart, ps, 'fill-strength')).toBe(640);
  });

  it('reflects the shifted offset when volume is absent', () => {
    const noVolHeights = [400, 80, 80, 80];
    const ps = paneSeriesFor(NO_VOLUME);
    // quote-totals now sits directly under candle.
    expect(paneTopY(chartWithHeights(noVolHeights), ps, 'quote-totals')).toBe(400);
  });
});

describe('canvasYToPrice (time-independent Y → price)', () => {
  const heights = [400, 80, 80, 80, 80];
  const chart = chartWithHeights(heights);

  /** paneSeries whose series record the pane-local Y handed to
   *  coordinateToPrice, so we can assert the paneTopY offset was subtracted. */
  function recordingPaneSeries(paneIds: PaneId[], priceFn: (yLocal: number) => number | null) {
    const seen: Record<string, number> = {};
    const m = new Map<PaneId, ISeriesApi<'Line'>>();
    paneIds.forEach((id, i) => {
      m.set(id, {
        getPane: () => ({ paneIndex: () => i }),
        coordinateToPrice: (y: number) => {
          seen[id] = y;
          return priceFn(y);
        },
      } as unknown as ISeriesApi<'Line'>);
    });
    return { ps: m as PaneSeriesMap, seen };
  }

  it('passes the chart-global Y straight through for the candle pane (offset 0)', () => {
    const { ps, seen } = recordingPaneSeries(FULL, (y) => 100_000 - y);
    expect(canvasYToPrice(chart, ps, 'candle', 120)).toBe(100_000 - 120);
    expect(seen.candle).toBe(120); // no offset on pane 0
  });

  it('subtracts paneTopY before resolving an indicator-pane price', () => {
    // volume sits at chart-global y=400..480; a click at global y=440 must
    // resolve as pane-local y=40.
    const { ps, seen } = recordingPaneSeries(FULL, (y) => 5_000 - y);
    expect(canvasYToPrice(chart, ps, 'volume', 440)).toBe(5_000 - 40);
    expect(seen.volume).toBe(40);
  });

  it('returns null when the series is off its price scale', () => {
    const { ps } = recordingPaneSeries(FULL, () => null);
    expect(canvasYToPrice(chart, ps, 'candle', 200)).toBeNull();
  });

  it('returns null when the pane is not mounted', () => {
    const { ps } = recordingPaneSeries(['candle'], (y) => y);
    expect(canvasYToPrice(chart, ps, 'volume', 200)).toBeNull();
  });
});

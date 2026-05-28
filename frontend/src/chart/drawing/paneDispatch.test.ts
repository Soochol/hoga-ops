// frontend/src/chart/drawing/paneDispatch.test.ts
//
// Unit tests for paneIdToIndex / paneIdAtY / clampYToPane. The first is
// a static PANE_SPECS lookup; the latter two depend on a live
// chart.panes() call so we stub IChartApi.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import {
  paneIdToIndex,
  paneIdAtY,
  clampYToPane,
  paneTopY,
} from './chartCoordinates';
import { PANE_SPECS } from '../paneSpecs';

/** Build a stub IChartApi whose panes() returns objects with the given
 *  heights, in PANE_SPECS order. */
function chartWithHeights(heights: number[]): IChartApi {
  return {
    panes: vi.fn(() => heights.map((h) => ({ getHeight: () => h }))),
  } as unknown as IChartApi;
}

describe('paneIdToIndex', () => {
  it('resolves every PaneId literal back to its PANE_SPECS index', () => {
    for (let i = 0; i < PANE_SPECS.length; i++) {
      const id = PANE_SPECS[i].name;
      expect(paneIdToIndex(id)).toBe(i);
    }
  });
});

describe('paneIdAtY', () => {
  // Realistic layout: candle 400, volume 80, quote-totals 80, ratio 80, fill-strength 80
  const heights = [400, 80, 80, 80, 80];

  it('returns candle for py inside pane 0', () => {
    expect(paneIdAtY(chartWithHeights(heights), 0)).toBe('candle');
    expect(paneIdAtY(chartWithHeights(heights), 200)).toBe('candle');
    expect(paneIdAtY(chartWithHeights(heights), 399)).toBe('candle');
  });

  it('returns volume for py inside pane 1', () => {
    expect(paneIdAtY(chartWithHeights(heights), 400)).toBe('volume');
    expect(paneIdAtY(chartWithHeights(heights), 479)).toBe('volume');
  });

  it('returns quote-totals for py inside pane 2', () => {
    expect(paneIdAtY(chartWithHeights(heights), 480)).toBe('quote-totals');
  });

  it('clamps to last pane when py is past the chart bottom', () => {
    expect(paneIdAtY(chartWithHeights(heights), 9999)).toBe('fill-strength');
  });

  it('clamps to first pane when py is negative', () => {
    expect(paneIdAtY(chartWithHeights(heights), -10)).toBe('candle');
  });
});

describe('clampYToPane', () => {
  const heights = [400, 80, 80, 80, 80];
  const chart = chartWithHeights(heights);

  it('passes through a py inside the candle pane unchanged', () => {
    expect(clampYToPane(chart, 'candle', 250)).toBe(250);
  });

  it('clamps a py above the volume pane to the volume top', () => {
    expect(clampYToPane(chart, 'volume', 100)).toBe(400);
  });

  it('clamps a py below the volume pane to volume bottom - 1', () => {
    // volume occupies [400, 480); the clamp returns 479 at the lower edge.
    expect(clampYToPane(chart, 'volume', 600)).toBe(479);
  });

  it('clamps a py inside quote-totals that strays into ratio', () => {
    // quote-totals occupies [480, 560); a py at 600 is in ratio -> clamp to 559.
    expect(clampYToPane(chart, 'quote-totals', 600)).toBe(559);
  });

  it('passes a py exactly at pane top through', () => {
    expect(clampYToPane(chart, 'volume', 400)).toBe(400);
  });
});

describe('paneTopY', () => {
  // The bug this helper fixes: lightweight-charts v5 reports
  // priceToCoordinate / coordinateToPrice in pane-local Y. Without adding
  // paneTopY, drawings on indicator panes used the candle pane's Y space
  // and rendered in the wrong area.
  const heights = [400, 80, 80, 80, 80];
  const chart = chartWithHeights(heights);

  it('returns 0 for the candle pane (no offset, the original single-pane path)', () => {
    expect(paneTopY(chart, 'candle')).toBe(0);
  });

  it('returns the cumulative height above each indicator pane', () => {
    expect(paneTopY(chart, 'volume')).toBe(400);
    expect(paneTopY(chart, 'quote-totals')).toBe(480);
    expect(paneTopY(chart, 'ratio')).toBe(560);
    expect(paneTopY(chart, 'fill-strength')).toBe(640);
  });
});

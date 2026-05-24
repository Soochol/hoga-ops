// frontend/src/chart/drawing/render.test.ts
//
// Direct unit tests for canvas rendering of Drawings. We stub
// CanvasRenderingContext2D as a vi-spy bag so we can assert on the
// shape of the draw calls without running in a browser.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { renderDrawing, type ProjectCtx } from './render';
import type { Hline } from './types';

/** Build a context with all the canvas methods we touch spied. */
function makeCanvasSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '' as CanvasLineCap,
    lineJoin: '' as CanvasLineJoin,
    font: '',
    textBaseline: '' as CanvasTextBaseline,
    textAlign: '' as CanvasTextAlign,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D & {
    fillText: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
  };
}

/** A ProjectCtx whose priceSeries always projects price → y=200.
 *  The chart stub returns a single candle pane (idx 0), so paneTopY
 *  is 0 and priceToCanvasY's pane-offset compensation is a no-op. */
function makeProjectCtx(): ProjectCtx {
  const priceSeries = {
    priceToCoordinate: vi.fn(() => 200),
    coordinateToPrice: vi.fn(),
  } as any;
  return {
    chart: { panes: () => [{ getHeight: () => 400 }] } as unknown as IChartApi,
    axis: {} as ProjectCtx['axis'],
    paneSeries: new Map([['candle', priceSeries]]),
    paneId: 'candle',
    width: 800,
    height: 400,
  };
}

describe('renderHline price badge', () => {
  it('paints the price formatted as ko-KR with thousand separators', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = {
      id: 'h1',
      kind: 'hline',
      price: 74_500,
      color: '#14B8A6',
      width: 1.5,
      paneId: 'candle',
    };
    renderDrawing(c, ctx, h, false);
    const calls = (c.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const labels = calls.map((args) => args[0] as string);
    expect(labels).toContain('74,500');
  });

  it('positions the badge near the right edge (within 100px inset)', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, paneId: 'candle' };
    renderDrawing(c, ctx, h, false);
    const roundRectCalls = (c.roundRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(roundRectCalls.length).toBeGreaterThan(0);
    // The badge background roundRect (first such call when unselected).
    // Args: (x, y, w, h, radius). Assert x is near the right edge.
    const [x] = roundRectCalls[0] as [number, number, number, number, number];
    expect(x).toBeGreaterThan(ctx.width - 100);
    expect(x).toBeLessThan(ctx.width);
  });

  it('preserves fractional precision on non-candle panes (ratio)', () => {
    // Ratio pane lives in −1..1; rounding to KRW integer would collapse
    // −0.34 to 0 and read as misleading "no imbalance". See render.ts
    // formatBadgePrice — candle branch rounds, indicator branch keeps
    // up to 4 fraction digits.
    // Chart stub now has 3 panes — pane 0 (candle 400px), pane 1 (volume 80px),
    // pane 2 (ratio 80px). paneTopY('ratio') = 480; the test's
    // priceToCoordinate returns pane-local 200 which lands at chart-global
    // y = 680 (outside the panes but the test only cares about the badge text).
    const ctx: ProjectCtx = {
      ...makeProjectCtx(),
      chart: {
        panes: () => [
          { getHeight: () => 400 },
          { getHeight: () => 80 },
          { getHeight: () => 80 },
        ],
      } as unknown as IChartApi,
      paneSeries: new Map([['ratio', {
        priceToCoordinate: vi.fn(() => 200),
        coordinateToPrice: vi.fn(),
      } as any]]),
      paneId: 'ratio',
    };
    const c = makeCanvasSpy();
    const h: Hline = {
      id: 'h_ratio', kind: 'hline', price: -0.34,
      color: '#14B8A6', width: 1.5, paneId: 'ratio',
    };
    renderDrawing(c, ctx, h, false);
    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels.some((l) => l.includes('0.34'))).toBe(true);
    expect(labels).not.toContain('0');
  });

  it('does not paint a badge when the price scale is unavailable (y == null)', () => {
    const c = makeCanvasSpy();
    const ctx: ProjectCtx = {
      ...makeProjectCtx(),
      paneSeries: new Map([['candle', {
        priceToCoordinate: vi.fn(() => null),
        coordinateToPrice: vi.fn(),
      } as any]]),
    };
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, paneId: 'candle' };
    renderDrawing(c, ctx, h, false);
    expect((c.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

// frontend/src/chart/drawing/render.test.ts
//
// Direct unit tests for canvas rendering of Drawings. We stub
// CanvasRenderingContext2D as a vi-spy bag so we can assert on the
// shape of the draw calls without running in a browser.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { renderDrawing, renderTrendlineDraft, type ProjectCtx, dashPattern } from './render';
import type { Hline, Trendline } from './types';
import type { TrendlineDraft } from './tools';

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
    setLineDash: vi.fn(),
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
    setLineDash: ReturnType<typeof vi.fn>;
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

function makeProjectCtxWithProjection(): ProjectCtx {
  const priceSeries = {
    priceToCoordinate: vi.fn((price: number) => 300 - price),
    coordinateToPrice: vi.fn(),
  };
  return {
    chart: {
      panes: () => [{ getHeight: () => 400 }],
      timeScale: () => ({
        timeToCoordinate: vi.fn((time: number) => time),
      }),
    } as unknown as IChartApi,
    axis: {
      contains: () => true,
      toVirtual: (realMs: number) => realMs,
    } as unknown as ProjectCtx['axis'],
    paneSeries: new Map([['candle', priceSeries]]) as unknown as ProjectCtx['paneSeries'],
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
      lineStyle: 'solid',
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
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    renderDrawing(c, ctx, h, false);
    const roundRectCalls = (c.roundRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(roundRectCalls.length).toBeGreaterThan(0);
    // The badge background roundRect (first such call when unselected).
    // Args: (x, y, w, h, radius). Assert x is near the right edge.
    const [x] = roundRectCalls[0] as [number, number, number, number, number];
    expect(x).toBeGreaterThan(ctx.width - 100);
    expect(x).toBeLessThan(ctx.width);
  });

  it('renders the ratio pane badge with one fraction digit', () => {
    // User decision 2026-05-25: integers everywhere EXCEPT the ratio
    // pane, whose −1..1 range collapses to "0" at integer resolution.
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
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'ratio',
    };
    renderDrawing(c, ctx, h, false);
    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels.some((l) => l === '-0.3')).toBe(true);
  });

  it('rounds non-ratio indicator panes to integer (volume → no decimal)', () => {
    const ctx: ProjectCtx = {
      ...makeProjectCtx(),
      chart: {
        panes: () => [
          { getHeight: () => 400 },
          { getHeight: () => 80 },
        ],
      } as unknown as IChartApi,
      paneSeries: new Map([['volume', {
        priceToCoordinate: vi.fn(() => 200),
        coordinateToPrice: vi.fn(),
      } as any]]),
      paneId: 'volume',
    };
    const c = makeCanvasSpy();
    const h: Hline = {
      id: 'h_vol', kind: 'hline', price: 12_345.7,
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'volume',
    };
    renderDrawing(c, ctx, h, false);
    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels).toContain('12,346');
    expect(labels.every((l) => !l.includes('.'))).toBe(true);
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
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    renderDrawing(c, ctx, h, false);
    expect((c.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('dashPattern', () => {
  it('returns [] for solid', () => {
    expect(dashPattern('solid', 2)).toEqual([]);
  });
  it('scales dashed with width', () => {
    expect(dashPattern('dashed', 2)).toEqual([6, 4]);
    expect(dashPattern('dashed', 3)).toEqual([9, 6]);
  });
  it('returns [0, width*2.5] for dotted (round-cap dots)', () => {
    expect(dashPattern('dotted', 2)).toEqual([0, 5]);
  });
});

describe('renderTrendlineDraft', () => {
  it('draws a horizontal preview and price-change label from start to current endpoint', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtxWithProjection();
    const draft: TrendlineDraft = {
      a: { realMs: 1_000, price: 100 },
      b: { realMs: 2_000, price: 125 },
      pointerId: 1,
      paneId: 'candle',
    };

    renderTrendlineDraft(c, ctx, draft, {
      color: '#14B8A6',
      width: 2,
      lineStyle: 'solid',
    });

    expect(c.lineTo).toHaveBeenCalledWith(2, 200);
    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels).toContain('+25 (+25.00%)');
  });
});

describe('renderTrendline delta label', () => {
  it('keeps the price-change label after the trendline is committed', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtxWithProjection();
    const t: Trendline = {
      id: 't1',
      kind: 'trendline',
      a: { realMs: 1_000, price: 100 },
      b: { realMs: 2_000, price: 125 },
      color: '#14B8A6',
      width: 2,
      lineStyle: 'solid',
      paneId: 'candle',
    };

    renderDrawing(c, ctx, t, false);

    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels).toContain('+25 (+25.00%)');
  });
});

describe('renderHline lineStyle + lineCap', () => {
  it('applies dashPattern + lineCap from lineStyle', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = {
      id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 2, lineStyle: 'dotted', paneId: 'candle',
    };
    renderDrawing(c, ctx, h, false);
    const setLineDashCalls = (c.setLineDash as ReturnType<typeof vi.fn>).mock.calls;
    expect(setLineDashCalls.length).toBeGreaterThan(0);
    // The last call should be from setStroke in drawHaloThenMain (for the main stroke, not the halo).
    const lastCall = setLineDashCalls[setLineDashCalls.length - 1] as [number[]];
    expect(lastCall[0]).toEqual([0, 5]);
    expect(c.lineCap).toBe('round');
  });
  it('applies solid dashPattern (empty array)', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = {
      id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
    };
    renderDrawing(c, ctx, h, false);
    const setLineDashCalls = (c.setLineDash as ReturnType<typeof vi.fn>).mock.calls;
    expect(setLineDashCalls.length).toBeGreaterThan(0);
    const lastCall = setLineDashCalls[setLineDashCalls.length - 1] as [number[]];
    expect(lastCall[0]).toEqual([]);
    expect(c.lineCap).toBe('butt');
  });
  it('applies dashed dashPattern and butt lineCap', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = {
      id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 3, lineStyle: 'dashed', paneId: 'candle',
    };
    renderDrawing(c, ctx, h, false);
    const setLineDashCalls = (c.setLineDash as ReturnType<typeof vi.fn>).mock.calls;
    expect(setLineDashCalls.length).toBeGreaterThan(0);
    const lastCall = setLineDashCalls[setLineDashCalls.length - 1] as [number[]];
    expect(lastCall[0]).toEqual([9, 6]);
    expect(c.lineCap).toBe('butt');
  });
});

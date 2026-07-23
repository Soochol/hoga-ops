// frontend/src/chart/drawing/render.test.ts
//
// Direct unit tests for canvas rendering of Drawings. We stub
// CanvasRenderingContext2D as a vi-spy bag so we can assert on the
// shape of the draw calls without running in a browser.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { renderDrawing, renderTrendlineDraft, formatMeasureLabel, type ProjectCtx, dashPattern } from './render';
import { createVirtualAxis } from '../../util/virtualAxis';
import type { Hline, Measure, Text, Trendline } from './types';
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

// The measure bar count must be gap-aware: dividing the real-ms span by
// bucketMs counted inter-session gaps as bars (overnight on 1m ≈ +1,050봉).
// Bars are now counted in the virtual (gap-compressed) domain.
describe('formatMeasureLabel — gap-aware bar count', () => {
  const measure = (aMs: number, bMs: number): Measure => ({
    id: 'm1', kind: 'measure',
    a: { realMs: aMs, price: 100 },
    b: { realMs: bMs, price: 120 },
    color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  });

  it('counts only on-screen bars across an overnight gap (intraday)', () => {
    // Sessions A [0, 1_000_000] and B [10_000_000, 11_000_000]; 1m bars.
    const axis = createVirtualAxis([
      { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
      { date: '20260102', sessionOpenMs: 10_000_000, sessionCloseMs: 11_000_000 },
    ]);
    const ctx = {
      axis, bucketMs: 60_000, lastRealMs: 10_900_000, paneId: 'candle',
    } as unknown as ProjectCtx;
    // a: 100_000 before A's close; b: 60_000 into B. Virtual span 161_000
    // (gap compressed to 1s) → ≈3 bars. The old real-ms math divided
    // 9_160_000 by 60_000 → 153봉.
    const label = formatMeasureLabel(measure(900_000, 10_060_000), ctx);
    expect(label.endsWith(' · 3봉')).toBe(true);
  });

  it('counts one bar per trading day on a calendar (D/W/M) axis', () => {
    const axis = createVirtualAxis(
      [
        { date: '20260105', sessionOpenMs: 0, sessionCloseMs: 1_000 },
        { date: '20260106', sessionOpenMs: 100_000, sessionCloseMs: 101_000 },
        { date: '20260107', sessionOpenMs: 200_000, sessionCloseMs: 201_000 },
      ],
      0,
      { mode: 'calendar' },
    );
    const ctx = {
      axis, bucketMs: 86_400_000, lastRealMs: 200_000, paneId: 'candle',
    } as unknown as ProjectCtx;
    // Day 1 anchor → day 3 anchor: 2 bars regardless of the irregular real-ms
    // spacing between the days (the old math gave round(200_000/86_400_000)=0).
    const label = formatMeasureLabel(measure(0, 200_000), ctx);
    expect(label.endsWith(' · 2봉')).toBe(true);
  });

  it('omits the bar count without a bucketMs (unchanged behavior)', () => {
    const axis = createVirtualAxis([
      { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
    ]);
    const ctx = { axis, paneId: 'candle' } as unknown as ProjectCtx;
    expect(formatMeasureLabel(measure(0, 120_000), ctx)).not.toContain('봉');
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
      fontSize: 13,
      fillOpacity: 0.1,
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

describe('renderText off-axis anchor (dragged into an inter-session gap)', () => {
  // Two-session axis with a real gap: seg A [0,1000], seg B [100000,101000].
  // A text anchored at 50000 sits in the gap → off every segment. Pre-fix this
  // made renderText bail (invisible + un-selectable = lost); now it clamps to
  // the nearest boundary and paints there.
  const segA = { sessionOpenMs: 0, sessionCloseMs: 1_000, virtualStart: 0 };
  const segB = { sessionOpenMs: 100_000, sessionCloseMs: 101_000, virtualStart: 2_000 };
  function makeGapCtx(): ProjectCtx {
    return {
      chart: {
        panes: () => [{ getHeight: () => 400 }],
        timeScale: () => ({
          timeToCoordinate: (timeSec: number) => (timeSec * 1000 / 1000) * 10,
          coordinateToTime: () => null,
          coordinateToLogical: (x: number) => x / 10,
          logicalToCoordinate: (logical: number) => logical * 10,
        }),
      } as unknown as IChartApi,
      axis: {
        segments: [segA, segB],
        contains: (rm: number) =>
          (rm >= segA.sessionOpenMs && rm <= segA.sessionCloseMs) ||
          (rm >= segB.sessionOpenMs && rm <= segB.sessionCloseMs),
        toVirtual: (rm: number) =>
          rm <= segA.sessionCloseMs ? rm : rm - segB.sessionOpenMs + segB.virtualStart,
        findByReal: (rm: number) =>
          rm < segA.sessionOpenMs ? -1 : rm >= segB.sessionOpenMs && rm <= segB.sessionCloseMs ? 1 : 0,
      } as unknown as ProjectCtx['axis'],
      paneSeries: new Map([['candle', {
        priceToCoordinate: vi.fn(() => 200),
        coordinateToPrice: vi.fn(),
      } as any]]) as unknown as ProjectCtx['paneSeries'],
      paneId: 'candle',
      width: 800,
      height: 400,
    };
  }

  it('paints the label at the clamped boundary X instead of vanishing', () => {
    const c = makeCanvasSpy();
    const ctx = makeGapCtx();
    const t: Text = {
      id: 'txt1', kind: 'text', at: { realMs: 50_000, price: 100 },
      text: '이동테스트', fontSize: 13, color: '#F43F5E', width: 1,
      lineStyle: 'solid', paneId: 'candle',
    };
    renderDrawing(c, ctx, t, false);
    const calls = (c.fillText as ReturnType<typeof vi.fn>).mock.calls;
    // segA.close (1000) is the nearer boundary → virtual 1000 → x = 10, y = 200.
    expect(calls).toContainEqual(['이동테스트', 10, 200]);
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

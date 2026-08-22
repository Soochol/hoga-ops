// frontend/src/chart/drawing/render.test.ts
//
// Direct unit tests for canvas rendering of Drawings. We stub
// CanvasRenderingContext2D as a vi-spy bag so we can assert on the
// shape of the draw calls without running in a browser.

import { describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import {
  renderDrawing,
  renderHlinePriceBadge,
  renderTrendlineDraft,
  formatMeasureLabel,
  type ProjectCtx,
  dashPattern,
} from './render';
import { realMsToCanvasX, realMsToCanvasXClamped } from './chartCoordinates';
import { createVirtualAxis } from '../../util/virtualAxis';
import type { Hline, Measure, Pencil, Text, Trendline, Vline } from './types';
import type { TrendlineDraft } from './tools';

/** Build a context with all the canvas methods we touch spied. */
function makeCanvasSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    bezierCurveTo: vi.fn(),
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
    bezierCurveTo: ReturnType<typeof vi.fn>;
  };
}

// ProjectCtx now takes its projection as injected closures rather than a chart
// handle, so these stubs are plain functions instead of fake chart/series
// objects. The one exception is makeGapCtx below, which deliberately drives the
// REAL chartCoordinates helpers — the off-axis clamp it exercises is logic
// worth integrating, not stubbing.

/** A ProjectCtx that projects every price → y=200 and resolves no time. */
function makeProjectCtx(): ProjectCtx {
  return {
    realMsToX: () => null,
    realMsToXClamped: () => null,
    priceToY: () => 200,
    width: 800,
    paneBottom: 400,
    paneId: 'candle',
    axis: {} as ProjectCtx['axis'],
  };
}

/** Projects realMs → x as realMs/1000 and price → y as 300−price, over a
 *  single 400px-tall pane. */
function makeProjectCtxWithProjection(): ProjectCtx {
  return {
    realMsToX: (realMs: number) => realMs / 1000,
    realMsToXClamped: (realMs: number) => realMs / 1000,
    priceToY: (price: number) => 300 - price,
    width: 800,
    paneBottom: 400,
    paneId: 'candle',
    axis: {
      contains: () => true,
      toVirtual: (realMs: number) => realMs,
    } as unknown as ProjectCtx['axis'],
  };
}

// The badge moved to the price-axis canvas when drawings became pane
// primitives (the axis column is a separate surface there). `ctx.width` is
// therefore the AXIS column's width, not the whole chart's.
const AXIS_WIDTH = 58;
function makeAxisCtx(): ProjectCtx {
  return { ...makeProjectCtx(), width: AXIS_WIDTH };
}

describe('renderHlinePriceBadge', () => {
  it('paints the price formatted as ko-KR with thousand separators', () => {
    const c = makeCanvasSpy();
    const ctx = makeAxisCtx();
    const h: Hline = {
      id: 'h1',
      kind: 'hline',
      price: 74_500,
      color: '#14B8A6',
      width: 1.5,
      lineStyle: 'solid',
      paneId: 'candle',
    };
    renderHlinePriceBadge(c, ctx, h, false);
    const calls = (c.fillText as ReturnType<typeof vi.fn>).mock.calls;
    const labels = calls.map((args) => args[0] as string);
    expect(labels).toContain('74,500');
  });

  it('right-aligns the badge inside the axis column', () => {
    const c = makeCanvasSpy();
    const ctx = makeAxisCtx();
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    renderHlinePriceBadge(c, ctx, h, false);
    const roundRectCalls = (c.roundRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(roundRectCalls.length).toBeGreaterThan(0);
    // Args: (x, y, w, h, radius). measureText stub → 40, + 2*BADGE_PAD_X = 48
    // wide, inset BADGE_INSET_RIGHT(8) from the axis's right edge → x = 2.
    const [x, , w] = roundRectCalls[0] as [number, number, number, number, number];
    expect(x).toBe(2);
    expect(x + w).toBe(AXIS_WIDTH - 8);
  });

  it('is not drawn by the plot surface — only the line is', () => {
    // Regression guard for the split: renderDrawing must no longer emit badge
    // text, or the badge would be painted twice (once clipped inside the plot).
    const c = makeCanvasSpy();
    const ctx = makeProjectCtx();
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    renderDrawing(c, ctx, h, false);
    expect(c.moveTo).toHaveBeenCalledWith(0, 200);
    expect((c.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('renders the ratio pane badge with one fraction digit', () => {
    // User decision 2026-05-25: integers everywhere EXCEPT the ratio
    // pane, whose −1..1 range collapses to "0" at integer resolution.
    const ctx: ProjectCtx = { ...makeAxisCtx(), paneId: 'ratio' };
    const c = makeCanvasSpy();
    const h: Hline = {
      id: 'h_ratio', kind: 'hline', price: -0.34,
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'ratio',
    };
    renderHlinePriceBadge(c, ctx, h, false);
    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels.some((l) => l === '-0.3')).toBe(true);
  });

  it('rounds non-ratio indicator panes to integer (volume → no decimal)', () => {
    const ctx: ProjectCtx = { ...makeAxisCtx(), paneId: 'volume' };
    const c = makeCanvasSpy();
    const h: Hline = {
      id: 'h_vol', kind: 'hline', price: 12_345.7,
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'volume',
    };
    renderHlinePriceBadge(c, ctx, h, false);
    const labels = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[0] as string);
    expect(labels).toContain('12,346');
    expect(labels.every((l) => !l.includes('.'))).toBe(true);
  });

  it('does not paint a badge when the price scale is unavailable (y == null)', () => {
    const c = makeCanvasSpy();
    const ctx: ProjectCtx = { ...makeAxisCtx(), priceToY: () => null };
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    renderHlinePriceBadge(c, ctx, h, false);
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

// Characterization tests for the vline, pinned down BEFORE the primitive
// migration (ADR pending): a vline is the only Drawing that spans every pane,
// and its time badge is the only element docked to the bottom of the pane
// stack. Both are the most fragile things to move to pane-local rendering, and
// both were previously untested. `makeProjectCtxWithProjection` projects
// realMs → x as realMs/1000 and reports a single 400px-tall pane.
describe('renderVline', () => {
  const vline = (realMs: number): Vline => ({
    id: 'v1', kind: 'vline', realMs,
    color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  });

  it('spans the full pane stack from y=0 to the summed pane height', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtxWithProjection();
    renderDrawing(c, ctx, vline(400_000), false);
    expect(c.moveTo).toHaveBeenCalledWith(400, 0);
    expect(c.lineTo).toHaveBeenCalledWith(400, 400);
  });

  it('docks a KST time badge to the bottom of the pane stack', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtxWithProjection();
    renderDrawing(c, ctx, vline(400_000), false);
    // 400_000ms epoch + 9h KST → 1970-01-01 09:06.
    // Badge box: w = measureText(40) + 2*BADGE_PAD_X(4) = 48, h = 11 + 2*2 = 15.
    // left = clamp(x - w/2) = 376; top = paneBottom(400) - h - 2 = 383.
    // fillText lands at (left + BADGE_PAD_X, top + h/2).
    expect((c.fillText as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      '01.01 09:06', 380, 390.5,
    ]);
  });

  it('clamps the badge inside the right edge when the line is near it', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtxWithProjection();
    renderDrawing(c, ctx, vline(790_000), false);
    // Unclamped left would be 790 - 24 = 766, past width(800) - w(48) - 2 = 750.
    const xs = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[1] as number);
    expect(xs).toContain(754); // 750 + BADGE_PAD_X
  });

  it('clamps the badge inside the left edge when the line is near it', () => {
    const c = makeCanvasSpy();
    const ctx = makeProjectCtxWithProjection();
    renderDrawing(c, ctx, vline(10_000), false);
    // Unclamped left would be 10 - 24 = -14, so it pins to the 2px inset.
    const xs = (c.fillText as ReturnType<typeof vi.fn>).mock.calls.map((a) => a[1] as number);
    expect(xs).toContain(6); // 2 + BADGE_PAD_X
  });

  it('skips entirely when realMs is off the virtual axis', () => {
    const c = makeCanvasSpy();
    const ctx: ProjectCtx = { ...makeProjectCtxWithProjection(), realMsToX: () => null };
    renderDrawing(c, ctx, vline(400_000), false);
    expect(c.moveTo).not.toHaveBeenCalled();
    expect((c.fillText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe('renderText off-axis anchor (dragged into an inter-session gap)', () => {
  // Two-session axis with a real gap: seg A [0,1000], seg B [100000,101000].
  // A text anchored at 50000 sits in the gap → off every segment. Pre-fix this
  // made renderText bail (invisible + un-selectable = lost); now it clamps to
  // the nearest boundary and paints there.
  const segA = { sessionOpenMs: 0, sessionCloseMs: 1_000, virtualStart: 0 };
  const segB = { sessionOpenMs: 100_000, sessionCloseMs: 101_000, virtualStart: 2_000 };
  // Unlike the other stubs this one wires the REAL realMsToCanvasX(Clamped)
  // into the ctx closures: the behaviour under test (an off-axis anchor snapping
  // to the nearest session boundary) lives in chartCoordinates, so stubbing the
  // projection here would assert nothing.
  function makeGapCtx(): ProjectCtx {
    const chart = {
      timeScale: () => ({
        timeToCoordinate: (timeSec: number) => timeSec * 10,
        coordinateToTime: () => null,
        coordinateToLogical: (x: number) => x / 10,
        logicalToCoordinate: (logical: number) => logical * 10,
      }),
    } as unknown as IChartApi;
    const axis = {
      segments: [segA, segB],
      contains: (rm: number) =>
        (rm >= segA.sessionOpenMs && rm <= segA.sessionCloseMs) ||
        (rm >= segB.sessionOpenMs && rm <= segB.sessionCloseMs),
      toVirtual: (rm: number) =>
        rm <= segA.sessionCloseMs ? rm : rm - segB.sessionOpenMs + segB.virtualStart,
      findByReal: (rm: number) =>
        rm < segA.sessionOpenMs ? -1 : rm >= segB.sessionOpenMs && rm <= segB.sessionCloseMs ? 1 : 0,
    } as unknown as ProjectCtx['axis'];
    return {
      realMsToX: (rm: number) => realMsToCanvasX(chart, axis, rm),
      realMsToXClamped: (rm: number) => realMsToCanvasXClamped(chart, axis, rm),
      priceToY: () => 200,
      width: 800,
      paneBottom: 400,
      paneId: 'candle',
      axis,
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

describe('renderPencil — 서브-봉 오프셋', () => {
  /** 3점 stroke. `subX` 를 주면 그만큼 x 가 밀려야 한다. */
  function stroke(subX?: number[]): Pencil {
    return {
      id: 'p1',
      kind: 'pencil',
      points: [
        { realMs: 10_000, price: 100 },
        { realMs: 20_000, price: 120 },
        { realMs: 30_000, price: 110 },
      ],
      subX,
      color: '#14B8A6',
      width: 2,
      lineStyle: 'solid',
      paneId: 'candle',
    };
  }

  /** 이 stroke 가 **지나는 꼭짓점**의 x 를 순서대로. 스플라인이 붙은 뒤로
   *  경로는 `moveTo` + `bezierCurveTo` 로 나오고, 그 끝점(인자 4·5번)이 곧
   *  원래 꼭짓점이다(Catmull–Rom 은 꼭짓점을 지난다 — smooth.test.ts).
   *  `drawHaloThenMain` 이 같은 경로를 두 번 그리므로 첫 패스만 읽는다 —
   *  Set 으로 뭉개면 "밀린 점" 과 "원래 거기 있던 점" 이 구별되지 않는다. */
  function xs(c: ReturnType<typeof makeCanvasSpy>): number[] {
    const move = (c.moveTo as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const bez = (c.bezierCurveTo as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return [move[0][0] as number, bez[0][4] as number, bez[1][4] as number];
  }

  it('subX 가 없으면 봉 앵커 그대로 그린다', () => {
    const c = makeCanvasSpy();
    renderDrawing(c, { ...makeProjectCtxWithProjection(), barPx: 20 }, stroke(), false);
    // realMs/1000 → 10 / 20 / 30. halo 패스가 있어 같은 좌표가 두 번 나온다.
    expect(xs(c)).toEqual([10, 20, 30]);
  });

  it('subX × barPx 만큼 x 를 민다', () => {
    const c = makeCanvasSpy();
    renderDrawing(
      c,
      { ...makeProjectCtxWithProjection(), barPx: 20 },
      stroke([0.25, -0.5, 0.1]),
      false,
    );
    expect(xs(c)).toEqual([15, 10, 32]);
  });

  it('barPx 를 모르면 오프셋을 무시한다 — 봉 앵커로 퇴화', () => {
    // 곱할 픽셀 폭이 없을 때 분수를 픽셀로 착각해 더하면 스트로크가
    // 살짝 어긋난 채 그려진다. 0 으로 떨어지는 쪽이 옳다.
    const c = makeCanvasSpy();
    renderDrawing(c, makeProjectCtxWithProjection(), stroke([0.25, -0.5, 0.1]), false);
    expect(xs(c)).toEqual([10, 20, 30]);
  });

  it('subX 가 points 보다 짧으면 남는 점은 오프셋 0', () => {
    const c = makeCanvasSpy();
    renderDrawing(c, { ...makeProjectCtxWithProjection(), barPx: 20 }, stroke([0.5]), false);
    expect(xs(c)).toEqual([20, 20, 30]);
  });
});

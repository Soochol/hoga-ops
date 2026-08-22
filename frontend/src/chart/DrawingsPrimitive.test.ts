// frontend/src/chart/DrawingsPrimitive.test.ts
//
// The primitive is driven directly (no chart, no React): `attached()` is called
// with stub chart/series, and `draw()` gets a fake CanvasRenderingTarget2D whose
// useMediaCoordinateSpace just invokes the callback. Mirrors the approach in
// DepthHeatmapPrimitive.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import { DrawingsPrimitive, type DrawingsSnapshot } from './DrawingsPrimitive';
import type { Drawing, DrawingStyle, PaneId } from './drawing/types';
import type { VirtualAxis } from '../util/virtualAxis';

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
    arc: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeRect: vi.fn(),
    roundRect: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
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
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    arc: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
  };
}

/** Media scope only — the renderer draws in CSS pixels and lets lwc apply the
 *  device-pixel transform. */
function makeTarget(context: CanvasRenderingContext2D, width = 500, height = 400) {
  return {
    useMediaCoordinateSpace: <T,>(f: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => T): T =>
      f({ context, mediaSize: { width, height } }),
  } as unknown as CanvasRenderingTarget2D;
}

const chart = {
  timeScale: () => ({ timeToCoordinate: (t: number) => t }),
} as unknown as IChartApi;

/** Pane-local projection: price 100 → y 200, and no paneTopY anywhere. */
const series = {
  priceToCoordinate: (price: number) => 300 - price,
} as unknown as ISeriesApi<SeriesType>;

const axis = {
  contains: () => true,
  toVirtual: (realMs: number) => realMs,
} as unknown as VirtualAxis;

const STYLE: DrawingStyle = {
  color: '#14B8A6',
  width: 1.5,
  lineStyle: 'solid',
  fontSize: 13,
  fillOpacity: 0.1,
};

function snapshot(over: Partial<DrawingsSnapshot> = {}): DrawingsSnapshot {
  return {
    drawings: [],
    selectedId: null,
    hiddenAll: false,
    axis,
    drafts: { trendline: null, rect: null, measure: null, pencil: null },
    draftStyles: { trendline: STYLE, rect: STYLE, pencil: STYLE },
    ghost: null,
    ...over,
  };
}

function attach(paneId: PaneId) {
  const prim = new DrawingsPrimitive(paneId);
  const requestUpdate = vi.fn();
  prim.attached({ chart, series, requestUpdate } as never);
  return { prim, requestUpdate };
}

const hline = (paneId: 'candle' | 'volume', price = 100): Drawing => ({
  id: `h_${paneId}`, kind: 'hline', price,
  color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId,
});

const vline = (realMs: number): Drawing => ({
  id: 'v1', kind: 'vline', realMs,
  color: '#F43F5E', width: 1.5, lineStyle: 'solid', paneId: 'candle',
});

function draw(prim: DrawingsPrimitive, c: CanvasRenderingContext2D, size?: { w: number; h: number }) {
  prim.paneViews()[0].renderer()?.draw(makeTarget(c, size?.w, size?.h));
}

/** Draw the price-axis surface, whose canvas is the narrow axis column. */
function drawAxis(prim: DrawingsPrimitive, c: CanvasRenderingContext2D, width = 58) {
  prim.priceAxisPaneViews()[0].renderer()?.draw(makeTarget(c, width, 400));
}

describe('DrawingsPrimitive', () => {
  it('sits above the series by default', () => {
    const { prim } = attach('candle');
    expect(prim.paneViews()[0].zOrder?.()).toBe('top');
  });

  it('draws nothing without a source', () => {
    const { prim } = attach('candle');
    const c = makeCanvasSpy();
    draw(prim, c);
    expect(c.moveTo).not.toHaveBeenCalled();
  });

  it('repaints when the source is wired', () => {
    const { prim, requestUpdate } = attach('candle');
    prim.setSource(() => snapshot());
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it('draws nothing while the layer is hidden', () => {
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drawings: [hline('candle')], hiddenAll: true }));
    const c = makeCanvasSpy();
    draw(prim, c);
    expect(c.moveTo).not.toHaveBeenCalled();
  });

  it('renders only drawings belonging to its own pane', () => {
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drawings: [hline('candle'), hline('volume', 150)] }));
    const c = makeCanvasSpy();
    draw(prim, c);
    // Only the candle-pane hline: price 100 → y 200. The volume one (y 150)
    // belongs to the other pane's primitive.
    const ys = c.moveTo.mock.calls.map((a) => a[1] as number);
    expect(ys).toEqual([200]);
  });

  it('renders a vline on every pane, including panes it did not originate on', () => {
    const { prim } = attach('volume');
    prim.setSource(() => snapshot({ drawings: [vline(400_000)] }));
    const c = makeCanvasSpy();
    draw(prim, c);
    // realMs 400_000 → virtual 400_000 → timeToCoordinate(400) → x 400,
    // spanning this pane's own height (pane-local, not the whole stack).
    expect(c.moveTo).toHaveBeenCalledWith(400, 0);
    expect(c.lineTo).toHaveBeenCalledWith(400, 400);
  });

  it('spans exactly the pane height it is given', () => {
    const { prim } = attach('volume');
    prim.setSource(() => snapshot({ drawings: [vline(400_000)] }));
    const c = makeCanvasSpy();
    draw(prim, c, { w: 500, h: 90 });
    expect(c.lineTo).toHaveBeenCalledWith(400, 90);
  });

  it('draws the live pencil draft on its origin pane only', () => {
    const pencilDraft = {
      points: [{ realMs: 1_000, price: 100 }, { realMs: 2_000, price: 120 }],
      pointerId: 1,
      subX: [],
      lastPx: 0,
      lastPy: 0,
      paneId: 'candle' as const,
    };
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drafts: { trendline: null, rect: null, measure: null, pencil: pencilDraft } }));
    const c = makeCanvasSpy();
    draw(prim, c);
    expect(c.moveTo).toHaveBeenCalledWith(1, 200);
    // 프리뷰도 커밋본과 같은 스플라인 경로를 탄다 — 점이 둘뿐이면 컨트롤이
    // 현 위에 놓여 직선으로 그려지고, 끝점(인자 4·5번)이 그 꼭짓점이다.
    expect(c.bezierCurveTo).toHaveBeenCalledWith(
      expect.any(Number), expect.any(Number),
      expect.any(Number), expect.any(Number),
      2, 180,
    );

    const other = attach('volume');
    other.prim.setSource(() => snapshot({ drafts: { trendline: null, rect: null, measure: null, pencil: pencilDraft } }));
    const c2 = makeCanvasSpy();
    draw(other.prim, c2);
    expect(c2.moveTo).not.toHaveBeenCalled();
  });

  it('drops the ghost snap dot on the cursor pane only', () => {
    const ghost = {
      kind: 'hline' as const, style: STYLE, cursorPx: 42,
      cursorPaneId: 'candle' as const, price: 100, realMs: null, snapped: true,
    };
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ ghost }));
    const c = makeCanvasSpy();
    draw(prim, c);
    expect(c.arc).toHaveBeenCalledWith(42, 200, 3.5, 0, Math.PI * 2);

    // The volume pane sees the same ghost but must not draw an hline preview
    // that belongs to the pane the cursor is over.
    const other = attach('volume');
    other.prim.setSource(() => snapshot({ ghost }));
    const c2 = makeCanvasSpy();
    draw(other.prim, c2);
    expect(c2.arc).not.toHaveBeenCalled();
    expect(c2.moveTo).not.toHaveBeenCalled();
  });

  it('keeps the hline price badge off the plot canvas and on the axis canvas', () => {
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drawings: [hline('candle')] }));

    // Plot surface: the line, no badge text.
    const plot = makeCanvasSpy();
    draw(prim, plot);
    expect(plot.moveTo).toHaveBeenCalledWith(0, 200);
    expect(plot.fillText).not.toHaveBeenCalled();

    // Axis surface: the badge, at the same y, inside the narrow column.
    const axisC = makeCanvasSpy();
    drawAxis(prim, axisC);
    expect(axisC.fillText.mock.calls.map((a) => a[0] as string)).toContain('100');
    const ys = axisC.fillText.mock.calls.map((a) => a[2] as number);
    expect(ys).toContain(200);
  });

  it('draws no axis badge for hlines belonging to another pane', () => {
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drawings: [hline('volume', 150)] }));
    const axisC = makeCanvasSpy();
    drawAxis(prim, axisC);
    expect(axisC.fillText).not.toHaveBeenCalled();
  });

  it('draws the vline time badge only on the pane that owns it', () => {
    const withBadge = attach('volume');
    withBadge.prim.setSource(() =>
      snapshot({ drawings: [vline(400_000)], timeBadgePaneId: 'volume' }),
    );
    const c1 = makeCanvasSpy();
    draw(withBadge.prim, c1);
    expect(c1.fillText).toHaveBeenCalled();

    const noBadge = attach('candle');
    noBadge.prim.setSource(() =>
      snapshot({ drawings: [vline(400_000)], timeBadgePaneId: 'volume' }),
    );
    const c2 = makeCanvasSpy();
    draw(noBadge.prim, c2);
    // Line still drawn on this pane, but the badge belongs to the bottom pane.
    expect(c2.moveTo).toHaveBeenCalledWith(400, 0);
    expect(c2.fillText).not.toHaveBeenCalled();
  });

  it('runs onFrame on every draw so chart-anchored DOM tracks the frame', () => {
    const onFrame = vi.fn();
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ onFrame }));
    const c = makeCanvasSpy();
    draw(prim, c);
    draw(prim, c);
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it('still runs onFrame while the layer is hidden', () => {
    // The text editor is DOM — it stays on screen when drawings are hidden, so
    // it must keep following its anchor even though nothing is painted.
    const onFrame = vi.fn();
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drawings: [hline('candle')], hiddenAll: true, onFrame }));
    const c = makeCanvasSpy();
    draw(prim, c);
    expect(c.moveTo).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('stops drawing once detached', () => {
    const { prim } = attach('candle');
    prim.setSource(() => snapshot({ drawings: [hline('candle')] }));
    prim.detached();
    const c = makeCanvasSpy();
    draw(prim, c);
    expect(c.moveTo).not.toHaveBeenCalled();
  });
});

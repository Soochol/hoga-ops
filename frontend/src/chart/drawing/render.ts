// frontend/src/chart/drawing/render.ts
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { Drawing, Hline, Pencil, Trendline } from './types';

export type ProjectCtx = {
  chart: IChartApi;
  axis: VirtualAxis;
  /** Any series on pane 0 with a real price scale — typically the candle series. */
  priceSeries: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | ISeriesApi<'Area'> | null;
  width: number;
  height: number;
};

function realMsToX(ctx: ProjectCtx, realMs: number): number | null {
  if (!ctx.axis.contains(realMs)) return null;
  const virtualMs = ctx.axis.toVirtual(realMs);
  const x = ctx.chart.timeScale().timeToCoordinate((virtualMs / 1000) as UTCTimestamp);
  return x == null ? null : x;
}

function priceToY(ctx: ProjectCtx, price: number): number | null {
  if (!ctx.priceSeries) return null;
  const y = ctx.priceSeries.priceToCoordinate(price);
  return y == null ? null : y;
}

function setStroke(c: CanvasRenderingContext2D, d: Drawing, selected: boolean) {
  c.strokeStyle = d.color;
  c.lineWidth = selected ? d.width * 2 : d.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
}

function drawHaloThenMain(
  c: CanvasRenderingContext2D,
  d: Drawing,
  selected: boolean,
  body: () => void,
) {
  if (selected) {
    c.save();
    c.strokeStyle = d.color;
    c.globalAlpha = 0.45;
    c.lineWidth = d.width * 4;
    body();
    c.restore();
  }
  c.save();
  setStroke(c, d, false);
  body();
  c.restore();
}

function renderHline(c: CanvasRenderingContext2D, ctx: ProjectCtx, h: Hline, selected: boolean) {
  const y = priceToY(ctx, h.price);
  if (y == null) return;
  drawHaloThenMain(c, h, selected, () => {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(ctx.width, y);
    c.stroke();
  });
}

function renderTrendline(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  t: Trendline,
  selected: boolean,
) {
  const xa = realMsToX(ctx, t.a.realMs);
  const ya = priceToY(ctx, t.a.price);
  const xb = realMsToX(ctx, t.b.realMs);
  const yb = priceToY(ctx, t.b.price);
  if (xa == null && xb == null) return; // both endpoints off-axis: skip
  if (ya == null || yb == null) return; // price scale not ready
  const x1 = xa ?? 0;
  const x2 = xb ?? ctx.width;
  drawHaloThenMain(c, t, selected, () => {
    c.beginPath();
    c.moveTo(x1, ya);
    c.lineTo(x2, yb);
    c.stroke();
  });
  if (selected) {
    if (xa != null) drawHandle(c, t.color, xa, ya);
    if (xb != null) drawHandle(c, t.color, xb, yb);
  }
}

function drawHandle(c: CanvasRenderingContext2D, color: string, x: number, y: number) {
  c.save();
  c.fillStyle = color;
  c.fillRect(x - 3, y - 3, 6, 6);
  c.restore();
}

function renderPencil(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  p: Pencil,
  selected: boolean,
) {
  // Split the polyline at any off-axis vertex so we draw sub-strokes,
  // not a fictional segment that bridges a gap.
  const segments: { x: number; y: number }[][] = [[]];
  for (const pt of p.points) {
    const x = realMsToX(ctx, pt.realMs);
    const y = priceToY(ctx, pt.price);
    if (x == null || y == null) {
      if (segments[segments.length - 1].length > 0) segments.push([]);
      continue;
    }
    segments[segments.length - 1].push({ x, y });
  }
  drawHaloThenMain(c, p, selected, () => {
    for (const seg of segments) {
      if (seg.length < 2) continue;
      c.beginPath();
      c.moveTo(seg[0].x, seg[0].y);
      for (let i = 1; i < seg.length; i++) c.lineTo(seg[i].x, seg[i].y);
      c.stroke();
    }
  });
}

export function renderDrawing(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  d: Drawing,
  selected: boolean,
) {
  switch (d.kind) {
    case 'hline':
      return renderHline(c, ctx, d, selected);
    case 'trendline':
      return renderTrendline(c, ctx, d, selected);
    case 'pencil':
      return renderPencil(c, ctx, d, selected);
  }
}

export function projectPoint(ctx: ProjectCtx, realMs: number, price: number) {
  return { x: realMsToX(ctx, realMs), y: priceToY(ctx, price) };
}

// frontend/src/chart/drawing/render.ts
import type { IChartApi } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { Drawing, DrawingDefaults, Hline, Pencil, Trendline, PaneId, LineStyle } from './types';
import type { TrendlineDraft } from './tools';
import {
  type PaneSeriesMap,
  priceToCanvasY,
  realMsToCanvasX,
} from './chartCoordinates';

export type ProjectCtx = {
  chart: IChartApi;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  paneId: PaneId;
  width: number;
  height: number;
};

function realMsToX(ctx: ProjectCtx, realMs: number): number | null {
  return realMsToCanvasX(ctx.chart, ctx.axis, realMs);
}

function priceToY(ctx: ProjectCtx, price: number): number | null {
  return priceToCanvasY(ctx.chart, ctx.paneSeries, ctx.paneId, price);
}

export function dashPattern(style: LineStyle, width: number): number[] {
  switch (style) {
    case 'solid':  return [];
    case 'dashed': return [width * 3, width * 2];
    case 'dotted': return [0, width * 2.5];
  }
}

function setStroke(c: CanvasRenderingContext2D, d: Drawing, selected: boolean) {
  c.strokeStyle = d.color;
  c.lineWidth = selected ? d.width * 2 : d.width;
  c.lineCap = d.lineStyle === 'dotted' ? 'round' : 'butt';
  c.lineJoin = 'round';
  c.setLineDash(dashPattern(d.lineStyle, d.width));
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
    c.globalAlpha = 0.3;
    c.lineWidth = d.width * 4;
    c.lineCap = d.lineStyle === 'dotted' ? 'round' : 'butt';
    c.lineJoin = 'round';
    c.setLineDash(dashPattern(d.lineStyle, d.width));
    body();
    c.restore();
  }
  c.save();
  setStroke(c, d, false);
  body();
  c.restore();
}

const BADGE_FONT_PX = 11;
const BADGE_FONT = `${BADGE_FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
const BADGE_PAD_X = 4;
const BADGE_PAD_Y = 2;
const BADGE_INSET_RIGHT = 8;
const BADGE_RADIUS = 2;
const DELTA_LABEL_GAP = 8;

/** W3C relative luminance of an `#RRGGBB` colour, range [0, 1]. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function formatBadgePrice(price: number, paneId: PaneId): string {
  // User decision (2026-05-25): every pane shows integers — except the
  // bid/ask ratio pane (호가비), whose −1..1 range is meaningless at
  // integer resolution. Ratio gets one fraction digit so a hline at
  // −0.34 reads as "-0.3" instead of collapsing to "0".
  if (paneId === 'ratio') {
    return price.toLocaleString('ko-KR', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  return (Math.round(price) || 0).toLocaleString('ko-KR');
}

function drawPriceBadge(
  c: CanvasRenderingContext2D,
  canvasWidth: number,
  y: number,
  price: number,
  paneId: PaneId,
  bgColor: string,
  selected: boolean,
) {
  const text = formatBadgePrice(price, paneId);
  c.save();
  c.font = BADGE_FONT;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const textWidth = c.measureText(text).width;
  const w = textWidth + BADGE_PAD_X * 2;
  const h = BADGE_FONT_PX + BADGE_PAD_Y * 2;
  const x = canvasWidth - BADGE_INSET_RIGHT - w;
  const top = y - h / 2;
  c.fillStyle = bgColor;
  c.beginPath();
  c.roundRect(x, top, w, h, BADGE_RADIUS);
  c.fill();
  if (selected) {
    c.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(x + 0.5, top + 0.5, w - 1, h - 1, BADGE_RADIUS);
    c.stroke();
  }
  c.fillStyle = luminance(bgColor) < 0.5 ? '#FFFFFF' : '#000000';
  c.fillText(text, x + BADGE_PAD_X, y);
  c.restore();
}

function formatDeltaLabel(from: number, to: number, paneId: PaneId): string {
  const delta = to - from;
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const absDelta = Math.abs(delta);
  const price =
    paneId === 'ratio'
      ? absDelta.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : (Math.round(absDelta) || 0).toLocaleString('ko-KR');
  const pct = from === 0 ? 0 : (delta / Math.abs(from)) * 100;
  const pctText = `${sign}${Math.abs(pct).toFixed(2)}%`;
  return `${sign}${price} (${pctText})`;
}

function drawFloatingLabel(
  c: CanvasRenderingContext2D,
  canvasWidth: number,
  x: number,
  y: number,
  text: string,
  bgColor: string,
) {
  c.save();
  c.font = BADGE_FONT;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const textWidth = c.measureText(text).width;
  const w = textWidth + BADGE_PAD_X * 2;
  const h = BADGE_FONT_PX + BADGE_PAD_Y * 2;
  const left = Math.max(4, Math.min(x, canvasWidth - w - 4));
  const top = y - h / 2;
  c.fillStyle = bgColor;
  c.beginPath();
  c.roundRect(left, top, w, h, BADGE_RADIUS);
  c.fill();
  c.fillStyle = luminance(bgColor) < 0.5 ? '#FFFFFF' : '#000000';
  c.fillText(text, left + BADGE_PAD_X, y);
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
  drawPriceBadge(c, ctx.width, y, h.price, h.paneId, h.color, selected);
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
  renderTrendlineDeltaGuide(c, ctx, t, x1, xa, x2, ya);
}

function renderTrendlineDeltaGuide(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  t: Trendline,
  labelAnchorX: number,
  realStartX: number | null,
  guideEndX: number,
  startY: number,
) {
  c.save();
  c.strokeStyle = t.color;
  c.globalAlpha = 0.55;
  c.lineWidth = Math.max(1, t.width);
  c.lineCap = 'butt';
  c.setLineDash([4, 4]);
  c.beginPath();
  c.moveTo(realStartX ?? 0, startY);
  c.lineTo(guideEndX, startY);
  c.stroke();
  c.restore();

  const label = formatDeltaLabel(t.a.price, t.b.price, t.paneId);
  const labelX =
    guideEndX >= labelAnchorX
      ? guideEndX + DELTA_LABEL_GAP
      : guideEndX - DELTA_LABEL_GAP - c.measureText(label).width;
  drawFloatingLabel(c, ctx.width, labelX, startY, label, t.color);
}

function trendlineFromDraft(draft: TrendlineDraft, defaults: DrawingDefaults): Trendline | null {
  if (!draft.b) return null;
  return {
    id: '__trendline_draft__',
    kind: 'trendline',
    a: draft.a,
    b: draft.b,
    color: defaults.color,
    width: defaults.width,
    lineStyle: defaults.lineStyle,
    paneId: draft.paneId,
  };
}

export function renderTrendlineDraft(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  draft: TrendlineDraft,
  defaults: DrawingDefaults,
) {
  const d = trendlineFromDraft(draft, defaults);
  if (!d) return;
  const xa = realMsToX(ctx, d.a.realMs);
  const ya = priceToY(ctx, d.a.price);
  const xb = realMsToX(ctx, d.b.realMs);
  const yb = priceToY(ctx, d.b.price);
  if (xa == null || xb == null || ya == null || yb == null) return;
  c.save();
  c.globalAlpha = 0.9;
  drawHaloThenMain(c, d, false, () => {
    c.beginPath();
    c.moveTo(xa, ya);
    c.lineTo(xb, yb);
    c.stroke();
  });
  c.restore();
  renderTrendlineDeltaGuide(c, ctx, d, xa, xa, xb, ya);
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

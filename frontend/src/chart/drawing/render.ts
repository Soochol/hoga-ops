// frontend/src/chart/drawing/render.ts
import type { IChartApi } from 'lightweight-charts';
import { CANVAS_FONT_STACK } from '../../styles/design-tokens';
import type { VirtualAxis } from '../../util/virtualAxis';
import type {
  Drawing,
  DrawingDefaults,
  Hline,
  Measure,
  Pencil,
  Rect,
  Text,
  Trendline,
  Vline,
  PaneId,
  LineStyle,
} from './types';
import type { TrendlineDraft } from './tools';
import {
  type FutureBand,
  type PaneSeriesMap,
  dragTimeDomain,
  priceToCanvasY,
  realMsToCanvasX,
  realMsToCanvasXClamped,
  totalPanesHeight,
} from './chartCoordinates';
import { INTER_SEGMENT_GAP_MS } from '../../util/time';

export type ProjectCtx = {
  chart: IChartApi;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  paneId: PaneId;
  width: number;
  height: number;
  /** Active timeframe bucket in ms, if known — lets the measure tool report a
   *  bar count. Absent (e.g. daily/aggregated views without a fixed bucket) →
   *  the readout omits the bar count. */
  bucketMs?: number;
  /** Newest candle's realMs — with bucketMs, lets drawings anchored in the
   *  empty band right of the last candle render via extrapolation. */
  lastRealMs?: number;
};

/** Canvas font string for a text-label drawing at `sizePx`. Rendering and
 *  hit-test MUST share this so the measured bounding box matches the pixels. */
export function textFont(sizePx: number): string {
  // CANVAS_FONT_STACK, not a local literal: canvas can't read CSS custom
  // properties, and a second hardcoded stack here would silently drift from the
  // chart axis (which reads the same constant via chartScale.ts).
  return `${sizePx}px ${CANVAS_FONT_STACK}`;
}

// Reused offscreen 2D context for measuring text-label widths in hit-testing —
// shares textFont() with render so the bbox matches the drawn pixels.
let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextWidth(text: string, sizePx: number): number {
  if (measureCtx == null) {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    measureCtx = canvas?.getContext('2d') ?? null;
  }
  if (measureCtx == null) return text.length * sizePx * 0.6; // headless fallback
  measureCtx.font = textFont(sizePx);
  return measureCtx.measureText(text).width;
}

/** Korean-convention direction colors for the measure box: 상승=red, 하락=blue. */
const MEASURE_UP = '#F43F5E';
const MEASURE_DOWN = '#3B82F6';
const MEASURE_FLAT = '#9CA3AF';

function futureBand(ctx: ProjectCtx): FutureBand | undefined {
  return ctx.lastRealMs != null && ctx.bucketMs != null && ctx.bucketMs > 0
    ? { lastRealMs: ctx.lastRealMs, bucketMs: ctx.bucketMs }
    : undefined;
}

function realMsToX(ctx: ProjectCtx, realMs: number): number | null {
  return realMsToCanvasX(ctx.chart, ctx.axis, realMs, futureBand(ctx));
}

/** Off-axis-tolerant X for single-anchor drawings (text): snaps a gap/pre-axis
 *  realMs to the nearest session boundary so the text stays visible + grabbable
 *  instead of vanishing. See `realMsToCanvasXClamped`. */
function realMsToXClamped(ctx: ProjectCtx, realMs: number): number | null {
  return realMsToCanvasXClamped(ctx.chart, ctx.axis, realMs, futureBand(ctx));
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

/** Real Unix-ms → "MM.DD HH:mm" in KST (UTC+9) for the vline time badge. */
function formatKstTime(realMs: number): string {
  const kst = new Date(realMs + 9 * 3600 * 1000);
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const da = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${mo}.${da} ${hh}:${mi}`;
}

/** Time badge centered on `x`, pinned to the bottom of the pane stack — the
 *  vertical-line analogue of hline's right-edge price badge. */
function drawTimeBadge(
  c: CanvasRenderingContext2D,
  canvasWidth: number,
  bottomY: number,
  x: number,
  realMs: number,
  bgColor: string,
  selected: boolean,
) {
  const text = formatKstTime(realMs);
  c.save();
  c.font = BADGE_FONT;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  const textWidth = c.measureText(text).width;
  const w = textWidth + BADGE_PAD_X * 2;
  const h = BADGE_FONT_PX + BADGE_PAD_Y * 2;
  const left = Math.max(2, Math.min(x - w / 2, canvasWidth - w - 2));
  const top = bottomY - h - 2;
  c.fillStyle = bgColor;
  c.beginPath();
  c.roundRect(left, top, w, h, BADGE_RADIUS);
  c.fill();
  if (selected) {
    c.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(left + 0.5, top + 0.5, w - 1, h - 1, BADGE_RADIUS);
    c.stroke();
  }
  c.fillStyle = luminance(bgColor) < 0.5 ? '#FFFFFF' : '#000000';
  c.fillText(text, left + BADGE_PAD_X, top + h / 2);
  c.restore();
}

export function renderVline(c: CanvasRenderingContext2D, ctx: ProjectCtx, v: Vline, selected: boolean) {
  const x = realMsToX(ctx, v.realMs);
  if (x == null) return; // realMs off the current virtual axis → skip
  const bottom = totalPanesHeight(ctx.chart);
  drawHaloThenMain(c, v, selected, () => {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, bottom);
    c.stroke();
  });
  drawTimeBadge(c, ctx.width, bottom, x, v.realMs, v.color, selected);
}

/** Normalize two projected corners into a top-left origin + size, falling back
 *  to the canvas edge when a corner is off the virtual axis (mirrors the
 *  trendline off-axis fallback so a half-visible rect still draws). Returns
 *  null when neither corner resolves horizontally or the price scale is unset. */
function projectRect(
  ctx: ProjectCtx,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
): { x: number; y: number; w: number; h: number } | null {
  const xaRaw = realMsToX(ctx, a.realMs);
  const xbRaw = realMsToX(ctx, b.realMs);
  const ya = priceToY(ctx, a.price);
  const yb = priceToY(ctx, b.price);
  if (ya == null || yb == null) return null;
  if (xaRaw == null && xbRaw == null) return null;
  const xa = xaRaw ?? 0;
  const xb = xbRaw ?? ctx.width;
  const x1 = Math.min(xa, xb);
  const x2 = Math.max(xa, xb);
  const y1 = Math.min(ya, yb);
  const y2 = Math.max(ya, yb);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function renderRectShape(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  r: Rect,
  selected: boolean,
) {
  const box = projectRect(ctx, r.a, r.b);
  if (box == null) return;
  if (r.fillOpacity > 0) {
    c.save();
    c.globalAlpha = r.fillOpacity;
    c.fillStyle = r.color;
    c.fillRect(box.x, box.y, box.w, box.h);
    c.restore();
  }
  drawHaloThenMain(c, r, selected, () => {
    c.strokeRect(box.x, box.y, box.w, box.h);
  });
  if (selected) {
    drawHandle(c, r.color, box.x, box.y);
    drawHandle(c, r.color, box.x + box.w, box.y);
    drawHandle(c, r.color, box.x + box.w, box.y + box.h);
    drawHandle(c, r.color, box.x, box.y + box.h);
  }
}

export function renderRectDraft(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
  defaults: DrawingDefaults,
) {
  const draft: Rect = {
    id: '__rect_draft__',
    kind: 'rect',
    a,
    b,
    color: defaults.color,
    width: defaults.width,
    lineStyle: defaults.lineStyle,
    paneId: 'candle',
    fillOpacity: 0,
  };
  c.save();
  c.globalAlpha = 0.9;
  renderRectShape(c, ctx, draft, false);
  c.restore();
}

/** "X분" or "X시간 Y분" or "X일" for a duration in ms. */
function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min}분`;
  const hours = Math.floor(min / 60);
  const rem = min % 60;
  if (hours < 24) return rem === 0 ? `${hours}시간` : `${hours}시간 ${rem}분`;
  const days = Math.round(hours / 24);
  return `${days}일`;
}

function measureDirColor(a: number, b: number): string {
  if (b > a) return MEASURE_UP;
  if (b < a) return MEASURE_DOWN;
  return MEASURE_FLAT;
}

/** Measure readout: Δprice · elapsed real time · bar count. The DURATION is
 *  deliberately wall-clock (a measure spanning a weekend really covers 3 days),
 *  but the BAR COUNT must be gap-aware: dividing the real-ms span by bucketMs
 *  counted inter-session gaps as bars (an overnight on the 1m timeframe
 *  inflated the count by ~1,050봉). Counting in the virtual (gap-compressed)
 *  domain matches the bars actually on screen; the drag domain also linearizes
 *  the empty right band so a measure with a future-anchored endpoint counts
 *  its extrapolated bars. Exported for tests. */
export function formatMeasureLabel(m: Measure, ctx: ProjectCtx): string {
  const delta = formatDeltaLabel(m.a.price, m.b.price, m.paneId);
  const dur = formatDuration(m.b.realMs - m.a.realMs);
  const parts = [delta, dur];
  const bucketMs = ctx.bucketMs;
  if (bucketMs && bucketMs > 0) {
    const dom = dragTimeDomain(ctx.axis, futureBand(ctx));
    // One bar of virtual time: session-linear on intraday axes, one segment
    // pitch on calendar (D/W/M) axes where each trading day is one bar.
    const vPerBar = ctx.axis.mode === 'calendar' ? INTER_SEGMENT_GAP_MS : bucketMs;
    const bars = Math.round(Math.abs(dom.toVirtual(m.b.realMs) - dom.toVirtual(m.a.realMs)) / vPerBar);
    parts.push(`${bars}봉`);
  }
  return parts.join(' · ');
}

function renderMeasureShape(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  m: Measure,
  selected: boolean,
) {
  const box = projectRect(ctx, m.a, m.b);
  if (box == null) return;
  const dir = measureDirColor(m.a.price, m.b.price);
  // Shaded direction box + border.
  c.save();
  c.globalAlpha = 0.12;
  c.fillStyle = dir;
  c.fillRect(box.x, box.y, box.w, box.h);
  c.restore();
  c.save();
  c.strokeStyle = dir;
  c.lineWidth = selected ? 2 : 1;
  c.setLineDash([4, 3]);
  c.strokeRect(box.x, box.y, box.w, box.h);
  c.restore();
  if (selected) {
    // Handles at the two diagonal endpoints (a, b) — the drag anchors.
    const xa = realMsToX(ctx, m.a.realMs);
    const ya = priceToY(ctx, m.a.price);
    const xb = realMsToX(ctx, m.b.realMs);
    const yb = priceToY(ctx, m.b.price);
    if (xa != null && ya != null) drawHandle(c, dir, xa, ya);
    if (xb != null && yb != null) drawHandle(c, dir, xb, yb);
  }
  // Centered measurement readout.
  const label = formatMeasureLabel(m, ctx);
  drawFloatingLabel(c, ctx.width, box.x + box.w / 2 - c.measureText(label).width / 2, box.y + box.h / 2, label, dir);
}

export function renderMeasureDraft(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  a: { realMs: number; price: number },
  b: { realMs: number; price: number },
) {
  const draft: Measure = {
    id: '__measure_draft__',
    kind: 'measure',
    a,
    b,
    color: MEASURE_FLAT,
    width: 1,
    lineStyle: 'dashed',
    paneId: ctx.paneId,
  };
  renderMeasureShape(c, ctx, draft, false);
}

function renderText(c: CanvasRenderingContext2D, ctx: ProjectCtx, t: Text, selected: boolean) {
  // Clamped X: a text dragged into an inter-session gap / weekend / pre-axis
  // must not vanish (it also becomes un-selectable, so it's lost). Snap to the
  // nearest session boundary — mirrors trendline/rect's `?? 0 / ?? width`.
  const x = realMsToXClamped(ctx, t.at.realMs);
  const y = priceToY(ctx, t.at.price);
  if (x == null || y == null) return;
  c.save();
  c.font = textFont(t.fontSize);
  c.textBaseline = 'top';
  c.textAlign = 'left';
  if (selected) {
    const w = c.measureText(t.text).width;
    c.save();
    c.strokeStyle = t.color;
    c.globalAlpha = 0.6;
    c.lineWidth = 1;
    c.setLineDash([3, 2]);
    c.strokeRect(x - 3, y - 2, w + 6, t.fontSize + 4);
    c.restore();
  }
  c.fillStyle = t.color;
  c.fillText(t.text, x, y);
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
    case 'vline':
      return renderVline(c, ctx, d, selected);
    case 'trendline':
      return renderTrendline(c, ctx, d, selected);
    case 'rect':
      return renderRectShape(c, ctx, d, selected);
    case 'measure':
      return renderMeasureShape(c, ctx, d, selected);
    case 'text':
      return renderText(c, ctx, d, selected);
    case 'pencil':
      return renderPencil(c, ctx, d, selected);
  }
}

export function projectPoint(ctx: ProjectCtx, realMs: number, price: number) {
  return { x: realMsToX(ctx, realMs), y: priceToY(ctx, price) };
}

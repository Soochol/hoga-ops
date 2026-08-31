// frontend/src/chart/drawing/render.ts
import { CANVAS_FONT_STACK } from '../../styles/design-tokens';
import type { VirtualAxis } from '../../util/virtualAxis';
import type {
  Drawing,
  DrawingStyle,
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
import { subBarOffsetPx, isLocked } from './types';
import type { TrendlineDraft } from './tools';
import { type FutureBand, dragBarDomain } from './chartCoordinates';
import type { AlignGuide } from './alignSnap';
import { catmullRomSpans } from './smooth';

/**
 * Everything a render needs to place a Drawing on SOME canvas, with the
 * coordinate projection INJECTED rather than derived from a chart handle.
 *
 * The injection is what lets one renderer serve two coordinate systems:
 *   - a lightweight-charts pane primitive draws in PANE-LOCAL space (origin at
 *     the pane's top, width = the plot area only), and
 *   - the DOM hit-test / text-editor path still works in CHART-GLOBAL space
 *     (origin at the chart's top, width includes the price-axis column).
 *
 * Keeping `chart` / `paneSeries` out of here is the point: a renderer that
 * could reach the chart would inevitably re-derive pane offsets and silently
 * disagree with whichever canvas it was actually drawing on.
 */
export type ProjectCtx = {
  /** Real Unix-ms → X on THIS canvas. Null when off the virtual axis. */
  realMsToX(realMs: number): number | null;
  /** Off-axis-tolerant X for single-anchor drawings (text): a gap / pre-axis
   *  realMs snaps to the nearest session boundary so the label stays visible
   *  AND grabbable instead of vanishing. See `realMsToCanvasXClamped`. */
  realMsToXClamped(realMs: number): number | null;
  /** Price → Y on THIS canvas, for this ctx's pane. */
  priceToY(price: number): number | null;
  /** Width of the canvas being drawn on — the pane plot area under a
   *  primitive, the whole chart element under the DOM overlay. */
  width: number;
  /** Y at which a vline terminates: the summed pane stack in chart-global
   *  space, this pane's own height in pane-local space. */
  paneBottom: number;
  paneId: PaneId;
  axis: VirtualAxis;
  /** Active timeframe bucket in ms, if known — lets the measure tool report a
   *  bar count. Absent (e.g. daily/aggregated views without a fixed bucket) →
   *  the readout omits the bar count. */
  bucketMs?: number;
  /** Newest candle's realMs — with bucketMs, lets drawings anchored in the
   *  empty band right of the last candle render via extrapolation. */
  lastRealMs?: number;
  /** Effective bar width in canvas px (`barPitchPx`). Scales a pencil point's
   *  sub-bar offset back into pixels. Absent → offsets read as 0, i.e. the
   *  bar-anchored geometry this renderer had before `Pencil.subX`. */
  barPx?: number;
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

/**
 * `timeBadge` exists because a vline spans every pane but its time badge must
 * appear exactly once, docked to the bottom of the pane STACK. Under a single
 * chart-global canvas that was implicit; with one primitive per pane, only the
 * bottom-most pane draws it. Defaults to true so a lone-canvas caller (and the
 * characterization tests) keep the original behaviour.
 */
export function renderVline(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  v: Vline,
  selected: boolean,
  timeBadge = true,
) {
  const x = ctx.realMsToX(v.realMs);
  if (x == null) return; // realMs off the current virtual axis → skip
  const bottom = ctx.paneBottom;
  drawHaloThenMain(c, v, selected, () => {
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, bottom);
    c.stroke();
  });
  if (timeBadge) drawTimeBadge(c, ctx.width, bottom, x, v.realMs, v.color, selected);
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
  const xaRaw = ctx.realMsToX(a.realMs);
  const xbRaw = ctx.realMsToX(b.realMs);
  const ya = ctx.priceToY(a.price);
  const yb = ctx.priceToY(b.price);
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
  /** 핸들을 그릴지 — 다중 선택에서는 false (renderDrawingBody 참조). */
  handles: boolean,
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
  if (showHandles(r, handles)) {
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
  style: DrawingStyle,
) {
  const draft: Rect = {
    id: '__rect_draft__',
    kind: 'rect',
    a,
    b,
    color: style.color,
    width: style.width,
    lineStyle: style.lineStyle,
    paneId: 'candle',
    fillOpacity: 0,
  };
  c.save();
  c.globalAlpha = 0.9;
  renderRectShape(c, ctx, draft, false, false);
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
 *  inflated the count by ~1,050봉). The drag domain counts on-screen columns
 *  directly, so a day boundary contributes exactly the one bar it occupies —
 *  the earlier virtual-ms arithmetic scored it as INTER_SEGMENT_GAP_MS, i.e.
 *  1/60th of a bar on 1m, and rounded it away (one bar undercounted per
 *  boundary). The domain also linearizes the empty right band so a measure
 *  with a future-anchored endpoint counts its extrapolated bars. Exported for
 *  tests. */
export function formatMeasureLabel(m: Measure, ctx: ProjectCtx): string {
  const delta = formatDeltaLabel(m.a.price, m.b.price, m.paneId);
  const dur = formatDuration(m.b.realMs - m.a.realMs);
  const parts = [delta, dur];
  const dom = dragBarDomain(ctx.axis, futureBand(ctx));
  // Gated on barSized: without a known bar pitch the domain falls back to
  // virtual ms, whose units are not columns — a count read off it would lie.
  if (dom.barSized) {
    parts.push(`${Math.round(Math.abs(dom.toBar(m.b.realMs) - dom.toBar(m.a.realMs)))}봉`);
  }
  return parts.join(' · ');
}

function renderMeasureShape(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  m: Measure,
  selected: boolean,
  /** 핸들을 그릴지 — 다중 선택에서는 false (renderDrawingBody 참조). */
  handles: boolean,
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
  if (showHandles(m, handles)) {
    // Handles at the two diagonal endpoints (a, b) — the drag anchors.
    const xa = ctx.realMsToX(m.a.realMs);
    const ya = ctx.priceToY(m.a.price);
    const xb = ctx.realMsToX(m.b.realMs);
    const yb = ctx.priceToY(m.b.price);
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
  renderMeasureShape(c, ctx, draft, false, false);
}

function renderText(c: CanvasRenderingContext2D, ctx: ProjectCtx, t: Text, selected: boolean) {
  // Clamped X: a text dragged into an inter-session gap / weekend / pre-axis
  // must not vanish (it also becomes un-selectable, so it's lost). Snap to the
  // nearest session boundary — mirrors trendline/rect's `?? 0 / ?? width`.
  const x = ctx.realMsToXClamped(t.at.realMs);
  const y = ctx.priceToY(t.at.price);
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

/**
 * The LINE only. Its price badge lives on the price-axis canvas, which is a
 * separate surface under a pane primitive — see `renderHlinePriceBadge`. Under
 * the old single chart-global canvas both were one call, because that canvas
 * happened to span the axis column too.
 */
function renderHline(c: CanvasRenderingContext2D, ctx: ProjectCtx, h: Hline, selected: boolean) {
  const y = ctx.priceToY(h.price);
  if (y == null) return;
  drawHaloThenMain(c, h, selected, () => {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(ctx.width, y);
    c.stroke();
  });
}

/**
 * An hline's price badge, drawn on the PRICE-AXIS canvas. `ctx.width` is the
 * axis column's width here, so the existing right-inset math lands the badge in
 * the same place it used to occupy on the chart-global canvas.
 */
export function renderHlinePriceBadge(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  h: Hline,
  selected: boolean,
) {
  const y = ctx.priceToY(h.price);
  if (y == null) return;
  drawPriceBadge(c, ctx.width, y, h.price, h.paneId, h.color, selected);
}

function renderTrendline(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  t: Trendline,
  selected: boolean,
  /** 핸들을 그릴지 — 다중 선택에서는 false (renderDrawingBody 참조). */
  handles: boolean,
) {
  const xa = ctx.realMsToX(t.a.realMs);
  const ya = ctx.priceToY(t.a.price);
  const xb = ctx.realMsToX(t.b.realMs);
  const yb = ctx.priceToY(t.b.price);
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
  if (showHandles(t, handles)) {
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

function trendlineFromDraft(draft: TrendlineDraft, style: DrawingStyle): Trendline | null {
  if (!draft.b) return null;
  return {
    id: '__trendline_draft__',
    kind: 'trendline',
    a: draft.a,
    b: draft.b,
    color: style.color,
    width: style.width,
    lineStyle: style.lineStyle,
    paneId: draft.paneId,
  };
}

export function renderTrendlineDraft(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  draft: TrendlineDraft,
  style: DrawingStyle,
) {
  const d = trendlineFromDraft(draft, style);
  if (!d) return;
  const xa = ctx.realMsToX(d.a.realMs);
  const ya = ctx.priceToY(d.a.price);
  const xb = ctx.realMsToX(d.b.realMs);
  const yb = ctx.priceToY(d.b.price);
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

/**
 * Endpoint/corner handles are drawn only for a drawing whose handles are
 * ENABLED (single selection — see renderDrawingBody) and that can actually be
 * dragged by them. A LOCKED drawing keeps its selection halo — the
 * user must be able to see what they picked, and picking is the only route to
 * the unlock button — but loses the handles, which exist solely to advertise
 * "grab me here" and would be a lie (ADR-0164).
 */
function showHandles(d: Drawing, handles: boolean): boolean {
  return handles && !isLocked(d);
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
  p.points.forEach((pt, i) => {
    const x = ctx.realMsToX(pt.realMs);
    const y = ctx.priceToY(pt.price);
    if (x == null || y == null) {
      if (segments[segments.length - 1].length > 0) segments.push([]);
      return;
    }
    segments[segments.length - 1].push({ x: x + subBarOffsetPx(p, i, ctx.barPx), y });
  });
  drawHaloThenMain(c, p, selected, () => {
    for (const seg of segments) {
      if (seg.length < 2) continue;
      c.beginPath();
      c.moveTo(seg[0].x, seg[0].y);
      // Curve, not chords: RDP keeps only the vertices that define the shape,
      // so straight joins would re-introduce the angularity it was allowed to
      // create. Each sub-segment is splined independently — a two-point piece
      // yields one span whose controls lie on the chord, i.e. a straight line.
      for (const s of catmullRomSpans(seg)) {
        c.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, s.to.x, s.to.y);
      }
      c.stroke();
    }
  });
}

/**
 * Placement preview for the two 1-click line tools — a faint dashed ghost that
 * follows the cursor until the click commits. Expressed in DOMAIN coordinates
 * (price / realMs) rather than cursor pixels so it projects onto whichever
 * canvas is drawing it; the caller resolves magnet snapping first and reports
 * the result via `snapped`, which also gates the dot marking the snapped level.
 *
 * X needs no translation between the two coordinate systems: `timeToCoordinate`
 * is plot-area-relative, and the DOM overlay's left edge IS the plot's left
 * edge (the price axis sits on the right). Only Y differs, and that travels
 * as a price.
 */
export type GhostPreview = {
  kind: 'hline' | 'vline';
  style: DrawingStyle;
  /** Cursor X — identical in chart-global and pane-local space (see above). */
  cursorPx: number;
  /** Pane the cursor is inside. An hline ghost draws only here; a vline ghost
   *  draws in every pane but drops its dot only here. */
  cursorPaneId: PaneId;
  /** Price the ghost sits at (hline), or the dot's level (vline). */
  price: number | null;
  /** Time the vline ghost sits at. Ignored for hline. */
  realMs: number | null;
  /** Whether magnet actually moved the ghost — gates the snap dot. */
  snapped: boolean;
};

export function renderGhostPreview(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  ghost: GhostPreview,
) {
  const isHline = ghost.kind === 'hline';
  const onCursorPane = ghost.cursorPaneId === ctx.paneId;
  // An hline ghost lives on one pane; a vline ghost spans them all.
  if (isHline && !onCursorPane) return;

  const y = ghost.price != null ? ctx.priceToY(ghost.price) : null;
  const x = ghost.realMs != null ? ctx.realMsToX(ghost.realMs) ?? ghost.cursorPx : ghost.cursorPx;
  if (isHline && y == null) return;

  c.save();
  c.strokeStyle = ghost.style.color;
  c.globalAlpha = 0.6;
  c.lineWidth = ghost.style.width;
  c.setLineDash([5, 4]);
  c.beginPath();
  if (isHline) {
    c.moveTo(0, y as number);
    c.lineTo(ctx.width, y as number);
  } else {
    c.moveTo(x, 0);
    c.lineTo(x, ctx.paneBottom);
  }
  c.stroke();
  c.restore();

  if (!ghost.snapped || !onCursorPane || y == null) return;
  c.save();
  c.fillStyle = ghost.style.color;
  c.beginPath();
  c.arc(isHline ? ghost.cursorPx : x, y, 3.5, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/**
 * How far an alignment guide overshoots the two boxes it connects, in canvas px.
 *
 * This is the guide's ONLY visible signal, which is why it is generous. A guide
 * sits by definition ON the aligned edge, so the stretch between the two shapes
 * is hidden under their own strokes — measured in the browser, the 6 px first
 * tried left barely a tick past the corner handles. The overshoot is the part
 * that reads.
 */
const GUIDE_OVERSHOOT = 14;

/**
 * Alignment guide lines for an in-flight drag — the visual half of shape
 * snapping. Drawn in the DRAGGED shape's own color rather than `--accent`:
 * canvas cannot read CSS custom properties (see `textFont`), and the ghost's
 * snap dot already set the precedent that magnet feedback wears the user's
 * annotation color.
 *
 * Silent about anything it cannot project. A guide is transient feedback; a
 * fallback position for one would be a line pointing at the wrong place, which
 * is worse than no line at all.
 */
export function renderAlignGuides(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  guides: readonly AlignGuide[],
  color: string,
) {
  const mine = guides.filter((g) => g.paneId === ctx.paneId);
  if (mine.length === 0) return;
  c.save();
  c.strokeStyle = color;
  c.globalAlpha = 0.85;
  c.lineWidth = 1;
  // Coarser than any shape's dash (`dashPattern` maxes at 3x/2x the stroke
  // width): the guide wears the dragged shape's colour, so the dash rhythm is
  // what separates it from the outline it is lying on top of.
  c.setLineDash([7, 5]);
  for (const g of mine) {
    if (g.axis === 'x') {
      const x = ctx.realMsToX(g.at);
      const y1 = ctx.priceToY(g.from);
      const y2 = ctx.priceToY(g.to);
      if (x == null || y1 == null || y2 == null) continue;
      const lo = Math.min(y1, y2) - GUIDE_OVERSHOOT;
      const hi = Math.max(y1, y2) + GUIDE_OVERSHOOT;
      c.beginPath();
      c.moveTo(x, lo);
      c.lineTo(x, hi);
      c.stroke();
    } else {
      const y = ctx.priceToY(g.at);
      const x1 = ctx.realMsToX(g.from);
      const x2 = ctx.realMsToX(g.to);
      if (y == null || x1 == null || x2 == null) continue;
      const lo = Math.min(x1, x2) - GUIDE_OVERSHOOT;
      const hi = Math.max(x1, x2) + GUIDE_OVERSHOOT;
      c.beginPath();
      c.moveTo(lo, y);
      c.lineTo(hi, y);
      c.stroke();
    }
  }
  c.restore();
}

/** Inset of the lock badge from the shape, in canvas px. */
const LOCK_BADGE_GAP = 9;

/**
 * Where a locked drawing's padlock sits, in canvas px, or null when the shape
 * cannot be projected right now (off-axis, price scale not ready).
 *
 * One anchor per kind, chosen to sit just off the shape rather than on it, so
 * the badge never buries the geometry the user drew. Deliberately NOT
 * `refCoords` (duplicate.ts): that one answers "which vertex do I offset a
 * clone from" and returns nulls for hline's time and vline's price — here both
 * axes must resolve to a pixel, and hline/vline get an edge-anchored position
 * instead.
 */
export function lockBadgeAnchor(ctx: ProjectCtx, d: Drawing): { x: number; y: number } | null {
  const at = (realMs: number, price: number) => {
    const x = ctx.realMsToXClamped(realMs) ?? ctx.realMsToX(realMs);
    const y = ctx.priceToY(price);
    return x == null || y == null ? null : { x: x - LOCK_BADGE_GAP, y: y - LOCK_BADGE_GAP };
  };
  switch (d.kind) {
    case 'hline': {
      // Spans the full width, so there is no meaningful X — pin it to the left
      // edge, the one place guaranteed to be on screen.
      const y = ctx.priceToY(d.price);
      return y == null ? null : { x: LOCK_BADGE_GAP, y: y - LOCK_BADGE_GAP };
    }
    case 'vline': {
      // Mirror image of hline: X is the line, Y is pinned to the top.
      const x = ctx.realMsToX(d.realMs);
      return x == null ? null : { x: x + LOCK_BADGE_GAP, y: LOCK_BADGE_GAP };
    }
    case 'trendline':
    case 'measure':
      // Whichever endpoint is visually higher — the badge reads as belonging to
      // the shape's top, regardless of which way the user drew it.
      return d.a.price >= d.b.price ? at(d.a.realMs, d.a.price) : at(d.b.realMs, d.b.price);
    case 'rect':
      // Top-left of the NORMALIZED box: corners may be stored in either order.
      return at(Math.min(d.a.realMs, d.b.realMs), Math.max(d.a.price, d.b.price));
    case 'text':
      return at(d.at.realMs, d.at.price);
    case 'pencil': {
      const first = d.points[0];
      return first == null ? null : at(first.realMs, first.price);
    }
  }
}

/**
 * A small padlock, drawn as vectors rather than a 🔒 glyph: emoji rasterize
 * differently across platforms and ignore `fillStyle`, so a glyph could neither
 * take the drawing's own colour nor keep a predictable size on a DPR-scaled
 * canvas.
 */
function drawLockBadge(c: CanvasRenderingContext2D, x: number, y: number, color: string) {
  c.save();
  c.globalAlpha = 0.85;
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 1.2;
  c.setLineDash([]);
  // Shackle — a half-circle rising out of the body.
  c.beginPath();
  c.arc(x, y - 2.2, 2.1, Math.PI, 0);
  c.stroke();
  // Body.
  c.beginPath();
  c.rect(x - 3.2, y - 2.2, 6.4, 5);
  c.fill();
  c.restore();
}

export function renderDrawing(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  d: Drawing,
  selected: boolean,
  opts: { vlineTimeBadge?: boolean; handles?: boolean } = {},
) {
  renderDrawingBody(c, ctx, d, selected, opts);
  // Drawn last so it is never overpainted by the shape it labels. A locked
  // drawing is otherwise identifiable only by selecting it (ADR-0164).
  if (isLocked(d)) {
    const a = lockBadgeAnchor(ctx, d);
    if (a) drawLockBadge(c, a.x, a.y, d.color);
  }
}

function renderDrawingBody(
  c: CanvasRenderingContext2D,
  ctx: ProjectCtx,
  d: Drawing,
  selected: boolean,
  opts: { vlineTimeBadge?: boolean; handles?: boolean },
) {
  // 헤일로와 핸들은 **다른 질문**이다. 다중 선택에서는 모두가 헤일로를 갖되
  // 핸들은 아무도 갖지 않는다 — 핸들과 그룹 이동이 같은 픽셀을 두고 다투면,
  // 눌러 보기 전에는 어느 쪽이 이길지 알 수 없기 때문이다. 기본값이 `selected`
  // 라 이 옵션을 넘기지 않는 호출부(드래프트 미리보기)는 전과 같이 동작한다.
  const handles = opts.handles ?? selected;
  switch (d.kind) {
    case 'hline':
      return renderHline(c, ctx, d, selected);
    case 'vline':
      return renderVline(c, ctx, d, selected, opts.vlineTimeBadge ?? true);
    case 'trendline':
      return renderTrendline(c, ctx, d, selected, handles);
    case 'rect':
      return renderRectShape(c, ctx, d, selected, handles);
    case 'measure':
      return renderMeasureShape(c, ctx, d, selected, handles);
    case 'text':
      return renderText(c, ctx, d, selected);
    case 'pencil':
      return renderPencil(c, ctx, d, selected);
  }
}

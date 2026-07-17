// frontend/src/chart/drawing/chartCoordinates.ts
//
// Chart Coordinates — pixel ↔ (realMs, price) conversions for the Drawing
// Overlay. Every Y-conversion is pane-aware: the caller supplies a paneId
// that identifies which pane's price scale to use. lightweight-charts v5
// returns pane-LOCAL Y from `series.priceToCoordinate` / `coordinateToPrice`
// (origin at the pane's top, not the chart's top), so `priceToCanvasY` adds
// `paneTopY(paneId)` and `canvasYToPrice` subtracts it before round-trip.
//
// Pane index is resolved at RUNTIME from `paneSeries` — each registered
// primary series reports its live pane via `getPane().paneIndex()` (LWC v5.2).
// This tracks conditionally-mounted panes (volume off, daily-only investor
// panes): a pane removed at runtime shifts every pane below it, and a static
// PANE_SPECS lookup would mislocate drawings on those shifted panes.

import type { IChartApi, ISeriesApi, Logical, UTCTimestamp } from 'lightweight-charts';
import { INTER_SEGMENT_GAP_MS } from '../../util/time';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PaneId, Point } from './types';

export type PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>;

/**
 * Reference for extrapolating time into the empty band right of the last candle
 * (where `coordinateToTime` returns null). `lastRealMs` is the newest candle's
 * timestamp; `bucketMs` is the timeframe bar length. Drawings anchor there via
 * logical-index extrapolation so a trendline/vline/text can be placed in the
 * whitespace and still round-trips consistently. See the empty-band methods.
 */
export type FutureBand = { lastRealMs: number; bucketMs: number };

/**
 * Gap-aware time domain for horizontal DRAG translation. Body-drag used to
 * shift vertices by Δ-real-ms, but the screen's X axis is the gap-compressed
 * VirtualAxis: the moment the cursor crossed a day boundary, Δms swallowed the
 * whole inter-session gap (overnight ~17.5h, weekends days) and the shifted
 * vertices landed INSIDE a gap — off-axis realMs that `axis.contains()`
 * rejects. One gap-landed corner made a rect/measure stretch to the canvas
 * edge (the `?? 0 / ?? width` render fallback); both corners gap-landed made
 * it vanish from render AND hit-test.
 *
 * Translating in VIRTUAL ms instead preserves the visual shape and guarantees
 * every vertex lands back on-axis: `toReal(toVirtual(ms) + dVirtual)` walks
 * bar-space, not wall-clock space.
 *
 * The virtual domain is extended linearly past the last candle so vertices
 * anchored in the empty right band (created there via FutureBand
 * extrapolation) keep dragging instead of getting clamped onto the last
 * candle. The extension pitch matches the render-side extrapolation: one
 * `bucketMs` of real time per bar, where a bar is `bucketMs` of virtual time
 * on intraday axes and one segment (`INTER_SEGMENT_GAP_MS`) on calendar axes.
 */
export type DragTimeDomain = {
  toVirtual(realMs: number): number;
  toReal(virtualMs: number): number;
  /** Virtual coordinate of the axis origin (first session open) — the left
   *  bound for the shape-preserving horizontal drag cap. */
  originV: number;
};

export function dragTimeDomain(axis: VirtualAxis, future?: FutureBand): DragTimeDomain {
  const hasFuture = future != null && future.bucketMs > 0;
  const vPerBar = hasFuture
    ? axis.mode === 'calendar'
      ? INTER_SEGMENT_GAP_MS
      : future.bucketMs
    : 0;
  const lastV = hasFuture ? axis.toVirtual(future.lastRealMs) : 0;
  return {
    toVirtual(realMs: number): number {
      // Off-axis but past the last candle → the empty right band. Mirrors
      // realMsToCanvasX / extrapolateFutureX so drag and render agree.
      if (hasFuture && realMs > future.lastRealMs && !axis.contains(realMs)) {
        return lastV + ((realMs - future.lastRealMs) / future.bucketMs) * vPerBar;
      }
      // On-axis → exact; in a gap (legacy real-ms-drag leftovers) → toVirtual
      // snaps forward to the next open, self-healing the drawing on its next drag.
      return axis.toVirtual(realMs);
    },
    toReal(virtualMs: number): number {
      // Past the last candle → invert the band extension. For intraday this is
      // identical to axis.toReal inside the last session and continues linearly
      // beyond its close, so the branch boundary introduces no seam.
      if (hasFuture && virtualMs > lastV) {
        return future.lastRealMs + ((virtualMs - lastV) / vPerBar) * future.bucketMs;
      }
      // On-axis result → snap to the bar grid. A Δvirtual measured across a
      // session boundary carries the compressed gap (INTER_SEGMENT_GAP_MS per
      // boundary); applied to a vertex crossing a different number of
      // boundaries it would land ±gap off the bar grid — still `contains()`ed
      // (so the gap-heal above never fires) but unresolvable by
      // timeToCoordinate, which edge-pins the render (`?? 0 / ?? width`).
      // The snap also heals already-misaligned vertices on their next drag.
      const real = axis.toReal(virtualMs);
      return hasFuture ? nearestBarGridRealMs(axis, real, future.bucketMs) : real;
    },
    originV: axis.segments.length > 0 ? axis.segments[0].virtualStart : 0,
  };
}

/**
 * Nearest bar-grid real-ms for an on-axis intraday `realMs`: the containing
 * segment's open plus a whole number of `bucketMs` buckets (capped at the
 * close). Candle times are anchored at each session's open, so this is exactly
 * the ladder `timeToCoordinate` can resolve. Passthrough for calendar axes
 * (their toReal only emits segment opens, which are bar times already) and for
 * off-axis times (the gap / future-band paths own those).
 */
function nearestBarGridRealMs(axis: VirtualAxis, realMs: number, bucketMs: number): number {
  if (axis.mode === 'calendar' || bucketMs <= 0) return realMs;
  const idx = axis.findByReal(realMs);
  if (idx < 0) return realMs;
  const seg = axis.segments[idx];
  if (realMs < seg.sessionOpenMs || realMs > seg.sessionCloseMs) return realMs;
  const sessionLen = seg.sessionCloseMs - seg.sessionOpenMs;
  const snapped = Math.round((realMs - seg.sessionOpenMs) / bucketMs) * bucketMs;
  return seg.sessionOpenMs + Math.min(snapped, sessionLen);
}

/** Core real→canvas-X (in-axis only). Split out so the future-band path can
 *  resolve the last candle's coordinate without re-entering the wrapper. */
function coreRealMsToCanvasX(chart: IChartApi, axis: VirtualAxis, realMs: number): number | null {
  if (!axis.contains(realMs)) return null;
  const virtualMs = axis.toVirtual(realMs);
  const x = chart.timeScale().timeToCoordinate((virtualMs / 1000) as UTCTimestamp);
  return x == null ? null : (x as number);
}

/** realMs (past the last candle) → canvas X via logical-index extrapolation:
 *  bars-ahead = (realMs − lastRealMs) / bucketMs, projected off the last
 *  candle's logical position. Returns null if the last candle can't be located. */
function extrapolateFutureX(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
  future: FutureBand,
): number | null {
  const ts = chart.timeScale();
  const lastX = coreRealMsToCanvasX(chart, axis, future.lastRealMs);
  if (lastX == null) return null;
  const lastLogical = ts.coordinateToLogical(lastX);
  if (lastLogical == null) return null;
  const barsAhead = (realMs - future.lastRealMs) / future.bucketMs;
  const x = ts.logicalToCoordinate(((lastLogical as number) + barsAhead) as Logical);
  return x == null ? null : (x as number);
}

/** Canvas X (in the empty band) → realMs via logical-index extrapolation. Only
 *  extrapolates to the RIGHT of the last candle (the empty band); returns null
 *  for the left whitespace to avoid colliding with real historical time. */
function extrapolateFutureRealMs(
  chart: IChartApi,
  axis: VirtualAxis,
  px: number,
  future: FutureBand,
): number | null {
  const ts = chart.timeScale();
  const lastX = coreRealMsToCanvasX(chart, axis, future.lastRealMs);
  if (lastX == null) return null;
  const lastLogical = ts.coordinateToLogical(lastX);
  const logical = ts.coordinateToLogical(px);
  if (lastLogical == null || logical == null) return null;
  if ((logical as number) <= (lastLogical as number)) return null; // right band only
  return future.lastRealMs + ((logical as number) - (lastLogical as number)) * future.bucketMs;
}

/** A series' live pane index, or -1 if the chart/series is mid-teardown. */
function safePaneIndex(series: ISeriesApi<any>): number {
  try {
    return series.getPane().paneIndex();
  } catch {
    return -1;
  }
}

/**
 * Runtime paneId → pane index via the mounted series' `getPane().paneIndex()`.
 * Returns -1 when the pane isn't currently mounted (toggled off) — callers
 * skip rather than mislocating onto another pane.
 */
export function paneIdToIndex(paneSeries: PaneSeriesMap, paneId: PaneId): number {
  const series = paneSeries.get(paneId);
  return series ? safePaneIndex(series) : -1;
}

/** Reverse map: runtime pane index → paneId, from the mounted series. */
function indexToPaneId(paneSeries: PaneSeriesMap): Map<number, PaneId> {
  const m = new Map<number, PaneId>();
  for (const [paneId, series] of paneSeries) {
    const idx = safePaneIndex(series);
    if (idx >= 0) m.set(idx, paneId);
  }
  return m;
}

/**
 * Real Unix-ms → canvas X. Time axis is shared across panes.
 * Returns null when `realMs` falls outside every Virtual Axis segment.
 */
export function realMsToCanvasX(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
  future?: FutureBand,
): number | null {
  const inAxis = coreRealMsToCanvasX(chart, axis, realMs);
  if (inAxis != null) return inAxis;
  // Empty band right of the last candle: extrapolate so future-anchored
  // drawings still render.
  if (future && future.bucketMs > 0 && realMs > future.lastRealMs) {
    return extrapolateFutureX(chart, axis, realMs, future);
  }
  // On-axis but off the bar grid (a persisted boundary-crossing drag residue,
  // ±INTER_SEGMENT_GAP_MS per crossed session boundary): timeToCoordinate only
  // resolves exact bar times, so retry on the nearest bar. Without this the
  // `?? 0 / ?? width` render fallback pins the vertex to the canvas edge and
  // the drawing appears stretched. The drag path snaps new values (see
  // dragTimeDomain.toReal); this covers drawings saved before that snap.
  if (future && future.bucketMs > 0 && axis.contains(realMs)) {
    const snapped = nearestBarGridRealMs(axis, realMs, future.bucketMs);
    if (snapped !== realMs) return coreRealMsToCanvasX(chart, axis, snapped);
  }
  return null;
}

/**
 * Nearest on-axis realMs for an `realMs` the axis doesn't `contains()`. Used to
 * keep a single-anchor drawing (text) visible instead of vanishing when its
 * anchor is dragged into an inter-session gap / weekend / before the first
 * session. Multi-point drawings survive via `?? 0 / ?? width` edge clamps; a
 * lone point has nothing to clamp to, so we snap the *realMs* to the closest
 * session boundary (which the compressed gap renders adjacent to on screen).
 *
 * - Before the first session → first session's open.
 * - After the last session's close → last session's close.
 * - In a gap between segment N and N+1 → whichever of `N.close` / `N+1.open`
 *   is nearer in real time.
 *
 * Returns null only for an empty axis.
 */
function nearestOnAxisRealMs(axis: VirtualAxis, realMs: number): number | null {
  const segs = axis.segments;
  if (segs.length === 0) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (realMs <= first.sessionOpenMs) return first.sessionOpenMs;
  if (realMs >= last.sessionCloseMs) return last.sessionCloseMs;
  // Somewhere in the interior but off-axis → an inter-session gap. findByReal
  // returns the segment on the LEFT of the gap (the "prior" segment).
  const idx = axis.findByReal(realMs);
  if (idx < 0) return first.sessionOpenMs;
  const prior = segs[idx];
  const next = segs[idx + 1];
  if (!next) return prior.sessionCloseMs;
  const distPrior = realMs - prior.sessionCloseMs;
  const distNext = next.sessionOpenMs - realMs;
  return distPrior <= distNext ? prior.sessionCloseMs : next.sessionOpenMs;
}

/**
 * Like `realMsToCanvasX` but never returns null for a mounted axis: an off-axis
 * `realMs` (gap / weekend / pre-axis) is snapped to the nearest session
 * boundary via `nearestOnAxisRealMs` and projected there. Render and hit-test
 * for a single-anchor text share this so an off-axis text stays both visible
 * AND grabbable (rather than vanishing, then being un-selectable). Still returns
 * null only when the axis is empty or the time scale can't resolve at all.
 */
export function realMsToCanvasXClamped(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
  future?: FutureBand,
): number | null {
  const direct = realMsToCanvasX(chart, axis, realMs, future);
  if (direct != null) return direct;
  const clamped = nearestOnAxisRealMs(axis, realMs);
  if (clamped == null) return null;
  return coreRealMsToCanvasX(chart, axis, clamped);
}

/**
 * Canvas X → real Unix-ms — the time-only inverse of `realMsToCanvasX` and the
 * X-half of `pixelToData`. Used by the vertical-line tool (price-independent)
 * and by vline body-drag, which must resolve horizontally without touching any
 * pane's price scale. Returns null in the chart's empty band where
 * `coordinateToTime` can't resolve a coordinate.
 */
export function canvasXToRealMs(
  chart: IChartApi,
  axis: VirtualAxis,
  px: number,
  future?: FutureBand,
): number | null {
  const timeSec = chart.timeScale().coordinateToTime(px);
  if (timeSec != null) return axis.toReal((timeSec as number) * 1000);
  // Empty band: coordinateToTime is null past the last bar → extrapolate.
  if (future && future.bucketMs > 0) return extrapolateFutureRealMs(chart, axis, px, future);
  return null;
}

/** Total height of all mounted panes (excludes the time-axis strip below).
 *  A vertical line spans this — not the full canvas, which would cross the
 *  axis labels. */
export function totalPanesHeight(chart: IChartApi): number {
  let h = 0;
  for (const p of chart.panes()) h += p.getHeight();
  return h;
}

/**
 * Sum of pane heights above `paneId`. For the candle pane (index 0) this
 * is 0. Returns 0 when the pane isn't mounted.
 *
 * Why this exists: lightweight-charts v5's `series.priceToCoordinate` and
 * `coordinateToPrice` operate in **pane-local Y** (origin at the pane's
 * top, not the chart's top). Drawing renders into a chart-global canvas
 * — we must add the pane offset to land the pixel in the right place,
 * and subtract it before feeding a chart-global Y back to the series.
 */
export function paneTopY(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
): number {
  const idx = paneIdToIndex(paneSeries, paneId);
  if (idx < 0) return 0;
  const panes = chart.panes();
  let top = 0;
  for (let i = 0; i < idx && i < panes.length; i++) top += panes[i].getHeight();
  return top;
}

/**
 * Price → chart-global canvas Y for the pane identified by `paneId`.
 * The series' pane-local Y is shifted by `paneTopY(paneId)` so the
 * caller can draw the result directly onto the overlay canvas without
 * knowing which pane it belongs to.
 *
 * Returns null when that pane's primary series isn't registered or the
 * price falls outside the series' visible price range.
 */
export function priceToCanvasY(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  price: number,
): number | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const yLocal = series.priceToCoordinate(price);
  if (yLocal == null) return null;
  return Number(yLocal) + paneTopY(chart, paneSeries, paneId);
}

/**
 * Chart-global pixel Y → price for the pane identified by `paneId` — the
 * time-independent inverse of `priceToCanvasY` and the Y-half of
 * `pixelToData`. Subtracts the pane offset before calling
 * `series.coordinateToPrice` because that API expects pane-local Y.
 *
 * Unlike `pixelToData` this never touches the time axis, so it resolves
 * everywhere the pane's price scale is mounted — including the chart's empty
 * band to the right of the last candle, where `coordinateToTime` (and thus
 * `pixelToData`) returns null. The body-drag path uses it so a price-only
 * drawing (hline) keeps dragging in that band. Returns null only when the
 * pane's series isn't registered or the Y is off the price scale.
 */
export function canvasYToPrice(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  py: number,
): number | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const yLocal = py - paneTopY(chart, paneSeries, paneId);
  const price = series.coordinateToPrice(yLocal);
  return price == null ? null : Number(price);
}

/**
 * Domain price at the top and bottom edges of `paneId`'s pane, read from the
 * registered series' `coordinateToPrice` at the pane-local top (0) and bottom
 * (pane height). Pane-local because `coordinateToPrice` expects pane-local Y.
 *
 * The shape-preserving translate cap (selectTool body-drag) needs the pane's
 * full price span to clamp a whole Drawing without collapsing it; this is the
 * price-axis sibling of `clampYToPane` (which clamps in pixels). Returns null
 * when the pane or its series isn't mounted, or the price scale can't resolve.
 */
export function priceBoundsForPane(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
): { top: number; bottom: number } | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const idx = paneIdToIndex(paneSeries, paneId);
  const panes = chart.panes();
  if (idx < 0 || idx >= panes.length) return null;
  const paneH = panes[idx].getHeight();
  const topPrice = series.coordinateToPrice(0);
  const bottomPrice = series.coordinateToPrice(paneH);
  if (topPrice == null || bottomPrice == null) return null;
  return { top: Number(topPrice), bottom: Number(bottomPrice) };
}

/**
 * Chart-global pixel (px, py) → domain Point (realMs, price) for the
 * pane identified by `paneId`. Subtracts the pane offset before calling
 * `series.coordinateToPrice` because that API expects pane-local Y.
 *
 * Returns null when the time or price axis cannot resolve.
 */
export function pixelToData(
  chart: IChartApi,
  axis: VirtualAxis,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  px: number,
  py: number,
  future?: FutureBand,
): Point | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const timeSec = chart.timeScale().coordinateToTime(px);
  let realMs: number | null;
  if (timeSec != null) {
    realMs = axis.toReal((timeSec as number) * 1000);
  } else {
    // Empty band right of the last candle: extrapolate the time so trendline /
    // rect / measure / text can be created there (price resolves below).
    realMs = future && future.bucketMs > 0 ? extrapolateFutureRealMs(chart, axis, px, future) : null;
  }
  if (realMs == null) return null;
  const yLocal = py - paneTopY(chart, paneSeries, paneId);
  const price = series.coordinateToPrice(yLocal);
  if (price == null) return null;
  return { realMs, price: Number(price) };
}

/**
 * Cursor pixel Y → PaneId of the pane the cursor is inside. Falls back to
 * the first pane when py < 0, the last pane when py is beyond the chart
 * bottom — resolved from the live mounted order (not static PANE_SPECS).
 */
export function paneIdAtY(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  py: number,
): PaneId {
  const byIndex = indexToPaneId(paneSeries);
  const fallback = byIndex.get(0) ?? 'candle';
  const panes = chart.panes();
  if (panes.length === 0 || py < 0) return fallback;
  let cursor = 0;
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (py >= cursor && py < cursor + h) {
      return byIndex.get(i) ?? fallback;
    }
    cursor += h;
  }
  return byIndex.get(panes.length - 1) ?? fallback;
}

/**
 * Clamp a pixel Y to the vertical span of `paneId`'s pane. Used by tools
 * during creation drag and by body-translate so a Drawing started in one
 * pane never escapes into another. A no-op (returns py) when the pane is
 * not mounted.
 */
export function clampYToPane(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  py: number,
): number {
  const idx = paneIdToIndex(paneSeries, paneId);
  if (idx < 0) return py;
  const panes = chart.panes();
  let top = 0;
  for (let i = 0; i < idx && i < panes.length; i++) top += panes[i].getHeight();
  const h = panes[idx]?.getHeight() ?? 0;
  const bottom = top + h;
  return Math.max(top, Math.min(bottom - 1, py));
}

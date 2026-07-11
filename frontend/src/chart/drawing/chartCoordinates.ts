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

import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PaneId, Point } from './types';

export type PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>;

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
): number | null {
  if (!axis.contains(realMs)) return null;
  const virtualMs = axis.toVirtual(realMs);
  const x = chart.timeScale().timeToCoordinate((virtualMs / 1000) as UTCTimestamp);
  return x == null ? null : (x as number);
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
): number | null {
  const timeSec = chart.timeScale().coordinateToTime(px);
  if (timeSec == null) return null;
  return axis.toReal((timeSec as number) * 1000);
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
): Point | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const timeSec = chart.timeScale().coordinateToTime(px);
  if (timeSec == null) return null;
  const virtualMs = (timeSec as number) * 1000;
  const realMs = axis.toReal(virtualMs);
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

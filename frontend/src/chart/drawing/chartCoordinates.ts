// frontend/src/chart/drawing/chartCoordinates.ts
//
// Chart Coordinates — pixel ↔ (realMs, price) conversions for the Drawing
// Overlay. Every Y-conversion is pane-aware: the caller supplies a paneId
// that identifies which pane's price scale to use. lightweight-charts v5
// returns pane-LOCAL Y from `series.priceToCoordinate` / `coordinateToPrice`
// (origin at the pane's top, not the chart's top), so `priceToCanvasY` adds
// `paneTopY(paneId)` and `canvasYToPrice` subtracts it before round-trip.
//
// PaneSeriesMap is owned by ChartStage; each RangeSeriesPane registers
// its first (primary) series on mount and clears it on unmount.

import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import { PANE_SPECS } from '../paneSpecs';
import type { PaneId, Point } from './types';

export type PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>;

/** PANE_SPECS lookup: PaneId → numeric paneIndex (lightweight-charts API).
 *  Built once at module load; PANE_SPECS is a module-level constant so a
 *  static cache is safe. */
const PANE_ID_TO_INDEX: ReadonlyMap<PaneId, number> = (() => {
  const m = new Map<PaneId, number>();
  PANE_SPECS.forEach((spec, idx) => m.set(spec.name, idx));
  return m;
})();

export function paneIdToIndex(paneId: PaneId): number {
  const idx = PANE_ID_TO_INDEX.get(paneId);
  if (idx == null) {
    // Should be unreachable — PaneId literals mirror PANE_SPECS exactly.
    // Returning 0 keeps rendering alive (the drawing visually lands on the
    // candle pane) instead of throwing during a redraw frame.
    return 0;
  }
  return idx;
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
 * Sum of pane heights above `paneId`. For the candle pane (index 0) this
 * is 0, so the helper is a no-op on the original single-pane path that
 * shipped before the indicator-pane feature.
 *
 * Why this exists: lightweight-charts v5's `series.priceToCoordinate` and
 * `coordinateToPrice` operate in **pane-local Y** (origin at the pane's
 * top, not the chart's top). Drawing renders into a chart-global canvas
 * — we must add the pane offset to land the pixel in the right place,
 * and subtract it before feeding a chart-global Y back to the series.
 */
export function paneTopY(chart: IChartApi, paneId: PaneId): number {
  const panes = chart.panes();
  const idx = paneIdToIndex(paneId);
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
  return Number(yLocal) + paneTopY(chart, paneId);
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
  const yLocal = py - paneTopY(chart, paneId);
  const price = series.coordinateToPrice(yLocal);
  if (price == null) return null;
  return { realMs, price: Number(price) };
}

/**
 * Cursor pixel Y → PaneId of the pane the cursor is inside. Falls back to
 * the last pane when py is beyond the chart bottom; falls back to the
 * first pane when py < 0 (matches lightweight-charts' top-down stacking).
 */
export function paneIdAtY(chart: IChartApi, py: number): PaneId {
  const panes = chart.panes();
  if (panes.length === 0 || py < 0) {
    return PANE_SPECS[0].name;
  }
  let cursor = 0;
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (py >= cursor && py < cursor + h) {
      return PANE_SPECS[i]?.name ?? PANE_SPECS[0].name;
    }
    cursor += h;
  }
  return PANE_SPECS[panes.length - 1]?.name ?? PANE_SPECS[0].name;
}

/**
 * Clamp a pixel Y to the vertical span of `paneId`'s pane. Used by tools
 * during creation drag and by body-translate so a Drawing started in one
 * pane never escapes into another.
 */
export function clampYToPane(chart: IChartApi, paneId: PaneId, py: number): number {
  const panes = chart.panes();
  const idx = paneIdToIndex(paneId);
  let top = 0;
  for (let i = 0; i < idx && i < panes.length; i++) top += panes[i].getHeight();
  const h = panes[idx]?.getHeight() ?? 0;
  const bottom = top + h;
  return Math.max(top, Math.min(bottom - 1, py));
}

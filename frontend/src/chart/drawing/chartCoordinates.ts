// frontend/src/chart/drawing/chartCoordinates.ts
//
// Chart Coordinates — pixel ↔ (realMs, price) conversions for the Drawing
// Overlay. Every Y-conversion is pane-aware: the caller supplies a paneId
// that identifies which pane's price scale to use. The Y returned by
// lightweight-charts already includes the pane's vertical offset, so the
// canvas Y can be used verbatim.
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
  PANE_SPECS.forEach((spec, idx) => m.set(spec.name as PaneId, idx));
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
 * Price → canvas Y for the pane identified by `paneId`. Returns null when
 * that pane's primary series isn't registered (e.g. pane removed from
 * PANE_SPECS) or the price falls outside the series' visible price range.
 */
export function priceToCanvasY(
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  price: number,
): number | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const y = series.priceToCoordinate(price);
  return y == null ? null : Number(y);
}

/**
 * Pixel (px, py) → domain Point (realMs, price) for the pane identified
 * by `paneId`. Returns null when the time or price axis cannot resolve.
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
  const price = series.coordinateToPrice(py);
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
    return (PANE_SPECS[0].name as PaneId);
  }
  let cursor = 0;
  for (let i = 0; i < panes.length; i++) {
    const h = panes[i].getHeight();
    if (py >= cursor && py < cursor + h) {
      return (PANE_SPECS[i]?.name as PaneId) ?? (PANE_SPECS[0].name as PaneId);
    }
    cursor += h;
  }
  return (PANE_SPECS[panes.length - 1]?.name as PaneId)
    ?? (PANE_SPECS[0].name as PaneId);
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

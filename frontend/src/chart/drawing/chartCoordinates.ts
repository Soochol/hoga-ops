// frontend/src/chart/drawing/chartCoordinates.ts
//
// Chart Coordinates — the single entry point for canvas-pixel ↔ domain
// (realMs, price) conversion the Drawing Overlay relies on.
//
// Two prior near-duplicates: `pixelToData` / `realMsToCanvasX` /
// `priceToCanvasY` inside DrawingOverlay (used by pointer handlers + hover
// hit-test) and `realMsToX` / `priceToY` / `projectPoint` inside `render.ts`
// (used per-vertex during the redraw loop). Same math, two implementations.
// Centralising here removes the drift risk and gives the conversion seam a
// name aligned with CONTEXT.md's **Virtual Axis** terminology.
//
// Pure functions — no React, no canvas state. Each takes the chart, axis,
// and (when needed) price series explicitly and returns `null` when the
// conversion isn't possible (off-axis time, missing price series, etc).
//
// Why functions (not a class): consumers already hold chart/axis/priceSeries
// references; bundling them into a constructed object would obscure the
// dependency or force the caller to recreate it on every render. The
// argument-passing cost is one shape and matches `render.ts`'s ProjectCtx.

import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { Point } from './types';

/** Any pane 0 series whose price scale we read from. */
export type PriceSeries =
  | ISeriesApi<'Candlestick'>
  | ISeriesApi<'Line'>
  | ISeriesApi<'Area'>
  | null;

/**
 * Real Unix-ms → canvas X.
 * Returns null when `realMs` falls outside every **Virtual Axis** segment
 * (per CONTEXT.md the gap-bridging sentinel would otherwise stack vertices
 * at the boundary). Drawing renderers treat `null` as "skip this vertex".
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
 * Price → canvas Y.
 * Returns null when the price series isn't mounted yet (e.g. ChartStage
 * hasn't finished discovering pane 0's candle series) or when the price
 * falls outside the series' visible price range.
 */
export function priceToCanvasY(priceSeries: PriceSeries, price: number): number | null {
  if (!priceSeries) return null;
  const y = priceSeries.priceToCoordinate(price);
  return y == null ? null : Number(y);
}

/**
 * Pixel (px, py) → domain Point (realMs, price).
 * Returns null when either axis can't resolve the coordinate. Used by
 * pointer event handlers to convert cursor pixel positions into the
 * realMs+price encoding drawings persist.
 */
export function pixelToData(
  chart: IChartApi,
  axis: VirtualAxis,
  priceSeries: PriceSeries,
  px: number,
  py: number,
): Point | null {
  if (!priceSeries) return null;
  const timeSec = chart.timeScale().coordinateToTime(px);
  if (timeSec == null) return null;
  const virtualMs = (timeSec as number) * 1000;
  const realMs = axis.toReal(virtualMs);
  const price = priceSeries.coordinateToPrice(py);
  if (price == null) return null;
  return { realMs, price: Number(price) };
}

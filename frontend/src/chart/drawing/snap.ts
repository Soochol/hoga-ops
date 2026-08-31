// frontend/src/chart/drawing/snap.ts
//
// Magnet snapping for the Drawing Overlay. When magnet mode is on (and Ctrl is
// not held to temporarily override), creation and handle drags snap to the
// nearest candle: the time (realMs) snaps to the candle's timestamp always, and
// on the candle pane the price snaps to the nearest of that candle's O/H/L/C
// when within a pixel threshold. Pure functions — the overlay injects a
// price→pixel converter so snapping can be reasoned about in pixel space
// without a live chart.

import type { PaneId, Point } from './types';

export type SnapCandle = {
  ts_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Snap threshold in canvas pixels for the price (Y) snap. Generous enough that
 *  the magnet visibly grabs candle OHLC levels without demanding pixel-perfect
 *  aim (10px felt like it wasn't working). */
export const SNAP_PX = 16;

/**
 * True when `realMs` lies inside the loaded candles' time span — the only
 * region where "the nearest candle" is a MEANINGFUL magnet target.
 *
 * Outside it, `nearestCandleIndex` degenerates: every X in the empty band right
 * of the last candle resolves to that SAME last candle, so an unconditional
 * time snap stops being a magnet and becomes a hard CLAMP. Measured on /live
 * (005930, 1m, magnet on, last candle at x=467): a text placed at x=600 was
 * stored on the last candle's timestamp, and a trendline dragged 80px
 * horizontally came out with both endpoints on one realMs — a vertical line.
 * Same root for the body drag: `curRealMs` never left the last candle, so
 * `dBar` collapsed to 0 and the drawing froze the moment it entered the band.
 *
 * The band is a supported place to draw (see FutureBand in chartCoordinates),
 * and the realMs it hands back is already on the extrapolated bar grid
 * (`lastRealMs + N × bucketMs`, N a whole number of columns) — so passing it
 * through unsnapped keeps the column alignment magnet exists to give, without
 * the clamp.
 *
 * Only the TIME snap is gated. The price snap keeps running off the nearest
 * candle's O/H/L/C because it already has a pixel threshold (`SNAP_PX`) to opt
 * into by aim, and hovering in the band to place an hline on the last close is
 * a real workflow.
 */
function withinCandleSpan(candles: readonly SnapCandle[], realMs: number): boolean {
  if (candles.length === 0) return false;
  return realMs >= candles[0].ts_ms && realMs <= candles[candles.length - 1].ts_ms;
}

/** Index of the candle whose ts_ms is nearest `realMs` (binary search on a
 *  time-sorted array). Returns -1 for an empty array. */
export function nearestCandleIndex(candles: readonly SnapCandle[], realMs: number): number {
  if (candles.length === 0) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].ts_ms < realMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first candle >= realMs; compare it with its predecessor.
  if (lo > 0 && Math.abs(candles[lo - 1].ts_ms - realMs) <= Math.abs(candles[lo].ts_ms - realMs)) {
    return lo - 1;
  }
  return lo;
}

/** Snap a realMs to the nearest candle's timestamp. No-op on empty candles, and
 *  outside the loaded span — where the "nearest" candle is an edge, not a
 *  target (see `withinCandleSpan`). */
export function snapRealMs(candles: readonly SnapCandle[], realMs: number): number {
  if (!withinCandleSpan(candles, realMs)) return realMs;
  const i = nearestCandleIndex(candles, realMs);
  return i < 0 ? realMs : candles[i].ts_ms;
}

/**
 * Snap a raw (realMs, price) Point produced by pixelToData. Time snaps to the
 * nearest candle whenever the raw time is INSIDE the loaded span (see
 * `withinCandleSpan` — in the empty band right of the last candle it passes
 * through, so a drawing can actually be placed and dragged out there); on the
 * candle pane the price snaps to the nearest O/H/L/C of that candle if a
 * candidate is within `pxThreshold` pixels of the raw price (measured via the
 * injected `priceToY`). Other panes snap X only.
 */
export function snapPoint(
  raw: Point,
  opts: {
    candles: readonly SnapCandle[];
    paneId: PaneId;
    priceToY: (price: number) => number | null;
    pxThreshold?: number;
  },
): Point {
  const { candles, paneId, priceToY } = opts;
  const pxThreshold = opts.pxThreshold ?? SNAP_PX;
  const i = nearestCandleIndex(candles, raw.realMs);
  if (i < 0) return raw;
  const candle = candles[i];
  const snappedMs = withinCandleSpan(candles, raw.realMs) ? candle.ts_ms : raw.realMs;
  if (paneId !== 'candle') return { realMs: snappedMs, price: raw.price };
  const rawY = priceToY(raw.price);
  if (rawY == null) return { realMs: snappedMs, price: raw.price };
  let bestPrice = raw.price;
  let bestDist = pxThreshold;
  for (const level of [candle.open, candle.high, candle.low, candle.close]) {
    const y = priceToY(level);
    if (y == null) continue;
    const d = Math.abs(y - rawY);
    if (d <= bestDist) {
      bestDist = d;
      bestPrice = level;
    }
  }
  return { realMs: snappedMs, price: bestPrice };
}

/**
 * Constrain endpoint `b` relative to anchor `a` to the nearest of horizontal,
 * vertical, or 45° diagonal — the Shift-drag behavior. Works in canvas pixel
 * space (so the visual angle is what snaps), returning the constrained pixel
 * point; the caller converts back to data.
 */
export function constrainAngle(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 1 && ady < 1) return b;
  const angle = Math.atan2(dy, dx);
  // Quantize to the nearest multiple of 45°.
  const step = Math.PI / 4;
  const q = Math.round(angle / step) * step;
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(q) * len, y: a.y + Math.sin(q) * len };
}

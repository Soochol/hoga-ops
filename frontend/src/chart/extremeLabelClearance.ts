import {
  LABEL_AVOID_GAP_PX, LABEL_EDGE_PAD_PX, LABEL_HEIGHT_PX,
  placeExtremeLabel, type AvoidRect, type ExtremeLabelPlace, type ExtremeLabelPlacement,
} from './highLowLabelLayout';

export type ClearExtremeLabel = ExtremeLabelPlacement & { width: number; text: string; compact: boolean };
export function extremeLabelRect(p: ExtremeLabelPlacement, width: number): AvoidRect {
  const top = p.place === 'above' ? p.y : p.y - LABEL_HEIGHT_PX;
  return { left: p.x - width / 2, right: p.x + width / 2, top, bottom: top + LABEL_HEIGHT_PX };
}
const finite = (r: AvoidRect) => Number.isFinite(r.left) && Number.isFinite(r.right)
  && Number.isFinite(r.top) && Number.isFinite(r.bottom);

/** Validate the previous chip directly before sorting forbidden intervals.
 * Use the same conservative candle envelope and open interval boundaries as
 * freeCenters: touching an interval endpoint is an allowed placement. */
function previousIsClear(
  previous: ClearExtremeLabel, width: number, paneWidth: number,
  candles: readonly AvoidRect[], obstacles: readonly AvoidRect[],
): boolean {
  const half = width / 2;
  if (previous.x < LABEL_EDGE_PAD_PX + half || previous.x > paneWidth - LABEL_EDGE_PAD_PX - half) return false;
  const box = extremeLabelRect(previous, width);
  const gap = LABEL_AVOID_GAP_PX;
  for (const c of candles) {
    if (!finite(c)) continue;
    const blocksRow = previous.place === 'above' ? c.top < box.bottom + gap : c.bottom > box.top - gap;
    if (blocksRow && previous.x > c.left - half - gap && previous.x < c.right + half + gap) return false;
  }
  for (const r of obstacles) {
    if (!finite(r)) continue;
    if (r.top < box.bottom + gap && r.bottom > box.top - gap
      && previous.x > r.left - half - gap && previous.x < r.right + half + gap) return false;
  }
  return true;
}

/** Native candle rectangles already arrive left-to-right. Normalize arbitrary
 * annotation/test input once, rather than sorting blocked intervals per row. */
function orderedRects(rects: readonly AvoidRect[]): readonly AvoidRect[] {
  let previous = -Infinity;
  for (const r of rects) {
    if (!finite(r) || r.left < previous) {
      return rects.filter(finite).sort((a, b) => a.left - b.left);
    }
    previous = r.left;
  }
  return rects;
}

/** Merge two ordered streams of forbidden x intervals without allocating and
 * sorting one array per candidate row. Conservative candle high/low envelopes
 * still protect bodies AND wicks. */
function freeCenters(
  place: ExtremeLabelPlace, y: number, width: number, paneWidth: number,
  candles: readonly AvoidRect[], obstacles: readonly AvoidRect[],
): [number, number][] {
  const half = width / 2;
  const min = LABEL_EDGE_PAD_PX + half;
  const max = paneWidth - LABEL_EDGE_PAD_PX - half;
  if (max < min) return [];
  const box = extremeLabelRect({ x: 0, y, place }, width);
  const gap = LABEL_AVOID_GAP_PX;
  const free: [number, number][] = [];
  let start = min;
  let ci = 0, oi = 0;
  while (ci < candles.length || oi < obstacles.length) {
    while (ci < candles.length && !(place === 'above'
      ? candles[ci].top < box.bottom + gap : candles[ci].bottom > box.top - gap)) ci++;
    while (oi < obstacles.length && !(obstacles[oi].top < box.bottom + gap
      && obstacles[oi].bottom > box.top - gap)) oi++;
    const candle = candles[ci], obstacle = obstacles[oi];
    if (!candle && !obstacle) break;
    const rect = !obstacle || (candle && candle.left <= obstacle.left) ? candles[ci++] : obstacles[oi++];
    const left = rect.left - half - gap, right = rect.right + half + gap;
    if (right < start) continue;
    if (left > max) break;
    if (left > start) free.push([start, Math.min(left, max)]);
    start = Math.max(start, right);
  }
  if (start <= max) free.push([start, max]);
  return free;
}

export function chooseClearExtremeLabel(input: {
  place: ExtremeLabelPlace; x: number; y: number;
  paneWidth: number; paneHeight: number;
  full: { text: string; width: number }; short: { text: string; width: number };
  candles: readonly AvoidRect[]; obstacles: readonly AvoidRect[];
  previous?: ClearExtremeLabel;
}): ClearExtremeLabel | null {
  const { place, x, y, paneWidth, paneHeight, candles, obstacles, previous } = input;
  if (![x, y, paneWidth, paneHeight].every(Number.isFinite) || paneHeight < LABEL_HEIGHT_PX + LABEL_EDGE_PAD_PX * 2) return null;
  const edge = place === 'above' ? LABEL_EDGE_PAD_PX : paneHeight - LABEL_EDGE_PAD_PX;
  const maxShift = Math.min(64, paneHeight * 0.3, paneHeight - LABEL_HEIGHT_PX - LABEL_EDGE_PAD_PX * 2);
  const validY = (v: number) => place === 'above' ? v >= edge && v <= edge + maxShift : v <= edge && v >= edge - maxShift;
  let sortedCandles: readonly AvoidRect[] | undefined;
  let sortedObstacles: readonly AvoidRect[] | undefined;
  for (const [compact, variant] of [[false, input.full], [true, input.short]] as const) {
    if (previous?.place === place && previous.compact === compact && validY(previous.y)
      && Math.abs(previous.x - x) <= paneWidth / 2
      && previousIsClear(previous, variant.width, paneWidth, candles, obstacles)) {
      return { ...previous, ...variant };
    }
    sortedCandles ??= orderedRects(candles);
    sortedObstacles ??= orderedRects(obstacles);
    const seed = placeExtremeLabel(place, x, y, variant.width, paneWidth, paneHeight, obstacles);
    const rows = [...new Set([
      previous?.y ?? edge, seed.y, edge,
      ...obstacles.filter(finite).map(r => place === 'above' ? r.bottom + LABEL_AVOID_GAP_PX : r.top - LABEL_AVOID_GAP_PX)
        .sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge)),
    ])].filter(validY).slice(0, 12);
    let best: ClearExtremeLabel | null = null;
    let bestCost = Infinity;
    for (const row of rows) {
      const free = freeCenters(place, row, variant.width, paneWidth, sortedCandles, sortedObstacles);
      for (const [left, right] of free) {
        // Hysteresis: retain a still-safe previous placement; value changes don't
        // move a chip merely because another location becomes slightly closer.
        if (previous?.compact === compact && previous.y === row && previous.x >= left && previous.x <= right
          && Math.abs(previous.x - x) <= paneWidth / 2) {
          return { ...previous, ...variant };
        }
        const center = Math.min(right, Math.max(left, x));
        if (Math.abs(center - x) > paneWidth / 2) continue;
        const cost = Math.abs(center - x) + 2 * Math.abs(row - edge);
        if (cost < bestCost) {
          bestCost = cost;
          best = { x: center, y: row, place, ...variant, compact };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

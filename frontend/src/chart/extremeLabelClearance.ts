import {
  LABEL_AVOID_GAP_PX, LABEL_EDGE_PAD_PX, LABEL_HEIGHT_PX,
  placeExtremeLabel, type AvoidRect, type ExtremeLabelPlace, type ExtremeLabelPlacement,
} from './highLowLabelLayout';

export type ClearExtremeLabel = ExtremeLabelPlacement & { width: number; text: string; compact: boolean };
export function extremeLabelRect(p: ExtremeLabelPlacement, width: number): AvoidRect {
  const top = p.place === 'above' ? p.y : p.y - LABEL_HEIGHT_PX;
  return { left: p.x - width / 2, right: p.x + width / 2, top, bottom: top + LABEL_HEIGHT_PX };
}
const finite = (r: AvoidRect) => Object.values(r).every(Number.isFinite);

/** Return safe centers by subtracting merged forbidden x intervals. Each row
 * costs O((visible candles + annotations) log n), independent of zoom/pane width.
 * Candle high/low envelopes are conservative: bodies AND wicks stay untouched.
 */
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
  const blocked = [
    ...candles.filter(c => place === 'above' ? c.top < box.bottom + gap : c.bottom > box.top - gap),
    ...obstacles.filter(r => r.top < box.bottom + gap && r.bottom > box.top - gap),
  ].filter(finite).map(r => [r.left - half - gap, r.right + half + gap])
    .sort((a, b) => a[0] - b[0]);
  const free: [number, number][] = [];
  let start = min;
  for (const [left, right] of blocked) {
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
  for (const [compact, variant] of [[false, input.full], [true, input.short]] as const) {
    const seed = placeExtremeLabel(place, x, y, variant.width, paneWidth, paneHeight, obstacles);
    const rows = [...new Set([
      previous?.y ?? edge, seed.y, edge,
      ...obstacles.filter(finite).map(r => place === 'above' ? r.bottom + LABEL_AVOID_GAP_PX : r.top - LABEL_AVOID_GAP_PX)
        .sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge)),
    ])].filter(validY).slice(0, 12);
    let best: ClearExtremeLabel | null = null;
    let bestCost = Infinity;
    for (const row of rows) {
      const free = freeCenters(place, row, variant.width, paneWidth, candles, obstacles);
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

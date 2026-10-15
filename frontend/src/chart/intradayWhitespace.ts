import type { Time, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { candlePosition } from './candlePosition';
import { BASELINE_HIDDEN_COLORS, LINE_HIDDEN_COLOR } from './util/auctionHide';

type Point = { time: Time };
const grids = new WeakMap<VirtualAxis, Map<number, WhitespaceData<Time>[]>>();

/** Render-only buckets: no OHLC, volume, indicator input, or disk mutation. */
export function withIntradayWhitespace<T extends Point>(
  data: T[], bundle: RangeBundle, axis: VirtualAxis,
): (T | WhitespaceData<Time>)[] {
  if (!bundle.timeline_sessions || axis.mode !== 'intraday') return data;
  let byBucket = grids.get(axis);
  if (!byBucket) { byBucket = new Map(); grids.set(axis, byBucket); }
  let grid = byBucket.get(bundle.bucket_ms);
  if (!grid) {
    grid = [];
    for (const segment of axis.segments) {
      // Epoch alignment matches the candle aggregation grid. A truncated final
      // bucket (including the closing-auction bar) still has its own slot.
      const first = Math.ceil(segment.sessionOpenMs / bundle.bucket_ms) * bundle.bucket_ms;
      for (let t = first; t <= segment.sessionCloseMs; t += bundle.bucket_ms) {
        grid.push({ time: (axis.toVirtual(t) / 1000) as UTCTimestamp });
      }
    }
    byBucket.set(bundle.bucket_ms, grid);
  }
  const result: (T | WhitespaceData<Time>)[] = [];
  let i = 0, j = 0;
  while (i < data.length || j < grid.length) {
    if (j === grid.length || (i < data.length && Number(data[i].time) <= Number(grid[j].time))) {
      const point = data[i++];
      if (j < grid.length && point.time === grid[j].time) j++;
      result.push(point);
    } else result.push(grid[j++]);
  }
  return result;
}

type Coverage = { starts: number[]; ends: number[] };
const coverageCache = new WeakMap<VirtualAxis, WeakMap<RangeBundle['candles'], Map<number, Coverage>>>();
function candleCoverage(bundle: RangeBundle, axis: VirtualAxis): Coverage {
  let byCandles = coverageCache.get(axis);
  if (!byCandles) { byCandles = new WeakMap(); coverageCache.set(axis, byCandles); }
  let byBucket = byCandles.get(bundle.candles);
  if (!byBucket) { byBucket = new Map(); byCandles.set(bundle.candles, byBucket); }
  const cached = byBucket.get(bundle.bucket_ms);
  if (cached) return cached;
  const coverage: Coverage = { starts: [], ends: [] };
  for (const candle of bundle.candles) {
    const at = candlePosition(candle, axis);
    if (!at.contained) continue;
    const segment = axis.segments[axis.findByReal(candle.ts_ms)];
    const start = at.virtual / 1000;
    const end = Math.min(at.virtual + bundle.bucket_ms, axis.toVirtual(segment.sessionCloseMs) + 1) / 1000;
    const last = coverage.ends.length - 1;
    if (last >= 0 && start <= coverage.ends[last]) coverage.ends[last] = end;
    else { coverage.starts.push(start); coverage.ends.push(end); }
  }
  byBucket.set(bundle.bucket_ms, coverage);
  return coverage;
}

function intervalAt(time: number, coverage: Coverage): number {
  let lo = 0, hi = coverage.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (coverage.starts[mid] <= time) lo = mid + 1; else hi = mid;
  }
  const i = lo - 1;
  return i >= 0 && time < coverage.ends[i] ? i : -1;
}

/** LWC connects lines over whitespace. Hide the actual outgoing connector as
 * well as values inside uncaptured buckets, while keeping the math unchanged. */
export function maskIntradayLineGaps<T extends Point>(data: T[], bundle: RangeBundle, axis: VirtualAxis): T[] {
  if (!bundle.timeline_sessions || axis.mode !== 'intraday') return data;
  const coverage = candleCoverage(bundle, axis);
  const out: T[] = [];
  let previousInterval = -1;
  let previousValueIndex = -1;
  for (const point of data) {
    if (!('value' in point)) { out.push(point); continue; }
    const interval = intervalAt(Number(point.time), coverage);
    if (interval < 0) continue;
    if (previousValueIndex >= 0 && interval !== previousInterval) {
      out[previousValueIndex] = { ...out[previousValueIndex], ...LINE_HIDDEN_COLOR, ...BASELINE_HIDDEN_COLORS };
    }
    out.push(point);
    previousInterval = interval;
    previousValueIndex = out.length - 1;
  }
  return out;
}

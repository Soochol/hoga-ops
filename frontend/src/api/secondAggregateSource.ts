import type { SecondAggregates, SecondBar, SecondPrice } from './secondAggregates';

/** Replace whole one-second buckets, including price cells removed by a correction. */
export function applySecondDelta(previous: SecondAggregates | undefined, next: SecondAggregates): SecondAggregates {
  if (!previous || next.reset !== false || !next.revision) return next;
  const changed = new Set(next.changed_ms ?? []);
  if (!changed.size) return { ...next, bars: previous.bars, prices: previous.prices };
  const bars = replaceBuckets(previous.bars, next.bars, changed);
  const prices = replaceBuckets(previous.prices, next.prices, changed);
  sourceChanges.set(bars, { base: projections.get(previous.bars), times: [...changed] });
  priceChanges.set(prices, { previous: new WeakRef(previous.prices), times: [...changed] });
  return { ...next, bars, prices };
}

function replaceBuckets<T extends { t_ms: number }>(previous: readonly T[], updates: readonly T[], changed: ReadonlySet<number>): T[] {
  const result: T[] = [];
  let index = 0;
  for (const item of previous) {
    while (index < updates.length && updates[index].t_ms < item.t_ms) result.push(updates[index++]);
    if (!changed.has(item.t_ms)) result.push(item);
  }
  while (index < updates.length) result.push(updates[index++]);
  return result;
}

const projections = new WeakMap<SecondBar[], Map<string, SecondBar[]>>();
// Hold projected arrays only, not previous source objects: old revisions can be GC'd.
const priceSelections = new WeakMap<SecondPrice[], Map<number, SecondPrice[]>>();
function selectPrices(source: SecondPrice[], fromMs: number | null, enabled: boolean): SecondPrice[] {
  if (!enabled) return EMPTY_PRICES;
  if (fromMs === null) return source;
  let cache = priceSelections.get(source);
  if (!cache) { cache = new Map(); priceSelections.set(source, cache); }
  let selected = cache.get(fromMs);
  if (!selected) { selected = source.slice(lowerBound(source, fromMs)); cache.set(fromMs, selected); }
  return selected;
}
const EMPTY_PRICES: SecondPrice[] = [];
const sourceChanges = new WeakMap<SecondBar[], { base: Map<string, SecondBar[]> | undefined; times: number[] }>();
const priceChanges = new WeakMap<SecondPrice[], { previous: WeakRef<SecondPrice[]>; times: number[] }>();

/** Weak lineage allows window-owned indexes to apply a delta without retaining
 * a chain of previous day-sized source arrays. Reset/filtered sources rebuild.
 */
export function secondPriceChanges(prices: readonly SecondPrice[]) {
  return priceChanges.get(prices as SecondPrice[]);
}

function lowerBound(bars: readonly { t_ms: number }[], time: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].t_ms < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function aggregateRange(source: readonly SecondBar[], from: number, to: number, bucketMs: number): SecondBar[] {
  const bars: SecondBar[] = [];
  for (let i = from; i < to; i++) {
    const bar = source[i];
    const t_ms = Math.floor(bar.t_ms / bucketMs) * bucketMs;
    const last = bars.at(-1);
    if (last?.t_ms === t_ms) {
      last.high = Math.max(last.high, bar.high); last.low = Math.min(last.low, bar.low);
      last.close = bar.close; last.volume += bar.volume; last.count += bar.count; last.trade_value += bar.trade_value;
    } else bars.push({ ...bar, t_ms });
  }
  return bars;
}

export function projectSecondSource(source: SecondAggregates, seconds: SecondAggregates['seconds'], fromMs: number | null, prices: boolean): SecondAggregates {
  let cache = projections.get(source.bars);
  if (!cache) { cache = new Map(); projections.set(source.bars, cache); }
  const key = `${seconds}|${fromMs}`;
  let bars = cache.get(key);
  if (!bars) {
    const change = sourceChanges.get(source.bars);
    const previous = change?.base?.get(key);
    const bucketMs = seconds * 1000;
    if (previous && change) {
      const buckets = new Set(change.times.filter(t => fromMs === null || t >= fromMs).map(t => Math.floor(t / bucketMs) * bucketMs));
      const updates: SecondBar[] = [];
      for (const t of [...buckets].sort((a, b) => a - b)) {
        const from = lowerBound(source.bars, Math.max(t, fromMs ?? 0));
        const to = lowerBound(source.bars, t + bucketMs);
        updates.push(...aggregateRange(source.bars, from, to, bucketMs));
      }
      bars = buckets.size ? replaceBuckets(previous, updates, buckets) : previous;
    } else {
      bars = aggregateRange(source.bars, fromMs === null ? 0 : lowerBound(source.bars, fromMs), source.bars.length, bucketMs);
    }
    cache.set(key, bars);
  }
  return { ...source, seconds, bars, prices: selectPrices(source.prices, fromMs, prices) };
}

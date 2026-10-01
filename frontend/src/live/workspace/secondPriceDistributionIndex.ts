import type { SecondPrice } from '../../api/secondAggregates';
import { secondPriceChanges } from '../../api/secondAggregateSource';
import type { DayVolumeDistribution } from '../../api/types';
import { regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';
import { isKrxAftermarketWindow } from '../../util/stockSessions';

function before(times: readonly number[], cutoff: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type PriceLevel = { times: number[]; quantities: number[]; prefixes: number[] };
type Bucket = { quantities: Map<number, number>; min: number; max: number };

/** Window-owned mutable index. Tail ticks repair only tail prefixes; historical
 * corrections repair the affected price levels and the extrema suffix. Cursor
 * queries never inspect source executions. Memory remains linear in cells.
 */
class SecondPriceDistributionIndex {
  private readonly date: string;
  private readonly rangeCount: number;
  private readonly open: number;
  private readonly close: number;
  private readonly buckets = new Map<number, Bucket>();
  private readonly byPrice = new Map<number, PriceLevel>();
  private readonly times: number[] = [];
  private readonly mins: number[] = [];
  private readonly maxs: number[] = [];

  constructor(date: string, rangeCount: number, prices: readonly SecondPrice[]) {
    this.date = date; this.rangeCount = rangeCount;
    this.open = regularSessionOpenMs(date);
    this.close = regularSessionCloseMs(date);
    const ordered = [...prices].sort((a, b) => a.t_ms - b.t_ms);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < ordered.length;) {
      const t = ordered[i].t_ms;
      const quantities = new Map<number, number>();
      const valid = t >= this.open && t <= this.close || isKrxAftermarketWindow(t);
      while (i < ordered.length && ordered[i].t_ms === t) {
        const cell = ordered[i++];
        if (valid && cell.side !== 0) {
          const price = cell.price;
          quantities.set(price, (quantities.get(price) ?? 0) + cell.qty);
        }
      }
      if (!quantities.size) continue;
      let bucketMin = Infinity, bucketMax = -Infinity;
      for (const [price, qty] of quantities) {
        bucketMin = Math.min(bucketMin, price); bucketMax = Math.max(bucketMax, price);
        let level = this.byPrice.get(price);
        if (!level) { level = { times: [], quantities: [], prefixes: [] }; this.byPrice.set(price, level); }
        level.times.push(t); level.quantities.push(qty); level.prefixes.push((level.prefixes.at(-1) ?? 0) + qty);
      }
      this.buckets.set(t, { quantities, min: bucketMin, max: bucketMax });
      this.times.push(t); this.mins.push(min = Math.min(min, bucketMin)); this.maxs.push(max = Math.max(max, bucketMax));
    }
  }

  replace(prices: readonly SecondPrice[], changed: readonly number[]) {
    let firstChanged = this.times.length;
    const levelChanges = new Map<number, number>();
    for (const t of [...new Set(changed)].sort((a, b) => a - b)) {
      const old = this.buckets.get(t);
      const quantities = new Map<number, number>();
      const validTime = t >= this.open && t <= this.close || isKrxAftermarketWindow(t);
      if (validTime) {
        for (let i = beforePrices(prices, t); i < prices.length && prices[i].t_ms === t; i++) {
          const cell = prices[i];
          if (cell.side !== 0) quantities.set(cell.price, (quantities.get(cell.price) ?? 0) + cell.qty);
        }
      }
      const pos = before(this.times, t);
      const existed = this.times[pos] === t;
      if (quantities.size) {
        let min = Infinity, max = -Infinity;
        for (const price of quantities.keys()) { min = Math.min(min, price); max = Math.max(max, price); }
        this.buckets.set(t, { quantities, min, max });
        if (!existed) {
          this.times.splice(pos, 0, t); this.mins.splice(pos, 0, 0); this.maxs.splice(pos, 0, 0);
        }
      } else {
        this.buckets.delete(t);
        if (existed) {
          this.times.splice(pos, 1); this.mins.splice(pos, 1); this.maxs.splice(pos, 1);
        }
      }
      firstChanged = Math.min(firstChanged, pos);
      for (const price of new Set([...(old?.quantities.keys() ?? []), ...quantities.keys()])) {
        let level = this.byPrice.get(price);
        if (!level) { level = { times: [], quantities: [], prefixes: [] }; this.byPrice.set(price, level); }
        const i = before(level.times, t);
        const qty = quantities.get(price);
        if (qty !== undefined) {
          if (level.times[i] === t) level.quantities[i] = qty;
          else { level.times.splice(i, 0, t); level.quantities.splice(i, 0, qty); level.prefixes.splice(i, 0, 0); }
        } else if (level.times[i] === t) {
          level.times.splice(i, 1); level.quantities.splice(i, 1); level.prefixes.splice(i, 1);
        }
        levelChanges.set(price, Math.min(levelChanges.get(price) ?? i, i));
      }
    }
    let min = this.mins[firstChanged - 1] ?? Infinity, max = this.maxs[firstChanged - 1] ?? -Infinity;
    for (let i = firstChanged; i < this.times.length; i++) {
      const bucket = this.buckets.get(this.times[i])!;
      this.mins[i] = min = Math.min(min, bucket.min);
      this.maxs[i] = max = Math.max(max, bucket.max);
    }
    for (const [price, from] of levelChanges) {
      const level = this.byPrice.get(price)!;
      if (!level.times.length) { this.byPrice.delete(price); continue; }
      let qty = level.prefixes[from - 1] ?? 0;
      for (let i = from; i < level.times.length; i++) level.prefixes[i] = qty += level.quantities[i];
    }
  }

  profileAt(cutoffExclusive: number | null = null): DayVolumeDistribution | null {
    const end = cutoffExclusive === null ? this.times.length : before(this.times, cutoffExclusive);
    if (!end) return null;
    const min = this.mins[end - 1], max = this.maxs[end - 1], last = this.times[end - 1];
    const width = (max - min) / this.rangeCount || 1;
    const bins = Array.from({ length: this.rangeCount }, (_, i) => ({
      price_low: min + i * width, price_high: i === this.rangeCount - 1 ? max : min + (i + 1) * width, qty: 0,
    }));
    for (const [price, level] of this.byPrice) {
      if (price < min || price > max) continue;
      const end = cutoffExclusive === null ? level.times.length : before(level.times, cutoffExclusive);
      if (end) bins[Math.min(this.rangeCount - 1, Math.floor((price - min) / width))].qty += level.prefixes[end - 1];
    }
    return { date: this.date, range_count: this.rangeCount, price_min: min, price_max: max,
      session_open_ms: this.open, session_close_ms: Math.max(this.close, last + 1000), last_trade_ms: last, bins };
  }
}

function beforePrices(prices: readonly SecondPrice[], t: number): number {
  let lo = 0, hi = prices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid].t_ms < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildSecondPriceDistributionIndex(prices: readonly SecondPrice[], date: string, rangeCount: number) {
  return new SecondPriceDistributionIndex(date, rangeCount, prices);
}

/** Each mounted window owns its cache. Skipped revisions, source resets and
 * date/bin changes rebuild rather than incorrectly applying a partial delta.
 */
export function createSecondPriceDistributionCache() {
  let source: readonly SecondPrice[] | undefined;
  let current: SecondPriceDistributionIndex | undefined;
  let currentDate: string | undefined, currentCount: number | undefined;
  return {
    update(prices: readonly SecondPrice[], date: string, rangeCount: number) {
      if (source === prices && currentDate === date && currentCount === rangeCount && current) return current;
      const change = secondPriceChanges(prices);
      if (current && currentDate === date && currentCount === rangeCount && change && change.previous.deref() === source) {
        current.replace(prices, change.times);
      } else current = buildSecondPriceDistributionIndex(prices, date, rangeCount);
      source = prices; currentDate = date; currentCount = rangeCount;
      return current;
    },
  };
}

import { isRegularSessionMs } from './aggregateCandles';
import type { FillStrengthPoint, QuoteRatioPoint, RangeBundle } from '../api/types';
import { indicatorBucketStartMs } from '../util/stockSessions';
import { quoteImbalance } from '../util/imbalance';
import type { TradeSnapshot } from './bucketHogaSeries';

/** Allocate only after the first excluded item; unchanged input stays identical. */
function filterUnchanged<T>(items: readonly T[], keep: (item: T) => boolean): readonly T[] {
  let result: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    if (keep(items[i])) result?.push(items[i]);
    else result ??= items.slice(0, i);
  }
  return result ?? items;
}

/** Live book/program snapshots need only their own timestamp checked.
 * Never traverse the price ladders or unrelated payload fields. */
export function filterRegularSessionSnapshots<T extends object>(items: readonly T[]): readonly T[] {
  return filterUnchanged(items, item => {
    const point = item as Record<string, unknown>;
    const time = point.t_ms ?? point.ts_ms ?? point.t;
    return typeof time !== 'number' || isRegularSessionMs(time);
  });
}

/** Shared live buffers publish immutable snapshots. Preserve their identity for
 * incremental hoga/wall builders, including mixed snapshots across append and
 * eviction. A window-owned WeakMap releases entries when raw snapshots expire. */
export function createRegularSessionTradeFilter() {
  const snapshots = new WeakMap<TradeSnapshot, TradeSnapshot | null>();
  return (items: readonly TradeSnapshot[]): readonly TradeSnapshot[] => {
    const result: TradeSnapshot[] = [];
    let changed = false;
    for (const snapshot of items) {
      let filtered = snapshots.get(snapshot);
      if (filtered === undefined) {
        const trades = filterUnchanged(snapshot.trades, ev => isRegularSessionMs(ev.t_ms ?? snapshot.t_ms));
        filtered = trades.length === 0 ? null : trades === snapshot.trades ? snapshot : { ...snapshot, trades: [...trades] };
        snapshots.set(snapshot, filtered);
      }
      if (filtered) result.push(filtered);
      changed ||= filtered !== snapshot;
    }
    return changed ? result : items;
  };
}

/** Restrict timestamped series while preserving identities of unchanged slices.
 * RangeBundle point times (t, t_ms, ts_ms) all use Unix milliseconds. */
export function filterRegularSession<T>(value: T): T {
  return createRegularSessionFilter()(value);
}

/** Window-owned cache for immutable bundles. Live updates replace only the
 * changed tail; do not traverse retained candles and price ladders again.
 * Weak keys let evicted history disappear without a separate cache budget. */
export function createRegularSessionFilter() {
  const results = new WeakMap<object, object>();
  const eligible = new WeakMap<object, boolean>();
  function keep(node: unknown): boolean {
    if (!node || typeof node !== 'object') return true;
    const cached = eligible.get(node);
    if (cached !== undefined) return cached;
    const point = node as Record<string, unknown>;
    const time = point.t_ms ?? point.ts_ms ?? point.t;
    const result = typeof time !== 'number' || isRegularSessionMs(time);
    eligible.set(node, result);
    return result;
  }
  function visit(node: unknown): unknown {
    if (!node || typeof node !== 'object') return node;
    const cached = results.get(node);
    if (cached !== undefined) return cached;
    if (Array.isArray(node)) {
      let filtered: unknown[] | undefined;
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (!keep(item)) { filtered ??= node.slice(0, i); continue; }
        const value = visit(item);
        if (value !== item) filtered ??= node.slice(0, i);
        filtered?.push(value);
      }
      const result = filtered ?? node;
      results.set(node, result);
      return result;
    }
    const source = node as Record<string, unknown>;
    let mapped: Record<string, unknown> | undefined;
    for (const key of Object.keys(source)) {
      const item = source[key];
      const value = visit(item);
      if (value !== item) { mapped ??= { ...source }; mapped[key] = value; }
    }
    const result = mapped ?? node;
    results.set(node, result);
    return result;
  }
  return <T>(value: T): T => visit(value) as T;
}

/** Regular-session requests use 1m source data to clip before aggregation.
 * Every plotted hoga point must then use the candle grid: lightweight-charts
 * shares the union of all series times, so leaving 1m points on a 3m chart
 * inserts two extra axis slots between candles even at unchanged barSpacing.
 * Totals use the last eligible book, maxima preserve their intra-bar meaning,
 * and fill quantities are summed, matching bucketHogaSeries. */
export function regularSessionHogaForDisplay(
  source: RangeBundle | null,
  bucketMs: number,
  venue: string,
): RangeBundle | null {
  if (!source) return null;
  const filtered = filterRegularSession(source);
  const aggregateQuote = filtered.quote_ratio.bucket_ms < bucketMs;
  const aggregateFill = filtered.fill_strength.bucket_ms < bucketMs;
  if (!aggregateQuote && !aggregateFill) return filtered;

  const quotes = new Map<number, QuoteRatioPoint>();
  if (aggregateQuote) for (const p of filtered.quote_ratio.points) {
    const t = indicatorBucketStartMs(p.t, bucketMs, venue);
    const prev = quotes.get(t);
    if (!prev) {
      quotes.set(t, { ...p, t });
      continue;
    }
    // A trailing auction sentinel must not overwrite a continuous book.
    const representative = p.bid_total > 0 || p.ask_total > 0 ? p : prev;
    const strongest = Math.abs(quoteImbalance(p.imb_max_bid, p.imb_max_ask))
      > Math.abs(quoteImbalance(prev.imb_max_bid, prev.imb_max_ask)) ? p : prev;
    quotes.set(t, {
      ...representative, t,
      bid_max: Math.max(prev.bid_max, p.bid_max),
      ask_max: Math.max(prev.ask_max, p.ask_max),
      imb_max_bid: strongest.imb_max_bid,
      imb_max_ask: strongest.imb_max_ask,
    });
  }
  const fills = new Map<number, FillStrengthPoint>();
  if (aggregateFill) for (const p of filtered.fill_strength.points) {
    const t = indicatorBucketStartMs(p.t, bucketMs, venue);
    const prev = fills.get(t);
    fills.set(t, { t, buy_qty: (prev?.buy_qty ?? 0) + p.buy_qty, sell_qty: (prev?.sell_qty ?? 0) + p.sell_qty });
  }
  return {
    ...filtered,
    bucket_ms: bucketMs,
    quote_ratio: aggregateQuote ? { bucket_ms: bucketMs, points: [...quotes.values()] } : filtered.quote_ratio,
    fill_strength: aggregateFill ? { bucket_ms: bucketMs, points: [...fills.values()] } : filtered.fill_strength,
  };
}

import { isRegularSessionMs } from './aggregateCandles';
import type { FillStrengthPoint, QuoteRatioPoint, RangeBundle } from '../api/types';
import { indicatorBucketStartMs } from '../util/stockSessions';
import { quoteImbalance } from '../util/imbalance';

/** Restrict timestamped series while preserving identities of unchanged slices.
 * RangeBundle point times (t, t_ms, ts_ms) all use Unix milliseconds. */
export function filterRegularSession<T>(value: T): T {
  function visit(node: unknown): unknown {
    if (Array.isArray(node)) {
      const filtered = node.filter(item => {
        if (!item || typeof item !== 'object') return true;
        const point = item as Record<string, unknown>;
        const time = point.t_ms ?? point.ts_ms ?? point.t;
        return typeof time !== 'number' || isRegularSessionMs(time);
      }).map(visit);
      return filtered.length === node.length && filtered.every((item, i) => item === node[i]) ? node : filtered;
    }
    if (!node || typeof node !== 'object') return node;
    const entries = Object.entries(node);
    const mapped = entries.map(([key, item]) => [key, visit(item)] as const);
    return mapped.every((entry, i) => entry[1] === entries[i][1]) ? node : Object.fromEntries(mapped);
  }
  return visit(value) as T;
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

import type { QuoteRatioPoint, FillStrengthPoint, OrderbookLevel } from '../api/types';

/** One live OB snapshot as it crosses the SSE seam (SR-1). The chart reads
 * t_ms + total_*_qty; LiveSidebar reads asks/bids too (optional because the
 * minute-chart path only needs the totals). `kind` rides along from the
 * buffer entry. The index signature keeps it assignable from the structurally
 * untyped buffer (`Record<string, unknown>`) without an `as unknown as`. */
export interface ObSnapshot {
  t_ms: number;
  total_ask_qty: number;
  total_bid_qty: number;
  asks?: OrderbookLevel[];
  bids?: OrderbookLevel[];
  kind?: string;
  [field: string]: unknown;
}

export interface TradeEvent {
  side: number; // KIS enum: -1 sell, 0 mid, 1 buy, 2 auction
  qty: number;
}

export interface TradeSnapshot {
  t_ms: number;
  trades: TradeEvent[];
  kind?: string;
  [field: string]: unknown;
}

/** Bucket label = floor(t_ms / bucketMs) * bucketMs (bucket start). Matches
 * `aggregateCandles.ts` convention so candle/volume/호가 align on the x-axis.
 *
 * Quote Totals: state — last snapshot in bucket wins (analogous to candle close).
 * FillStrength: flow — sum qty in bucket. Only side=1 (buy) and side=-1 (sell)
 * contribute. side=0 (mid, classifier fallback) and side=2 (auction) are
 * intentionally excluded — same semantics as ADR-0029's auction-window hide
 * and the replay viewer's existing FillStrength projector. */
export function bucketHogaSeries(
  ob: readonly ObSnapshot[],
  trade: readonly TradeSnapshot[],
  bucketMs: number,
): { quoteRatioPoints: QuoteRatioPoint[]; fillStrengthPoints: FillStrengthPoint[] } {
  if (bucketMs <= 0) throw new Error(`bucketMs must be positive, got ${bucketMs}`);

  // Quote Totals — last-in-bucket.
  const obSorted = [...ob].sort((a, b) => a.t_ms - b.t_ms);
  const quoteByBucket = new Map<number, QuoteRatioPoint>();
  for (const s of obSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    quoteByBucket.set(t, { t, ask_total: s.total_ask_qty, bid_total: s.total_bid_qty });
  }
  const quoteRatioPoints = Array.from(quoteByBucket.values()).sort((a, b) => a.t - b.t);

  // FillStrength — sum-in-bucket.
  const tradeSorted = [...trade].sort((a, b) => a.t_ms - b.t_ms);
  const fillByBucket = new Map<number, FillStrengthPoint>();
  for (const s of tradeSorted) {
    const t = Math.floor(s.t_ms / bucketMs) * bucketMs;
    let bucket = fillByBucket.get(t);
    if (!bucket) {
      bucket = { t, buy_qty: 0, sell_qty: 0 };
      fillByBucket.set(t, bucket);
    }
    for (const ev of s.trades) {
      if (ev.side === 1) bucket.buy_qty += ev.qty;
      else if (ev.side === -1) bucket.sell_qty += ev.qty;
    }
  }
  const fillStrengthPoints = Array.from(fillByBucket.values()).sort((a, b) => a.t - b.t);

  return { quoteRatioPoints, fillStrengthPoints };
}

import type {
  BrokerSeriesEntry,
  BrokerSeriesPoint,
  OrderbookLevel,
  OrderbookSnapshot,
  Trade,
} from '../api/types';

type RawSnapshot = Record<string, unknown>;

const EMPTY_LEVEL: OrderbookLevel = { price: 0, qty: 0 };

function padLevels(levels: unknown): OrderbookLevel[] {
  const arr = Array.isArray(levels) ? levels : [];
  const out: OrderbookLevel[] = [];
  for (let i = 0; i < 10; i++) {
    const entry = arr[i] as { price?: number; qty?: number } | undefined;
    if (entry && typeof entry.price === 'number' && typeof entry.qty === 'number') {
      out.push({ price: entry.price, qty: entry.qty });
    } else {
      out.push(EMPTY_LEVEL);
    }
  }
  return out;
}

/**
 * Project the latest `ob` snapshot from the live buffer into the
 * OrderbookSnapshot shape that OrderbookTable / TotalQtyBar consume.
 *
 * Returns null if the buffer is empty. Callers should treat that as
 * "data not yet arrived" and render the empty state. Missing or short
 * `asks`/`bids` arrays are zero-padded to length 10 so the table layout
 * stays stable.
 */
export function latestOrderbookSnapshot(ob: RawSnapshot[]): OrderbookSnapshot | null {
  if (ob.length === 0) return null;
  const latest = ob[ob.length - 1];
  return {
    ts_ms: (latest.t_ms as number) ?? 0,
    seq: 0, // live snapshots don't carry seq — sidebar reads ts_ms anyway
    ask: padLevels(latest.asks),
    bid: padLevels(latest.bids),
    tot_ask: (latest.total_ask_qty as number) ?? 0,
    tot_bid: (latest.total_bid_qty as number) ?? 0,
  };
}

/**
 * Walk all broker snapshots in the live buffer, accumulating signed-net
 * time series per broker. Buy-side brokers contribute positive net;
 * sell-side contribute negative net. Returns BrokerSeriesEntry[] sorted
 * by abs(final_net) desc and capped at 10 — matches the wire shape
 * BrokerTrajectoryTable expects (ADR-0023).
 *
 * Note: live broker snapshots are per-cycle top-5 lists, so the same
 * broker may drop in and out of the top-5 across snapshots. The
 * resulting series has gaps wherever a broker fell off the list — that
 * matches how /replay treats broker data and is intentional per ADR-0023.
 */
export function aggregateBrokerSeries(broker: RawSnapshot[]): BrokerSeriesEntry[] {
  const byBroker = new Map<string, BrokerSeriesPoint[]>();

  for (const snap of broker) {
    const ts = (snap.t_ms as number) ?? 0;
    const buys = (snap.buy_top as Array<{ name: string; qty: number }>) ?? [];
    const sells = (snap.sell_top as Array<{ name: string; qty: number }>) ?? [];
    for (const b of buys) {
      if (typeof b?.name !== 'string') continue;
      const pts = byBroker.get(b.name) ?? [];
      pts.push({ ts_ms: ts, net: b.qty ?? 0 });
      byBroker.set(b.name, pts);
    }
    for (const s of sells) {
      if (typeof s?.name !== 'string') continue;
      const pts = byBroker.get(s.name) ?? [];
      pts.push({ ts_ms: ts, net: -(s.qty ?? 0) });
      byBroker.set(s.name, pts);
    }
  }

  const entries: BrokerSeriesEntry[] = [];
  for (const [name, points] of byBroker.entries()) {
    points.sort((a, b) => a.ts_ms - b.ts_ms);
    const finalNet = points.length > 0 ? points[points.length - 1].net : 0;
    entries.push({
      broker: name,
      final_net: finalNet,
      dominant_side: finalNet >= 0 ? 'buy' : 'sell',
      points,
    });
  }

  entries.sort((a, b) => Math.abs(b.final_net) - Math.abs(a.final_net));
  return entries.slice(0, 10);
}

/** Hard cap on rendered fill-tape rows. Without this, /live's 2520-snapshot
 * buffer × ~30 trades/cycle produces ~27k Trade objects, which FillTape
 * renders un-virtualized (one DOM subtree per row) — measured at ~1.2s of
 * React reconciliation per SSE tick on a busy code. At ~1 trade/s typical
 * cadence, 500 covers the most-recent ~8 minutes — comfortably more than a
 * trader visually tracks on the live tape. */
const LIVE_FILLTAPE_MAX = 500;

/**
 * Flatten the per-cycle trade batches into a single chronologically-sorted
 * Trade[] for FillTape. Caps at LIVE_FILLTAPE_MAX most-recent rows.
 * Fills in cum_vol / change_pct / etc. with zero placeholders since live
 * snapshots don't carry those derived fields — FillTape only reads
 * price/qty/side/ts_ms so the placeholders are inert.
 */
export function flattenTrades(trade: RawSnapshot[]): Trade[] {
  const flat: Trade[] = [];
  let seqCounter = 0;
  for (const snap of trade) {
    const trades = (snap.trades as Array<{
      t_ms?: number;
      price?: number;
      qty?: number;
      side?: number;
    }>) ?? [];
    for (const t of trades) {
      flat.push({
        ts_ms: t.t_ms ?? 0,
        // Live snapshots don't carry a real seq; assign a monotonically
        // increasing counter so FillTape's `${ts_ms}-${seq}` React key
        // stays unique even when multiple trades share a t_ms (common with
        // 10s polling cycles collapsing several ticks).
        seq: seqCounter++,
        price: t.price ?? 0,
        change_pct: 0,
        qty: t.qty ?? 0,
        side: t.side ?? 0,
        cum_vol: 0,
        cum_trades: 0,
        low_so_far: 0,
        high_so_far: 0,
        net_pressure: 0,
      });
    }
  }
  flat.sort((a, b) => a.ts_ms - b.ts_ms);
  // Keep only the most-recent LIVE_FILLTAPE_MAX. Returning earlier rows would
  // force FillTape to render an un-virtualized 27k-row DOM subtree.
  return flat.length > LIVE_FILLTAPE_MAX ? flat.slice(-LIVE_FILLTAPE_MAX) : flat;
}

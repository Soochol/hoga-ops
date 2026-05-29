import type {
  BrokerSeriesEntry,
  BrokerSeriesPoint,
  OrderbookLevel,
  OrderbookSnapshot,
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
export function latestOrderbookSnapshot(ob: readonly RawSnapshot[]): OrderbookSnapshot | null {
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
export function aggregateBrokerSeries(broker: readonly RawSnapshot[]): BrokerSeriesEntry[] {
  const byBroker = new Map<string, BrokerSeriesPoint[]>();

  for (const snap of broker) {
    const ts = (snap.t_ms as number) ?? 0;
    const buys = (snap.buy_top as Array<{ name: string; qty: number }>) ?? [];
    const sells = (snap.sell_top as Array<{ name: string; qty: number }>) ?? [];
    // Sum buy and sell qty per broker within this snapshot so a market-maker
    // appearing on both top-5 lists collapses to one signed point (matches
    // backend query_day_series; see CONTEXT.md "Broker Day-Trajectory").
    const perSnap = new Map<string, number>();
    for (const b of buys) {
      if (typeof b?.name !== 'string') continue;
      perSnap.set(b.name, (perSnap.get(b.name) ?? 0) + (b.qty ?? 0));
    }
    for (const s of sells) {
      if (typeof s?.name !== 'string') continue;
      perSnap.set(s.name, (perSnap.get(s.name) ?? 0) - (s.qty ?? 0));
    }
    for (const [name, net] of perSnap) {
      const pts = byBroker.get(name) ?? [];
      pts.push({ ts_ms: ts, net });
      byBroker.set(name, pts);
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

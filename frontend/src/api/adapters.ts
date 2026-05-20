// Backend ships orderbook snapshot as parallel arrays (hoga/tables/snapshots.py::ApiOrderbookSnapshot):
//   { ts_ms, seq, ask_p: number[10], ask_q: number[10], ask_d: number[10],
//                    bid_p: number[10], bid_q: number[10], bid_d: number[10], tot_ask, tot_bid }
// Frontend's OrderbookSnapshot is the reshaped form with levels: OrderbookLevel[].
// This adapter is the boundary.
import type { OrderbookSnapshot, OrderbookLevel } from './types';

type FlatSnap = {
  ts_ms: number;
  seq?: number;
  ask_p: number[];
  ask_q: number[];
  ask_d?: number[];
  bid_p: number[];
  bid_q: number[];
  bid_d?: number[];
  tot_ask?: number;
  tot_bid?: number;
};

/** Backend's GET /api/orderbook returns { available_from, snapshot: FlatSnap | null }. */
export type OrderbookResponse = { available_from: number | null; snapshot: FlatSnap | null };

export function reshapeOrderbook(resp: OrderbookResponse): OrderbookSnapshot | null {
  const flat = resp.snapshot;
  if (!flat) return null;
  const levels: OrderbookLevel[] = [];
  // Backend always emits 10 entries per side; defend against unexpected shapes.
  const len = Math.min(10, flat.ask_p?.length ?? 0, flat.bid_p?.length ?? 0);
  for (let i = 0; i < len; i++) {
    levels.push({
      side: 'ask',
      rank: i + 1,
      price: flat.ask_p[i] ?? 0,
      qty: flat.ask_q[i] ?? 0,
    });
    levels.push({
      side: 'bid',
      rank: i + 1,
      price: flat.bid_p[i] ?? 0,
      qty: flat.bid_q[i] ?? 0,
    });
  }
  return { ts_ms: flat.ts_ms, levels };
}

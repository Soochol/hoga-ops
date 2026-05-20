// Backend ships flat orderbook (hoga/tables/snapshots.py::ApiOrderbookSnapshot)
// with ask_p1..10/ask_q1..10/bid_p1..10/bid_q1..10. Frontend's
// OrderbookSnapshot is the reshaped form with levels: OrderbookLevel[]. This
// adapter is the boundary.
import type { OrderbookSnapshot, OrderbookLevel } from './types';

type FlatSnap = {
  ts_ms: number;
  ask_p1: number; ask_p2: number; ask_p3: number; ask_p4: number; ask_p5: number;
  ask_p6: number; ask_p7: number; ask_p8: number; ask_p9: number; ask_p10: number;
  ask_q1: number; ask_q2: number; ask_q3: number; ask_q4: number; ask_q5: number;
  ask_q6: number; ask_q7: number; ask_q8: number; ask_q9: number; ask_q10: number;
  bid_p1: number; bid_p2: number; bid_p3: number; bid_p4: number; bid_p5: number;
  bid_p6: number; bid_p7: number; bid_p8: number; bid_p9: number; bid_p10: number;
  bid_q1: number; bid_q2: number; bid_q3: number; bid_q4: number; bid_q5: number;
  bid_q6: number; bid_q7: number; bid_q8: number; bid_q9: number; bid_q10: number;
};

/** Backend's GET /api/orderbook returns { available_from, snapshot: FlatSnap | null }. */
export type OrderbookResponse = { available_from: number | null; snapshot: FlatSnap | null };

export function reshapeOrderbook(resp: OrderbookResponse): OrderbookSnapshot | null {
  const flat = resp.snapshot;
  if (!flat) return null;
  const levels: OrderbookLevel[] = [];
  for (let i = 1; i <= 10; i++) {
    levels.push({
      side: 'ask',
      rank: i,
      price: (flat as unknown as Record<string, number>)[`ask_p${i}`],
      qty: (flat as unknown as Record<string, number>)[`ask_q${i}`],
    });
    levels.push({
      side: 'bid',
      rank: i,
      price: (flat as unknown as Record<string, number>)[`bid_p${i}`],
      qty: (flat as unknown as Record<string, number>)[`bid_q${i}`],
    });
  }
  return { ts_ms: flat.ts_ms, levels };
}

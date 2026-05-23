import type { OrderbookSnapshot } from '../api/types';

export type Totals = {
  askTotal: number;
  bidTotal: number;
  askPct: number;
  bidPct: number;
};

export function computeTotals(snapshot: OrderbookSnapshot): Totals {
  const askTotal = snapshot.tot_ask;
  const bidTotal = snapshot.tot_bid;
  const total = askTotal + bidTotal;
  const askPct = total > 0 ? askTotal / total : 0.5;
  const bidPct = total > 0 ? bidTotal / total : 0.5;
  return { askTotal, bidTotal, askPct, bidPct };
}

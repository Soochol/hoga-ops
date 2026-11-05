import type { OrderbookLevel } from '../../api/types';
import type { TradingSide } from '../../api/trading';

export type OrderDisplayRow =
  | ({ kind: 'market' } & OrderbookLevel)
  | { kind: 'source'; price: number };

export function orderDisplayRows({ asks, bids, ownPrices }: {
  asks: readonly OrderbookLevel[];
  bids: readonly OrderbookLevel[];
  ownPrices: readonly { price: number; side: TradingSide }[];
}) {
  const askRows: OrderDisplayRow[] = asks.map(level => ({ kind: 'market', ...level }));
  const bidRows: OrderDisplayRow[] = bids.map(level => ({ kind: 'market', ...level }));
  const observed = new Set([...asks, ...bids].map(level => level.price));
  const lowestAsk = asks.length ? Math.min(...asks.map(level => level.price)) : null;
  const highestBid = bids.length ? Math.max(...bids.map(level => level.price)) : null;
  const sellPrices = new Set(ownPrices.filter(item => item.side === 'SELL').map(item => item.price));
  for (const { price } of ownPrices) {
    if (observed.has(price)) continue;
    observed.add(price);
    const isAsk = lowestAsk !== null ? price >= lowestAsk
      : highestBid !== null ? price > highestBid : sellPrices.has(price);
    (isAsk ? askRows : bidRows).push({ kind: 'source', price });
  }
  askRows.sort((a, b) => b.price - a.price);
  bidRows.sort((a, b) => b.price - a.price);
  const slots = Math.max(10, askRows.length, bidRows.length);
  const askSlots: (OrderDisplayRow | null)[] = [...Array<null>(slots - askRows.length).fill(null), ...askRows];
  const bidSlots: (OrderDisplayRow | null)[] = [...bidRows, ...Array<null>(slots - bidRows.length).fill(null)];
  return { askSlots, bidSlots };
}

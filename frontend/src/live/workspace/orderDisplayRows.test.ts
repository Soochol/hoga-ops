import { describe, expect, it } from 'vitest';
import { orderDisplayRows } from './orderDisplayRows';

describe('orderDisplayRows', () => {
  it('preserves observed zero quantities and adds each exact own price once', () => {
    const asks = [{ price: 104, qty: 0 }, { price: 102, qty: 8 }];
    const bids = [{ price: 101, qty: 9 }, { price: 99, qty: 0 }];
    const { askSlots, bidSlots } = orderDisplayRows({ asks, bids, ownPrices: [
      { price: 103, side: 'SELL' }, { price: 103, side: 'BUY' },
      { price: 100, side: 'BUY' }, { price: 104, side: 'SELL' },
      { price: 999999999, side: 'BUY' }, { price: 1, side: 'SELL' },
    ] });
    expect(askSlots.filter(Boolean)).toEqual([
      { kind: 'source', price: 999999999 }, { kind: 'market', price: 104, qty: 0 },
      { kind: 'source', price: 103 }, { kind: 'market', price: 102, qty: 8 },
    ]);
    expect(bidSlots.filter(Boolean)).toEqual([
      { kind: 'market', price: 101, qty: 9 }, { kind: 'source', price: 100 },
      { kind: 'market', price: 99, qty: 0 }, { kind: 'source', price: 1 },
    ]);
    expect(askSlots).toHaveLength(10);
    expect(bidSlots).toHaveLength(10);
    expect(asks).toEqual([{ price: 104, qty: 0 }, { price: 102, qty: 8 }]);
  });

  it('expands both blocks without generating intervening ticks or losing market levels', () => {
    const asks = Array.from({ length: 10 }, (_, i) => ({ price: 200 + i * 10, qty: i }));
    const { askSlots, bidSlots } = orderDisplayRows({ asks, bids: [{ price: 100, qty: 1 }],
      ownPrices: [{ price: 205, side: 'SELL' }] });
    expect(askSlots).toHaveLength(11);
    expect(bidSlots).toHaveLength(11);
    expect(askSlots.filter(row => row?.kind === 'market')).toHaveLength(10);
    expect(askSlots[9]).toEqual({ kind: 'source', price: 205 });
    expect(bidSlots[0]).toEqual({ kind: 'market', price: 100, qty: 1 });
    expect(bidSlots.slice(1)).toEqual(Array(10).fill(null));
  });

  it('preserves simultaneous same-price market sides without a third row', () => {
    const { askSlots, bidSlots } = orderDisplayRows({ asks: [{ price: 100, qty: 4 }], bids: [{ price: 100, qty: 7 }],
      ownPrices: [{ price: 100, side: 'SELL' }, { price: 100, side: 'BUY' }] });
    expect(askSlots.at(-1)).toEqual({ kind: 'market', price: 100, qty: 4 });
    expect(bidSlots[0]).toEqual({ kind: 'market', price: 100, qty: 7 });
    expect([...askSlots, ...bidSlots].filter(row => row?.kind === 'source')).toEqual([]);
  });

  it.each(['ask', 'bid'] as const)('places supplements around the sole observed %s block', side => {
    const { askSlots, bidSlots } = orderDisplayRows({
      asks: side === 'ask' ? [{ price: 100, qty: 1 }] : [],
      bids: side === 'bid' ? [{ price: 100, qty: 1 }] : [],
      ownPrices: [{ price: 110, side: 'BUY' }, { price: 90, side: 'SELL' }],
    });
    expect(askSlots.filter(row => row?.kind === 'source')).toEqual([{ kind: 'source', price: 110 }]);
    expect(bidSlots.filter(row => row?.kind === 'source')).toEqual([{ kind: 'source', price: 90 }]);
  });

  it('uses SELL priority only without any market and moves the last BUY when SELL ends', () => {
    const both = orderDisplayRows({ asks: [], bids: [], ownPrices: [
      { price: 100, side: 'BUY' }, { price: 100, side: 'SELL' }, { price: 90, side: 'BUY' },
    ] });
    expect(both.askSlots.at(-1)).toEqual({ kind: 'source', price: 100 });
    expect(both.bidSlots[0]).toEqual({ kind: 'source', price: 90 });
    const buy = orderDisplayRows({ asks: [], bids: [], ownPrices: [{ price: 100, side: 'BUY' }] });
    expect(buy.askSlots.every(row => row === null)).toBe(true);
    expect(buy.bidSlots[0]).toEqual({ kind: 'source', price: 100 });
  });
});

it('preserves repeated observed levels on the same side with their independent quantities', () => {
  const { askSlots, bidSlots } = orderDisplayRows({
    asks: [{ price: 104, qty: 3 }, { price: 104, qty: 5 }, { price: 102, qty: 8 }],
    bids: [{ price: 101, qty: 7 }, { price: 101, qty: 9 }],
    ownPrices: [{ price: 104, side: 'SELL' }, { price: 101, side: 'BUY' }],
  });
  expect(askSlots.filter(Boolean)).toEqual([
    { kind: 'market', price: 104, qty: 3 }, { kind: 'market', price: 104, qty: 5 }, { kind: 'market', price: 102, qty: 8 },
  ]);
  expect(bidSlots.filter(Boolean)).toEqual([{ kind: 'market', price: 101, qty: 7 }, { kind: 'market', price: 101, qty: 9 }]);
});

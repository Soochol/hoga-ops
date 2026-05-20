import { describe, it, expect } from 'vitest';
import { reshapeOrderbook } from '../../src/api/adapters';

describe('reshapeOrderbook', () => {
  it('returns null when snapshot is null', () => {
    expect(reshapeOrderbook({ available_from: null, snapshot: null })).toBeNull();
  });

  it('parallel ask/bid arrays → 20 OrderbookLevel rows', () => {
    const flat = {
      ts_ms: 1779062400000,
      ask_p: [70010, 70020, 70030, 70040, 70050, 70060, 70070, 70080, 70090, 70100],
      ask_q: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
      bid_p: [69990, 69980, 69970, 69960, 69950, 69940, 69930, 69920, 69910, 69900],
      bid_q: [50, 100, 150, 200, 250, 300, 350, 400, 450, 500],
    };
    const out = reshapeOrderbook({ available_from: 0, snapshot: flat });
    expect(out).not.toBeNull();
    expect(out!.levels).toHaveLength(20);
    expect(out!.levels.filter((l) => l.side === 'ask')).toHaveLength(10);
    expect(out!.levels.filter((l) => l.side === 'bid')).toHaveLength(10);
    expect(out!.levels[0]).toMatchObject({ side: 'ask', rank: 1, price: 70010, qty: 100 });
    expect(out!.levels[1]).toMatchObject({ side: 'bid', rank: 1, price: 69990, qty: 50 });
  });

  it('emits only `len` rows when arrays are shorter than 10', () => {
    const flat = {
      ts_ms: 1779062400000,
      ask_p: [70010, 70020, 70030],
      ask_q: [100, 200, 300],
      bid_p: [69990, 69980, 69970],
      bid_q: [50, 100, 150],
    };
    const out = reshapeOrderbook({ available_from: 0, snapshot: flat });
    expect(out!.levels).toHaveLength(6);
  });
});

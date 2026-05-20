import { describe, it, expect } from 'vitest';
import { reshapeOrderbook } from '../../src/api/adapters';

describe('reshapeOrderbook', () => {
  it('returns null when snapshot is null', () => {
    expect(reshapeOrderbook({ available_from: null, snapshot: null })).toBeNull();
  });

  it('flat → 20 OrderbookLevel rows', () => {
    const flat: Record<string, number> = { ts_ms: 1779062400000 };
    for (let i = 1; i <= 10; i++) {
      flat[`ask_p${i}`] = 70000 + i * 10;
      flat[`ask_q${i}`] = 100 * i;
      flat[`bid_p${i}`] = 70000 - i * 10;
      flat[`bid_q${i}`] = 50 * i;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = reshapeOrderbook({ available_from: 0, snapshot: flat as any });
    expect(out).not.toBeNull();
    expect(out!.levels).toHaveLength(20);
    expect(out!.levels.filter((l) => l.side === 'ask')).toHaveLength(10);
    expect(out!.levels.filter((l) => l.side === 'bid')).toHaveLength(10);
    expect(out!.levels[0]).toMatchObject({ side: 'ask', rank: 1, price: 70010, qty: 100 });
  });
});

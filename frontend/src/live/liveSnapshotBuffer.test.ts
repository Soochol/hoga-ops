import { describe, it, expect } from 'vitest';
import { LiveSnapshotBuffer, MAX_BUFFER_PER_KIND } from './liveSnapshotBuffer';

describe('LiveSnapshotBuffer', () => {
  it('groups entries by kind', () => {
    const buf = new LiveSnapshotBuffer();
    buf.push({ t_ms: 1, kind: 'ob', total_bid_qty: 100 });
    buf.push({ t_ms: 1, kind: 'trade', trades: [] });
    buf.push({ t_ms: 1, kind: 'broker', buy_top: [] });
    expect(buf.get('ob')).toHaveLength(1);
    expect(buf.get('trade')).toHaveLength(1);
    expect(buf.get('broker')).toHaveLength(1);
  });

  it('preserves order within a kind', () => {
    const buf = new LiveSnapshotBuffer();
    for (let i = 0; i < 5; i++) buf.push({ t_ms: i, kind: 'ob', i });
    const obs = buf.get('ob');
    expect(obs.map((o: { t_ms: number }) => o.t_ms)).toEqual([0, 1, 2, 3, 4]);
  });

  it('caps each kind at MAX_BUFFER_PER_KIND (FIFO drop)', () => {
    const buf = new LiveSnapshotBuffer();
    const N = MAX_BUFFER_PER_KIND + 50;
    for (let i = 0; i < N; i++) buf.push({ t_ms: i, kind: 'ob', i });
    const obs = buf.get('ob');
    expect(obs).toHaveLength(MAX_BUFFER_PER_KIND);
    // Earliest 50 dropped — first remaining is index 50.
    expect((obs[0] as { i: number }).i).toBe(50);
  });

  it('ignores entries with unknown kind', () => {
    const buf = new LiveSnapshotBuffer();
    buf.push({ t_ms: 1, kind: 'bogus' } as any);
    expect(buf.get('ob')).toHaveLength(0);
    expect(buf.get('trade')).toHaveLength(0);
    expect(buf.get('broker')).toHaveLength(0);
  });

  it('hydrate replaces all buffers with provided arrays', () => {
    const buf = new LiveSnapshotBuffer();
    buf.push({ t_ms: 1, kind: 'ob' });
    buf.hydrate({
      ob: [{ t_ms: 10 }, { t_ms: 20 }],
      trade: [{ t_ms: 11 }],
      broker: [],
    });
    expect(buf.get('ob')).toHaveLength(2);
    expect(buf.get('trade')).toHaveLength(1);
    expect(buf.get('broker')).toHaveLength(0);
  });

  it('snapshot returns frozen-style copy', () => {
    const buf = new LiveSnapshotBuffer();
    buf.push({ t_ms: 1, kind: 'ob' });
    const snap = buf.get('ob');
    // Mutating snap shouldn't affect the buffer
    snap.push({ t_ms: 999, kind: 'ob' });
    expect(buf.get('ob')).toHaveLength(1);
  });
});

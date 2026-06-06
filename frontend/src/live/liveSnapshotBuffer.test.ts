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
    expect((obs[0] as unknown as { i: number }).i).toBe(50);
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
      ob: [{ t_ms: 10, kind: 'ob' }, { t_ms: 20, kind: 'ob' }],
      trade: [{ t_ms: 11, kind: 'trade' }],
      broker: [],
    });
    expect(buf.get('ob')).toHaveLength(2);
    expect(buf.get('trade')).toHaveLength(1);
    expect(buf.get('broker')).toHaveLength(0);
  });

  it('evicts entries older than retention window on push', () => {
    const buf = new LiveSnapshotBuffer();
    const old = { t_ms: 1_000, kind: 'ob' };
    const fresh = { t_ms: 16 * 60_000 + 1_000, kind: 'ob' };
    buf.push(old);
    buf.push(fresh); // fresh 기준 15분 컷오프 밖의 old는 제거
    expect(buf.get('ob').map((e) => e.t_ms)).toEqual([fresh.t_ms]);
  });

  it('get returns a frozen, stable reference until the kind is mutated', () => {
    const buf = new LiveSnapshotBuffer();
    buf.push({ t_ms: 1, kind: 'ob' });
    const a = buf.get('ob');
    const b = buf.get('ob');
    // Repeated get() with no push between returns the same reference —
    // this is what lets useMemo(bundle) skip recompute on idle SSE ticks.
    expect(a).toBe(b);
    // The snapshot is frozen, so accidental mutation throws in strict mode
    // (ESM tests run strict) instead of silently corrupting buffer state.
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => (a as unknown as { push: (x: unknown) => void }).push({ t_ms: 999, kind: 'ob' })).toThrow();
    // A push invalidates the cache — next get() returns a fresh reference.
    buf.push({ t_ms: 2, kind: 'ob' });
    const c = buf.get('ob');
    expect(c).not.toBe(a);
    expect(c).toHaveLength(2);
  });
});

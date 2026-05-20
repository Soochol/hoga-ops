import { describe, it, expect } from 'vitest';
import { LRUCache } from '../../src/util/lru';

describe('LRUCache', () => {
  it('rejects capacity <= 0', () => {
    expect(() => new LRUCache<string, number>(0)).toThrow(/capacity must be > 0/);
    expect(() => new LRUCache<string, number>(-1)).toThrow(/capacity must be > 0/);
  });

  it('get on missing key returns undefined', () => {
    const c = new LRUCache<string, number>(3);
    expect(c.get('missing')).toBeUndefined();
  });

  it('set + get round-trips', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBe(2);
  });

  it('evicts least-recently-used entry when capacity exceeded', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // evicts 'a'
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(true);
    expect(c.size).toBe(3);
  });

  it('get refreshes LRU position — touched item survives next eviction', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    // Touch 'a' so it becomes most-recent. 'b' is now LRU.
    expect(c.get('a')).toBe(1);
    c.set('d', 4); // should evict 'b', not 'a'
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(true);
  });

  it('set on existing key updates value and refreshes position', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('a', 10); // 'a' becomes most-recent
    c.set('d', 4); // should evict 'b' (now LRU), not 'a'
    expect(c.get('a')).toBe(10);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(true);
  });

  it('size reflects current entry count', () => {
    const c = new LRUCache<string, number>(3);
    expect(c.size).toBe(0);
    c.set('a', 1);
    expect(c.size).toBe(1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.size).toBe(3);
    c.set('d', 4);
    expect(c.size).toBe(3); // bounded by capacity
  });

  it('clear empties the cache', () => {
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBeUndefined();
  });

  it('has does not refresh LRU position', () => {
    // `has` is a peek — it must not affect eviction order.
    const c = new LRUCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.has('a'); // should NOT promote 'a'
    c.set('d', 4); // evicts 'a' (still LRU)
    expect(c.has('a')).toBe(false);
    expect(c.has('b')).toBe(true);
  });

  it('handles capacity = 1 (degenerate but valid)', () => {
    const c = new LRUCache<string, number>(1);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    c.set('b', 2);
    expect(c.has('a')).toBe(false);
    expect(c.get('b')).toBe(2);
    expect(c.size).toBe(1);
  });
});

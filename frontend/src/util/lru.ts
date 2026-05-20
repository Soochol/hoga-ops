/**
 * Minimal Map-based LRU cache.
 *
 * Relies on `Map` preserving insertion order: the *first* key is the
 * least-recently-used; the *last* key is the most-recently-used. On `get`,
 * a hit is re-inserted to move it to the MRU position. On `set` past
 * capacity, the LRU entry is evicted.
 */
export class LRUCache<K, V> {
  private readonly capacity: number;
  private readonly map = new Map<K, V>();

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('LRU capacity must be > 0');
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Re-insert to move to "most recent" position.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      // Evict least-recently-used (first key in insertion order).
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * In-memory ring buffer for live snapshots arriving over SSE.
 *
 * Mirrors backend's LiveBuffer cap (Eng C5 / spec §10): each kind capped at
 * MAX_BUFFER_PER_KIND. At 10s polling that's ~7 hours of regular session
 * plus 30 min after-hours — comfortably covers a full Live Session.
 *
 * Pure class (no React) so it can be tested without rendering. The React
 * wrapper lives in `liveSeries.ts`.
 */
export const MAX_BUFFER_PER_KIND = 2520;

export type SnapshotKind = 'ob' | 'trade' | 'broker';

const KINDS: readonly SnapshotKind[] = ['ob', 'trade', 'broker'] as const;

interface RawSnapshot {
  t_ms: number;
  kind: string;
  [k: string]: unknown;
}

export class LiveSnapshotBuffer {
  private byKind: Record<SnapshotKind, RawSnapshot[]> = {
    ob: [],
    trade: [],
    broker: [],
  };
  // Snapshot cache — returned by get() until the underlying kind is mutated.
  // Stable references let downstream useMemo(bundle) keep its identity across
  // SSE ticks that didn't actually touch a given kind. Without this, every
  // tick produced a fresh `[...arr]` for all three kinds, invalidating bundle
  // → forcing lightweight-charts setData on the full dataset every cycle.
  private snapshot: Record<SnapshotKind, readonly RawSnapshot[]> = {
    ob: Object.freeze([]),
    trade: Object.freeze([]),
    broker: Object.freeze([]),
  };

  private invalidate(k: SnapshotKind): void {
    // Defer the copy until get() is next called — that way bursts of pushes
    // between renders cost one allocation, not one per push.
    this.snapshot[k] = null as unknown as readonly RawSnapshot[];
  }

  push(entry: RawSnapshot): void {
    const k = entry.kind as SnapshotKind;
    if (!KINDS.includes(k)) return;
    const arr = this.byKind[k];
    arr.push(entry);
    if (arr.length > MAX_BUFFER_PER_KIND) {
      // FIFO drop — splice mutates in place, faster than slice+reassign.
      arr.splice(0, arr.length - MAX_BUFFER_PER_KIND);
    }
    this.invalidate(k);
  }

  hydrate(initial: Partial<Record<SnapshotKind, RawSnapshot[]>>): void {
    for (const k of KINDS) {
      const arr = initial[k] ?? [];
      // Apply cap on hydrate too — defensive against larger backend dumps.
      this.byKind[k] = arr.slice(-MAX_BUFFER_PER_KIND);
      this.invalidate(k);
    }
  }

  /** Returns a frozen, stable-reference snapshot of the kind's buffer.
   * The same reference is returned across multiple get() calls until the
   * next push()/hydrate()/clear() for that kind. Callers MUST NOT mutate
   * the returned array (it's frozen — attempts throw in strict mode).
   * If you need a mutable copy, do `[...buf.get(kind)]` at the call site. */
  get(kind: SnapshotKind): readonly RawSnapshot[] {
    if (this.snapshot[kind] === null) {
      this.snapshot[kind] = Object.freeze([...this.byKind[kind]]);
    }
    return this.snapshot[kind];
  }

  clear(): void {
    for (const k of KINDS) {
      this.byKind[k] = [];
      this.invalidate(k);
    }
  }
}

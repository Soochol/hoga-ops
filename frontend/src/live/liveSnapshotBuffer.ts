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

  push(entry: RawSnapshot): void {
    const k = entry.kind as SnapshotKind;
    if (!KINDS.includes(k)) return;
    const arr = this.byKind[k];
    arr.push(entry);
    if (arr.length > MAX_BUFFER_PER_KIND) {
      // FIFO drop — splice mutates in place, faster than slice+reassign.
      arr.splice(0, arr.length - MAX_BUFFER_PER_KIND);
    }
  }

  hydrate(initial: Partial<Record<SnapshotKind, RawSnapshot[]>>): void {
    for (const k of KINDS) {
      const arr = initial[k] ?? [];
      // Apply cap on hydrate too — defensive against larger backend dumps.
      this.byKind[k] = arr.slice(-MAX_BUFFER_PER_KIND);
    }
  }

  get(kind: SnapshotKind): RawSnapshot[] {
    // Return a copy so callers can mutate freely without affecting internal state.
    return [...this.byKind[kind]];
  }

  clear(): void {
    for (const k of KINDS) this.byKind[k] = [];
  }
}

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

/** 봉합 사이징 불변식(spec §8): 보존 > 2× Today Promotion 주기(5분) → 15분.
 *  백엔드 LiveBuffer(retention 900s)와 동일 원칙 — per-tick 유량에서 개수 캡이
 *  pastMaxT까지의 꼬리를 자르면 지표 봉합에 구멍이 난다. */
const RETENTION_MS = 15 * 60_000;

function evictOld(arr: Array<{ t_ms: number }>, nowMs: number): void {
  const cutoff = nowMs - RETENTION_MS;
  let drop = 0;
  while (drop < arr.length && arr[drop].t_ms < cutoff) drop += 1;
  if (drop > 0) arr.splice(0, drop);
}

// Safety-pin cap raised to 60_000 (from 2520) — time eviction is now the
// primary size bound; the count cap remains only as a runaway safeguard.
export const MAX_BUFFER_PER_KIND = 60_000;

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
    // Time-based eviction: drop entries older than RETENTION_MS relative to
    // the incoming entry. Array is t_ms-ascending (append-only), so a prefix
    // scan suffices — same assumption as backend LiveBuffer.
    evictOld(arr, entry.t_ms);
    if (arr.length > MAX_BUFFER_PER_KIND) {
      // FIFO count cap — safety-pin against runaway growth if time eviction
      // assumption (ascending t_ms) is violated or retention is very wide.
      arr.splice(0, arr.length - MAX_BUFFER_PER_KIND);
    }
    this.invalidate(k);
  }

  hydrate(initial: Partial<Record<SnapshotKind, RawSnapshot[]>>): void {
    for (const k of KINDS) {
      const arr = initial[k] ?? [];
      // No time eviction on hydrate: the backend already applies retention
      // (LiveBuffer 900s) before serialising the initial snapshot, so the
      // data arriving here is already within the window. Any stale tail will
      // be naturally evicted on the first push() that follows.
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

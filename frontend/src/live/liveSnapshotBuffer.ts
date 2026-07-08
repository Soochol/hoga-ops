/**
 * In-memory ring buffer for live snapshots arriving over SSE.
 *
 * Sizing mirrors backend LiveBuffer (buffer.py): a 15-min sliding time window
 * (RETENTION_MS) is the real bound; the count cap (MAX_BUFFER_PER_KIND) is only
 * a runaway safety-pin. The 15-min window is NOT for "covering a whole session"
 * — it exists to bridge the today-indicator seam: buildLiveBundle stitches
 * [/api/range past (≤pastMaxQrT)] + [this buffer's incremental (>pastMaxQrT)],
 * and /api/range refetches every 5 min (Today Promotion cadence, range.ts) to
 * advance pastMaxQrT. The buffer must cover the worst-case lag of pastMaxQrT
 * behind now — promotion_period + refetch_period ≈ 10min; 15min > 10min with
 * margin, so the seam never opens a hole (spec §8 봉합 사이징 불변식 / review C1).
 *
 * Pure class (no React) so it can be tested without rendering. The React
 * wrapper lives in `liveSeries.ts`.
 */

/** 봉합 사이징 불변식(spec §8): 보존 > 2× Today Promotion 주기(5분) → 15분.
 *  백엔드 LiveBuffer(retention 900s)와 동일 원칙 — per-tick 유량에서 개수 캡이
 *  pastMaxT까지의 꼬리를 자르면 지표 봉합에 구멍이 난다. */
export const RETENTION_MS = 15 * 60_000;

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
    // Quiet-kind caveat (mirrors buffer.py:138 drop_codes_except): eviction is
    // driven by THIS kind's pushes, so a kind that stops ticking keeps its tail
    // until its next push — a fail-safe over-retention bounded by the 60k
    // count-cap pin, never an under-retention (no seam risk).
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
      // No time eviction on hydrate: backend eviction runs on the publish
      // path (LiveBuffer.publish, retention 900s) — get_series itself does
      // not filter — so an actively-published code's ring is continuously
      // pruned (active Live Set codes publish every ~10s). Any residual
      // stale tail is cleaned up by evictOld on the first push() that follows.
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

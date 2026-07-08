import { describe, it, expect } from 'vitest';
import { RETENTION_MS } from '../live/liveSnapshotBuffer';
import { TODAY_RANGE_REFETCH_MS } from './range';

/** 봉합 사이징 불변식(spec §8): the live snapshot buffer must retain long enough
 * to bridge the today-indicator seam — its window must exceed one Today
 * Promotion period plus one range-refetch period, or the SSE tail and the
 * disk-promoted range can leave a hole. WS 푸시 승격 무효화 (PR-3) accelerates
 * the refetch but keeps the 5-min fallback, so this bound is unchanged; the
 * later fallback demotion (5→15min) must retune RETENTION_MS *together* or this
 * test fails — which is the point.
 *
 * These are mirrors of backend constants; a contract test turns the "주석 계약"
 * into a red build when either side drifts. */
const BACKEND_RETENTION_MS = 900_000; // hoga/live/buffer.py DEFAULT_RETENTION_MS
const BACKEND_PROMOTE_INTERVAL_MS = 300_000; // startup_runtime.py default (300s)

describe('seam sizing contract (frontend ↔ backend)', () => {
  it('both ends agree on the buffer retention window', () => {
    expect(RETENTION_MS).toBe(BACKEND_RETENTION_MS);
  });

  it('retention exceeds promote period + refetch period', () => {
    expect(RETENTION_MS).toBeGreaterThan(BACKEND_PROMOTE_INTERVAL_MS + TODAY_RANGE_REFETCH_MS);
  });
});

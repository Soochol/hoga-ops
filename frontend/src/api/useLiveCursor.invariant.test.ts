/**
 * ADR-0044 invariant guard — the hover spot FETCHERS must not import LiveBuffer
 * / SSE modules. Static grep on source; fails if any forbidden import appears.
 *
 * Scope note (ADR-0044 amendment, 2026-06-11): the hover path is now a sanctioned
 * hybrid — parquet stays authoritative, but when it has no snapshot for a recent
 * candle (Today-Promotion lag) LiveSidebar fills that gap from the in-memory SSE
 * buffer (`live.ob`) CLIENT-SIDE via `orderbookSnapshotAtCursor`. That hybrid
 * lives at the LiveSidebar composition layer, NOT in this fetcher: the fetcher
 * stays parquet-only and parquet takes precedence (the two never answer for the
 * same time), which is exactly the "new seam + ADR amendment" the guard below
 * asks for. So this fetcher invariant remains intact and this test stays green —
 * do not quietly add an SSE import HERE; extend the LiveSidebar layer instead.
 *
 * Uses vite's `?raw` import (filename suffix) so the source text is inlined
 * at bundle time. Avoids node:fs / process (not in tsconfig.app.json types)
 * and the jsdom `import.meta.url` mismatch.
 */
import { describe, expect, it } from 'vitest';
import SOURCE from './useLiveCursor.ts?raw';

describe('ADR-0044 invariant', () => {
  it('hover hooks do not import LiveBuffer / useLiveStream / liveSnapshotBuffer', () => {
    // Anchor list mirrors hoga/live/ module names and the live page's
    // SSE-stream modules. If a future feature genuinely needs a hybrid
    // path, do that with a NEW hook + ADR amendment — not a quiet import.
    expect(SOURCE).not.toMatch(/from ['"](?:[^'"]*\/)?useLiveStream['"]/);
    expect(SOURCE).not.toMatch(/from ['"](?:[^'"]*\/)?liveSnapshotBuffer['"]/);
    expect(SOURCE).not.toMatch(/from ['"](?:[^'"]*\/)?liveSeries['"]/);
    expect(SOURCE).not.toMatch(/\bLiveBuffer\b/);
  });
});

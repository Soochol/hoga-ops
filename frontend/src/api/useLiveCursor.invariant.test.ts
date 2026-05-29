/**
 * ADR-0044 invariant guard — hover hooks must not import LiveBuffer / SSE
 * modules. Static grep on source; fails if any forbidden import appears.
 *
 * If a future feature genuinely needs a hybrid path, create a NEW hook with
 * its own ADR amendment — do not quietly add an import here.
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

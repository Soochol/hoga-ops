/**
 * ADR-0044 invariant guard — hover hooks must not import LiveBuffer / SSE
 * modules. Static grep on source; fails if any forbidden import appears.
 *
 * If a future feature genuinely needs a hybrid path, create a NEW hook with
 * its own ADR amendment — do not quietly add an import here.
 *
 * Note: resolves the source file via process.cwd() + relative path because
 * the jsdom test environment mocks import.meta.url as http://, not file://,
 * making `new URL(import.meta.url)` throw "URL must be of scheme file".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest sets process.cwd() to the package root (frontend/).
const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/api/useLiveCursor.ts'),
  'utf-8',
);

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

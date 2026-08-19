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
import CURSOR_SOURCE from './useLiveCursor.ts?raw';
import BROKER_SOURCE from './brokerSeries.ts?raw';

/**
 * 감시 대상은 "이 파일" 이 아니라 **fetcher 가 실제로 사는 곳**이다.
 *
 * 거래원 fetcher 가 `brokerSeries.ts` 로 이사했을 때 이 목록을 같이 늘리지 않으면,
 * 가드는 초록인 채로 **아무것도 안 보게 된다** — 옮겨간 쪽에 SSE import 를 넣어도
 * 통과한다. 파일을 쪼갤 때마다 여기에 추가한다.
 */
const FETCHER_SOURCES: ReadonlyArray<readonly [name: string, source: string]> = [
  ['useLiveCursor.ts', CURSOR_SOURCE],
  ['brokerSeries.ts', BROKER_SOURCE],
];

describe('ADR-0044 invariant', () => {
  it.each(FETCHER_SOURCES)(
    '%s: hover hooks do not import LiveBuffer / useLiveStream / liveSnapshotBuffer',
    (_name, SOURCE) => {
      // Anchor list mirrors hoga/live/ module names and the live page's
      // SSE-stream modules. If a future feature genuinely needs a hybrid
      // path, do that with a NEW hook + ADR amendment — not a quiet import.
      expect(SOURCE).not.toMatch(/from ['"](?:[^'"]*\/)?useLiveStream['"]/);
      expect(SOURCE).not.toMatch(/from ['"](?:[^'"]*\/)?liveSnapshotBuffer['"]/);
      expect(SOURCE).not.toMatch(/from ['"](?:[^'"]*\/)?liveSeries['"]/);
      expect(SOURCE).not.toMatch(/\bLiveBuffer\b/);
    },
  );
});

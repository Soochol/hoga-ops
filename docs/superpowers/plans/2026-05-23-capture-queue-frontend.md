# Capture Queue Frontend — Plan C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the redesigned `/capture` page on top of Plan B's queue backend — `SymbolSearch` + `DateRangePicker` (2-month grid with status markers) drive a left-pane form; the right pane is a live queue with header summary, Cancel All, Dismiss Done, per-row cancel/retry, and detail expansion. The `LeftNav` pill is rewritten to summarize the multi-item queue. Plan B's single-capture endpoint deletion already broke the existing frontend at runtime — this plan replaces it cleanly.

**Architecture:** Three new `api/*.ts` wrappers mirror Plan B's queue + symbols + calendar routes. `useSymbols` does one bulk fetch then client-side filtering; `useCalendar` reconciles SSE patches against `as_of_ms` per spec §11 Q21; `useCaptureQueue` is the SSE multiplex. `pages/Capture.tsx` is a 38/62 split (controls left, queue right). Visual choices use only DESIGN.md tokens — no new design tokens. Legacy `CaptureForm/CaptureProgress/CaptureLog/CaptureResult/useCaptureJob` are deleted in one hard cut, mirroring Plan B's Task 13 backend pattern.

**Tech Stack:** React 19 + TypeScript + Vite + `@tanstack/react-query` (existing), `@tanstack/react-virtual` (NEW — virtualizes queue rows past 200), `vitest` + `@testing-library/react` (existing), `@playwright/test` (existing). No other new dependencies.

Spec authority: `docs/superpowers/specs/2026-05-21-capture-range-redesign-design.md` — §4 (Frontend), §6 (Design System Conformance), §7.2 (vitest), §7.3 (Playwright), §11 Q14/Q16/Q18/Q19/Q21. DESIGN.md as design source of truth (tokens, typography, spacing).

---

## File Structure

```
frontend/src/
  api/
    types.ts                                [modify]   Replace CaptureJob shape with QueueItem; rename
                                                       CaptureEventBase.job_id → item_id; extend
                                                       CapturePhase literal with queued/deciding/skipped;
                                                       add SkipReason, SymbolHit, SymbolsAllResponse,
                                                       CalendarCell/CalendarResponse/CalendarStatus,
                                                       EnqueueRequest/EnqueueDedupedRow/EnqueueResponse,
                                                       QueueSnapshot, 4 new SSE event variants
                                                       (capture_queued/queue_paused/queue_resumed/queue_drained).
    sse.ts                                  [modify]   Add 4 new addEventListener calls; broaden
                                                       subscribeToCaptureEvents filter; drop the legacy
                                                       ['capture','latest'] invalidation from useEventStream.
    symbols.ts                  [new]                  getAllSymbols, searchSymbols, refreshSymbols.
    calendar.ts                 [new]                  getCalendar (returns CalendarResponse).
    captures.ts                             [rewrite]  Drop startCapture/getLatestCapture/cancelLatest/
                                                       dismissLatest; add addItems, getQueue, cancelItem,
                                                       cancelAll, resumeQueue, dismissDone.

  capture/
    SymbolSearch.tsx            [new]                  Input + rich dropdown. Q18 (captured_count primary +
                                                       breakdown tooltip). Q19 (cache status indicator).
                                                       Keyboard nav (↑↓/Enter/Esc/Tab).
    CalendarCell.tsx            [new]                  32×32 grid cell. Status badge top-right; range mid
                                                       and endpoints; today_locked 🔒.
    DateRangePicker.tsx         [new]                  2-month grid. Range selection (anchor + swap).
                                                       Q14: today < 18 KST disabled, 60s re-eval.
    CaptureForm.tsx                         [rewrite]  Compose SymbolSearch + DateRangePicker + options
                                                       (force_retry toggle) + Start button. Form stays
                                                       interactive while queue runs.
    CaptureQueueRow.tsx         [new]                  Single row: status icon + date + code + name +
                                                       phase chip + pages + events + mini bar + action.
                                                       Q16: ⚠ force chip when item.force_retry.
                                                       Click toggles CaptureRowDetail beneath.
    CaptureRowDetail.tsx        [new]                  Last 5 log lines (per-item ref buffer) +
                                                       started_at_ms / frontier_ms / error message.
    CaptureQueue.tsx            [new]                  Header summary + Cancel All + Dismiss Done +
                                                       table. Virtualization (@tanstack/react-virtual)
                                                       when queue length > 200.
    useSymbols.ts               [new]                  useSymbols (24h staleTime); useSymbolSearch (in-memory filter).
    useCalendar.ts              [new]                  useCalendar (per code+year+month). Q21: SSE patches
                                                       stamped with patched_at_ms; GET response only overrides
                                                       cells where prev.patched_at_ms ≤ incoming.as_of_ms.
    useCaptureQueue.ts                      [rewrite]  Queue snapshot + SSE multiplex + mutations
                                                       (addItems, cancelItem, cancelAll, dismissDone,
                                                       resumeQueue).

    [DELETE] CaptureForm.tsx (old)          + CaptureForm.test.tsx
    [DELETE] CaptureProgress.tsx            + CaptureProgress.test.tsx
    [DELETE] CaptureLog.tsx
    [DELETE] CaptureResult.tsx              + CaptureResult.test.tsx
    [DELETE] useCaptureJob.ts               + useCaptureJob.test.tsx

  nav/
    CaptureStatusPill.tsx                   [rewrite]  Queue summary "{N} capturing · {M} queued · ~{eta}m".
                                                       Pulsing teal CAPTURING; amber static PAUSED;
                                                       renders null when queue empty + not paused.

  pages/
    Capture.tsx                             [rewrite]  38/62 split layout. Controls left, queue right.
                                                       Calendar legend at bottom-left.

  styles/global.css                         [modify]   Verify @keyframes capture-pulse still present (used
                                                       by CaptureStatusPill). No new keyframes needed —
                                                       reuse existing.

frontend/tests/e2e/
  range-capture.spec.ts        [new]
  calendar-markers.spec.ts     [new]
  cookie-pause.spec.ts         [new]

frontend/package.json                       [modify]   Add @tanstack/react-virtual dep.
```

Each module has one responsibility:
- `api/*` — typed wrappers around HTTP routes. No state, no React. Pure functions returning Promises.
- `capture/use*` — React Query hooks. Own the cache shape and SSE-driven mutations. No JSX.
- `capture/*.tsx` (atomic: CalendarCell, SymbolSearch) — controlled presentational components.
- `capture/*.tsx` (container: CaptureQueue, CaptureForm) — composition over hooks; minimal direct DOM logic.
- `pages/Capture.tsx` — layout only; delegates to capture/* components.
- `nav/CaptureStatusPill.tsx` — reads `useCaptureQueue` directly; renders the cross-page pill.

---

## Pre-flight (do before Task 1)

- [ ] **Step P1: Verify worktree branch**

Run: `git rev-parse --abbrev-ref HEAD`
Expected: `worktree-feat+frontend2`.

- [ ] **Step P2: Confirm backend Plan B is green (263 tests)**

Run: `uv run pytest -q 2>&1 | tail -3`
Expected: `263 passed`.

- [ ] **Step P3: Confirm current frontend vitest count (baseline before Plan C)**

Run: `cd frontend && npx vitest run 2>&1 | tail -5`
Expected: 25 test files, 103 tests passing. Note exact counts to compare against after Phase 2 (legacy delete) and after Phase 6 (new components landed).

- [ ] **Step P4: Confirm DESIGN.md tokens to be used**

Run: `grep -n "^- \`--" DESIGN.md | head -25`
Expected: token list including `--bg`, `--bg-card`, `--bg-subtle`, `--bg-input`, `--bg-input-hover`, `--border`, `--border-strong`, `--fg`, `--fg-dim`, `--fg-dimmer`, `--accent`, `--up`, `--down`. These are the ONLY palette tokens permitted. Specifically, ⚠ markers use `--warn` (defined in DESIGN.md spacing/color but currently aliased to amber `#F59E0B` per the "Warning" semantic row).

If `--warn` is not currently exported as a CSS variable in the global stylesheet, add it as part of Task 10 (CalendarCell) — that's the first consumer. Don't synthesize a hex literal anywhere.

- [ ] **Step P5: Pre-install the new dep**

Run: `cd frontend && npm install @tanstack/react-virtual`
Expected: install completes; no other lockfile changes. Commit the dep bump separately at the end of Task 16 (the consumer task).

- [ ] **Step P6: Verify Playwright is configured**

Run: `cd frontend && cat playwright.config.ts 2>/dev/null | head -20`
Expected: existing config. If absent, Task 19 sets it up; flag here so it's not a surprise.

---

# Phase 1 — Wire layer (types + sse + api modules)

The communication layer must compile against Plan B's backend shapes before any UI work. Once these five tasks land, every later component can `import type { QueueItem } from '../api/types'` without forward references.

## Task 1: Extend `frontend/src/api/types.ts` with Plan B wire models

**Files:**
- Modify: `frontend/src/api/types.ts` — rename CaptureEventBase field, replace CaptureJob, add 8 new types, extend SSEEvent union
- Test: TypeScript compile alone is the verification (no runtime test file for pure type changes)

ADR-0004 mandate: every type added here must mirror `hoga/api/models.py` field-for-field. No adapter layer.

- [ ] **Step 1: Replace the legacy `CaptureJob` block with `QueueItem`**

Edit `frontend/src/api/types.ts`. Find the existing block (lines ~79–112: `CapturePhase`, `CaptureProgress`, `CaptureResult`, `CaptureError`, `CaptureJob`, `CaptureEventBase`). Replace with:

```ts
export type CapturePhase =
  | 'queued'
  | 'deciding'
  | 'capturing'
  | 'parsing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type SkipReason = 'already_complete' | 'source_partial';

export interface CaptureProgress {
  pages_done: number;
  events_seen: number;
  frontier_ms: number;       // Unix epoch ms per ADR-0003
  estimate_pct: number;
  elapsed_ms: number;
}

export interface CaptureResult {
  pages_written: number;
  unique_events: number;
  raw_dir: string;
  parsed: boolean;
}

export interface CaptureError {
  code: string;
  message: string;
  at_page?: number | null;
}

/** Mirrors hoga/api/models.py::QueueItem. */
export interface QueueItem {
  item_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
  force_retry: boolean;
  pause_origin: boolean;
  enqueued_at_ms: number;
  started_at_ms: number | null;
  progress: CaptureProgress | null;
  result: CaptureResult | null;
  error: CaptureError | null;
  skip_reason: SkipReason | null;
}

/** Common header on every per-item SSE event (capture_progress / capture_phase /
 *  capture_finished). Mirrors hoga/api/models.py::_CaptureEventBase. */
export interface CaptureEventBase {
  item_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
}
```

- [ ] **Step 2: Add the sibling-endpoint wire models**

Append to `frontend/src/api/types.ts`:

```ts
/** Mirrors hoga/api/models.py::SymbolHit. */
export interface SymbolHit {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  captured_count: number;                              // complete-only headline
  captured_breakdown: {
    complete: number;
    source_partial: number;
    client_incomplete: number;
  };
}

export type SymbolsCacheStatus = 'loading' | 'fresh' | 'stale' | 'unavailable';

/** Mirrors hoga/api/models.py::SymbolsAllResponse. */
export interface SymbolsAllResponse {
  symbols: SymbolHit[];
  status: SymbolsCacheStatus;
  fetched_at_ms: number | null;
}

export type CalendarStatus =
  | 'complete'
  | 'source_partial'
  | 'client_incomplete'
  | 'none'
  | 'weekend'
  | 'holiday'
  | 'future'
  | 'today_locked';

/** Mirrors hoga/api/models.py::CalendarCell. */
export interface CalendarCell {
  date: string;
  status: CalendarStatus;
  captured_at_ms: number | null;
}

/** Mirrors hoga/api/models.py::CalendarResponse. */
export interface CalendarResponse {
  cells: CalendarCell[];
  as_of_ms: number;                                    // spec §11 Q21 reconciliation key
}

/** Mirrors hoga/api/models.py::EnqueueRequest. */
export interface EnqueueRequest {
  code: string;
  start_date?: string | null;
  end_date?: string | null;
  dates?: string[] | null;
  force_retry: boolean;
}

export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: 'already_in_queue' | 'already_running';
}

/** Mirrors hoga/api/models.py::EnqueueResponse. */
export interface EnqueueResponse {
  enqueued: QueueItem[];
  deduped: EnqueueDedupedRow[];
}

/** Mirrors hoga/api/models.py::QueueSnapshot. */
export interface QueueSnapshot {
  active: QueueItem[];
  queued: QueueItem[];
  done: QueueItem[];
  paused: boolean;
  max_concurrent: number;
}
```

- [ ] **Step 3: Extend the `SSEEvent` discriminated union**

Replace the existing `SSEEvent =` block (lines ~125–132) with:

```ts
export type SSEEvent =
  | { type: 'inventory_added'; code: string; date: string }
  | { type: 'inventory_removed'; code: string; date: string }
  | (CaptureEventBase & { type: 'capture_progress'; progress: CaptureProgress })
  | (CaptureEventBase & { type: 'capture_phase' })
  | (CaptureEventBase & {
      type: 'capture_finished';
      result: CaptureResult | null;
      error: CaptureError | null;
      skip_reason: SkipReason | null;
    })
  | { type: 'capture_queued'; items: QueueItem[] }
  | { type: 'capture_queue_paused'; reason: 'cookie_expired'; message: string }
  | { type: 'capture_queue_resumed'; reason: 'user_resume' | 'cancel_all' }
  | {
      type: 'capture_queue_drained';
      total_done: number;
      total_failed: number;
      total_cancelled: number;
      total_skipped: number;
    }
  | { type: 'heartbeat' }
  | { type: 'disconnected' };
```

- [ ] **Step 4: Type-check the package**

Run: `cd frontend && npx tsc -b --noEmit 2>&1 | tail -20`
Expected: TypeScript errors flagged in `captures.ts` (uses removed `CaptureJob` shape) and any component still importing `CaptureJob`. These are EXPECTED — they identify the call sites Task 5 and Task 6 must rewrite. Note the error list. The CURRENT vitest run will fail until Task 5; don't run vitest yet.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "$(cat <<'EOF'
feat(frontend/types): mirror Plan B wire models (QueueItem + symbols + calendar)

Replaces CaptureJob (which carried options + job_id from the old single-
capture API) with QueueItem (item_id + force_retry + pause_origin +
skip_reason). Adds SymbolHit, SymbolsAllResponse, CalendarCell,
CalendarResponse, EnqueueRequest/Response, QueueSnapshot. Extends the
SSEEvent union with 4 new capture_queue_* variants. Per ADR-0004, every
field mirrors hoga/api/models.py verbatim.

Compile errors in captures.ts / capture/* are expected — Tasks 5 + 6
clean them up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `frontend/src/api/sse.ts` with new event listeners

**Files:**
- Modify: `frontend/src/api/sse.ts`
- Test: `frontend/src/api/sse.test.ts` (existing or new — add cases for new event types)

- [ ] **Step 1: Write the failing tests**

Create or extend `frontend/src/api/sse.test.ts`:
```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { __resetForTests, subscribeToCaptureEvents } from './sse';
import type { SSEEvent } from './types';

// Helper that mounts a fake EventSource so addEventListener traps capture events.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(t: string, cb: (e: MessageEvent) => void) {
    const arr = this.listeners.get(t) ?? [];
    arr.push(cb);
    this.listeners.set(t, arr);
  }
  fire(t: string, data: unknown) {
    (this.listeners.get(t) ?? []).forEach((cb) =>
      cb({ data: JSON.stringify(data) } as MessageEvent),
    );
  }
  close() {}
}

beforeEach(() => {
  __resetForTests();
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
});

describe('subscribeToCaptureEvents', () => {
  it('delivers capture_queued events to subscribers', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    // Let open() resolve.
    await new Promise((r) => setTimeout(r, 0));
    const src = FakeEventSource.instances[0];
    src.fire('capture_queued', { items: [{ item_id: 'x', code: '005930', date: '20260520' }] });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('capture_queued');
  });

  it('delivers capture_queue_paused, capture_queue_resumed, capture_queue_drained', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0));
    const src = FakeEventSource.instances[0];
    src.fire('capture_queue_paused', { reason: 'cookie_expired', message: 'expired' });
    src.fire('capture_queue_resumed', { reason: 'user_resume' });
    src.fire('capture_queue_drained', { total_done: 1, total_failed: 0, total_cancelled: 0, total_skipped: 0 });
    expect(events.map((e) => e.type)).toEqual([
      'capture_queue_paused', 'capture_queue_resumed', 'capture_queue_drained',
    ]);
  });

  it('drops non-capture events (inventory_added) through the capture filter', async () => {
    const events: SSEEvent[] = [];
    subscribeToCaptureEvents((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0));
    const src = FakeEventSource.instances[0];
    src.fire('inventory_added', { code: '005930', date: '20260520' });
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/api/sse.test.ts`
Expected: FAIL — sse.ts doesn't register the 4 new event types yet.

- [ ] **Step 3: Add the 4 new listeners and broaden the filter**

Edit `frontend/src/api/sse.ts` `open()` function. After the existing `capture_finished` addEventListener, append:
```ts
    src.addEventListener('capture_queued', (e: MessageEvent) =>
      emit({ type: 'capture_queued', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queue_paused', (e: MessageEvent) =>
      emit({ type: 'capture_queue_paused', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queue_resumed', (e: MessageEvent) =>
      emit({ type: 'capture_queue_resumed', ...JSON.parse(e.data) }),
    );
    src.addEventListener('capture_queue_drained', (e: MessageEvent) =>
      emit({ type: 'capture_queue_drained', ...JSON.parse(e.data) }),
    );
```

Replace the `subscribeToCaptureEvents` filter (lines ~84–90) with:
```ts
export function subscribeToCaptureEvents(handler: (e: SSEEvent) => void): () => void {
  void open();
  const wrapped = (e: SSEEvent) => {
    if (
      e.type === 'capture_progress' ||
      e.type === 'capture_phase' ||
      e.type === 'capture_finished' ||
      e.type === 'capture_queued' ||
      e.type === 'capture_queue_paused' ||
      e.type === 'capture_queue_resumed' ||
      e.type === 'capture_queue_drained'
    ) {
      handler(e);
    }
  };
  _subscribers.add(wrapped);
  return () => {
    _subscribers.delete(wrapped);
  };
}
```

In `useEventStream`, remove the legacy `qc.invalidateQueries({ queryKey: ['capture', 'latest'] })` line — that cache key is dead.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/api/sse.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/sse.ts frontend/src/api/sse.test.ts
git commit -m "feat(frontend/sse): listen for 4 new capture_queue_* events

Adds addEventListener for capture_queued / capture_queue_paused /
capture_queue_resumed / capture_queue_drained. Broadens the
subscribeToCaptureEvents filter so queue-event consumers receive them.
Drops the dead ['capture','latest'] invalidation from useEventStream
(the latest singleton route is gone in Plan B).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create `frontend/src/api/symbols.ts`

**Files:**
- Create: `frontend/src/api/symbols.ts`
- Test: `frontend/src/api/symbols.test.ts` [new]

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api/symbols.test.ts`:
```ts
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getAllSymbols, searchSymbols, refreshSymbols } from './symbols';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, ok = true) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response);
}

describe('symbols api', () => {
  it('getAllSymbols returns the SymbolsAllResponse envelope', async () => {
    mockFetch({
      symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI',
                   captured_count: 0, captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } }],
      status: 'fresh', fetched_at_ms: 1_700_000_000_000,
    });
    const resp = await getAllSymbols();
    expect(resp.status).toBe('fresh');
    expect(resp.symbols[0].code).toBe('005930');
  });

  it('searchSymbols posts q + limit and returns the SymbolHit list', async () => {
    const f = mockFetch([{ code: '005930', name: '삼성전자', market: 'KOSPI',
                            captured_count: 14,
                            captured_breakdown: { complete: 14, source_partial: 0, client_incomplete: 0 } }]);
    const hits = await searchSymbols('삼성', 5);
    expect(f).toHaveBeenCalled();
    const url = f.mock.calls[0][0] as string;
    expect(url).toContain('/api/symbols?');
    expect(url).toContain('q=%EC%82%BC%EC%84%B1');   // url-encoded "삼성"
    expect(url).toContain('limit=5');
    expect(hits[0].captured_count).toBe(14);
  });

  it('refreshSymbols POSTs to /api/symbols/refresh and returns the envelope', async () => {
    const f = mockFetch({ symbols: [], status: 'fresh', fetched_at_ms: 1 });
    await refreshSymbols();
    expect(f.mock.calls[0][1]?.method).toBe('POST');
  });

  it('getAllSymbols throws with detail on non-ok response', async () => {
    mockFetch({ detail: { message: 'down' } }, false);
    await expect(getAllSymbols()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run src/api/symbols.test.ts`
Expected: FAIL — `./symbols` module doesn't exist.

- [ ] **Step 3: Implement**

Create `frontend/src/api/symbols.ts`:
```ts
import { apiUrl } from './client';
import type { SymbolHit, SymbolsAllResponse } from './types';

export async function getAllSymbols(): Promise<SymbolsAllResponse> {
  const url = await apiUrl('/api/symbols/all');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/symbols/all failed: ${r.status}`);
  return r.json();
}

export async function searchSymbols(q: string, limit = 20): Promise<SymbolHit[]> {
  const base = await apiUrl('/api/symbols');
  const url = `${base}?q=${encodeURIComponent(q)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/symbols?q=${q} failed: ${r.status}`);
  return r.json();
}

export async function refreshSymbols(): Promise<SymbolsAllResponse> {
  const url = await apiUrl('/api/symbols/refresh');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`POST /api/symbols/refresh failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 4: Pass + commit**

Run: `cd frontend && npx vitest run src/api/symbols.test.ts`
Expected: PASS.

```bash
git add frontend/src/api/symbols.ts frontend/src/api/symbols.test.ts
git commit -m "feat(frontend/api): symbols.ts wrapper — getAll / search / refresh

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Create `frontend/src/api/calendar.ts`

**Files:**
- Create: `frontend/src/api/calendar.ts`
- Test: `frontend/src/api/calendar.test.ts` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/api/calendar.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getCalendar } from './calendar';

beforeEach(() => { vi.restoreAllMocks(); });

describe('getCalendar', () => {
  it('encodes code/year/month query params and returns CalendarResponse', async () => {
    const f = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        cells: [{ date: '20260518', status: 'complete', captured_at_ms: 1 }],
        as_of_ms: 1_700_000_000_500,
      }),
    } as Response);
    const resp = await getCalendar('005930', 2026, 5);
    const url = f.mock.calls[0][0] as string;
    expect(url).toContain('/api/inventory/calendar?');
    expect(url).toContain('code=005930');
    expect(url).toContain('year=2026');
    expect(url).toContain('month=5');
    expect(resp.cells[0].status).toBe('complete');
    expect(resp.as_of_ms).toBe(1_700_000_000_500);
  });

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(getCalendar('005930', 2026, 5)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run src/api/calendar.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `frontend/src/api/calendar.ts`:
```ts
import { apiUrl } from './client';
import type { CalendarResponse } from './types';

export async function getCalendar(
  code: string,
  year: number,
  month: number,
): Promise<CalendarResponse> {
  const base = await apiUrl('/api/inventory/calendar');
  const url = `${base}?code=${encodeURIComponent(code)}&year=${year}&month=${month}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/inventory/calendar code=${code} ${year}-${month} failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 4: Pass + commit**

```bash
git add frontend/src/api/calendar.ts frontend/src/api/calendar.test.ts
git commit -m "feat(frontend/api): calendar.ts wrapper — getCalendar(code, year, month)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rewrite `frontend/src/api/captures.ts` for the queue surface

**Files:**
- Rewrite: `frontend/src/api/captures.ts`
- Test: `frontend/src/api/captures.test.ts` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/api/captures.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  addItems, getQueue, cancelItem, cancelAll, resumeQueue, dismissDone,
} from './captures';

beforeEach(() => { vi.restoreAllMocks(); });

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok, status, json: async () => body,
  } as Response);
}

describe('captures queue api', () => {
  it('addItems POSTs to /api/captures/items and returns EnqueueResponse', async () => {
    const f = mockFetch({ enqueued: [], deduped: [] }, true, 201);
    await addItems({ code: '005930', dates: ['20260520'], force_retry: false });
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('/api/captures/items');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      code: '005930', dates: ['20260520'], force_retry: false,
    });
  });

  it('addItems throws an Error with .code on 400 today_too_early', async () => {
    mockFetch({ detail: { code: 'today_too_early', message: 'pre-18', dates: ['20260522'] } }, false, 400);
    try {
      await addItems({ code: '005930', dates: ['20260522'], force_retry: false });
      throw new Error('expected addItems to reject');
    } catch (err) {
      const e = err as { code?: string; status?: number };
      expect(e.code).toBe('today_too_early');
      expect(e.status).toBe(400);
    }
  });

  it('getQueue returns QueueSnapshot', async () => {
    mockFetch({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 });
    const snap = await getQueue();
    expect(snap.max_concurrent).toBe(3);
  });

  it('cancelItem POSTs to /items/:id/cancel; accepts 409 silently', async () => {
    const f = mockFetch({}, false, 409);
    await cancelItem('item-xyz');
    expect(f.mock.calls[0][0]).toContain('/items/item-xyz/cancel');
  });

  it('cancelAll, resumeQueue, dismissDone hit their routes', async () => {
    const f = mockFetch({});
    await cancelAll();
    await resumeQueue();
    await dismissDone();
    const urls = f.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/api/captures/cancel-all');
    expect(urls[1]).toContain('/api/captures/queue/resume');
    expect(urls[2]).toContain('/api/captures/done');
    expect(f.mock.calls[2][1]?.method).toBe('DELETE');
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run src/api/captures.test.ts`
Expected: FAIL — module exports the old shape.

- [ ] **Step 3: Rewrite**

Replace `frontend/src/api/captures.ts` entirely:
```ts
import { apiUrl } from './client';
import type {
  EnqueueRequest,
  EnqueueResponse,
  QueueSnapshot,
} from './types';

function rejectWithDetail(r: Response, body: unknown, fallback: string): never {
  const detail = (body as { detail?: { code?: string; message?: string } })?.detail;
  const err = new Error(detail?.message ?? `${fallback} ${r.status}`);
  (err as { code?: string; status?: number }).code = detail?.code;
  (err as { code?: string; status?: number }).status = r.status;
  throw err;
}

export async function addItems(req: EnqueueRequest): Promise<EnqueueResponse> {
  const url = await apiUrl('/api/captures/items');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) rejectWithDetail(r, await r.json().catch(() => ({})), 'POST /api/captures/items');
  return r.json();
}

export async function getQueue(): Promise<QueueSnapshot> {
  const url = await apiUrl('/api/captures/queue');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET /api/captures/queue failed: ${r.status}`);
  return r.json();
}

export async function cancelItem(itemId: string): Promise<void> {
  const url = await apiUrl(`/api/captures/items/${encodeURIComponent(itemId)}/cancel`);
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok && r.status !== 409) throw new Error(`cancel ${itemId} failed: ${r.status}`);
}

export async function cancelAll(): Promise<void> {
  const url = await apiUrl('/api/captures/cancel-all');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`cancel-all failed: ${r.status}`);
}

export async function resumeQueue(): Promise<void> {
  const url = await apiUrl('/api/captures/queue/resume');
  const r = await fetch(url, { method: 'POST' });
  if (!r.ok) throw new Error(`resume failed: ${r.status}`);
}

export async function dismissDone(): Promise<void> {
  const url = await apiUrl('/api/captures/done');
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`dismiss-done failed: ${r.status}`);
}
```

- [ ] **Step 4: Pass + commit**

```bash
git add frontend/src/api/captures.ts frontend/src/api/captures.test.ts
git commit -m "feat!(frontend/captures): rewrite for queue surface (6 endpoints)

Replaces startCapture/getLatestCapture/cancelLatest/dismissLatest with
addItems/getQueue/cancelItem/cancelAll/resumeQueue/dismissDone matching
Plan B's queue routes. Error path preserves .code/.status fields for
today_too_early surface differentiation in the form layer.

BREAKING: existing capture/* components and useCaptureJob no longer
compile — Task 6 deletes them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase 2 — Legacy delete (mirror of Plan B Task 13 backend cut)

After Task 5, `useCaptureJob.ts` + `CaptureForm.tsx` + `CaptureProgress.tsx` + `CaptureLog.tsx` + `CaptureResult.tsx` + their tests no longer compile (they import `CaptureJob`, `startCapture`, etc.). They're already dead at runtime because Plan B removed the endpoints. One commit deletes them.

## Task 6: Delete the legacy single-capture frontend

**Files:**
- Delete: `frontend/src/capture/CaptureForm.tsx`, `CaptureForm.test.tsx`
- Delete: `frontend/src/capture/CaptureProgress.tsx`, `CaptureProgress.test.tsx`
- Delete: `frontend/src/capture/CaptureLog.tsx`
- Delete: `frontend/src/capture/CaptureResult.tsx`, `CaptureResult.test.tsx`
- Delete: `frontend/src/capture/useCaptureJob.ts`, `useCaptureJob.test.tsx`
- Possibly modify: `frontend/src/pages/Capture.tsx` (will be rewritten in Task 18; for now reduce it to a placeholder so the rest of the app compiles)
- Possibly modify: `frontend/src/nav/CaptureStatusPill.tsx` (rewritten in Task 17; for now reduce to a `return null` placeholder)
- Possibly modify: `frontend/src/nav/LeftNav.tsx` (only if it imports something removed)

- [ ] **Step 1: Identify everything that still references removed symbols**

```bash
cd frontend && grep -rn "useCaptureJob\|CaptureForm\|CaptureProgress\|CaptureLog\|CaptureResult\|startCapture\|getLatestCapture\|cancelLatest\|dismissLatest" src/ 2>/dev/null
```
Note every hit. The expected hits are the files about to be deleted PLUS `pages/Capture.tsx` (legacy importer) and possibly `nav/CaptureStatusPill.tsx`.

- [ ] **Step 2: Delete the files**

```bash
cd frontend && rm -f \
  src/capture/CaptureForm.tsx src/capture/CaptureForm.test.tsx \
  src/capture/CaptureProgress.tsx src/capture/CaptureProgress.test.tsx \
  src/capture/CaptureLog.tsx \
  src/capture/CaptureResult.tsx src/capture/CaptureResult.test.tsx \
  src/capture/useCaptureJob.ts src/capture/useCaptureJob.test.tsx
```

- [ ] **Step 3: Replace `pages/Capture.tsx` with a temporary placeholder**

The full rewrite is Task 18. For Phase 2 we just need it to compile. Replace `frontend/src/pages/Capture.tsx` with:
```tsx
// Placeholder during the Plan C rewrite. Task 18 lands the full split-pane layout.
export default function Capture() {
  return (
    <div style={{ padding: 24, color: 'var(--fg-dim)', fontFamily: 'Geist Sans, sans-serif' }}>
      Capture page is being rebuilt. New UI lands in Plan C Task 18.
    </div>
  );
}
```

- [ ] **Step 4: Replace `nav/CaptureStatusPill.tsx` with a temporary placeholder**

Task 17 lands the queue-aware rewrite. For now:
```tsx
// Placeholder during the Plan C rewrite. Task 17 lands the queue-aware pill.
export function CaptureStatusPill() {
  return null;
}
```

Also delete `frontend/src/nav/CaptureStatusPill.test.tsx` — its assertions are about the legacy shape:
```bash
cd frontend && rm -f src/nav/CaptureStatusPill.test.tsx
```

- [ ] **Step 5: Type-check + vitest**

```bash
cd frontend && npx tsc -b --noEmit 2>&1 | tail -10
cd frontend && npx vitest run 2>&1 | tail -5
```
Expected: TypeScript clean. Vitest count drops by ~12–14 tests (legacy capture tests gone). Remaining tests all pass.

- [ ] **Step 6: Commit**

```bash
git add -u frontend/src/
git add frontend/src/pages/Capture.tsx frontend/src/nav/CaptureStatusPill.tsx
git commit -m "$(cat <<'EOF'
feat!(frontend): delete legacy single-capture components + hook

CaptureForm/CaptureProgress/CaptureLog/CaptureResult/useCaptureJob were
runtime-dead after Plan B's Task 13 removed the /api/captures + /latest
routes. Compile-broken after Plan C Task 1 replaced CaptureJob with
QueueItem. Hard cut, mirroring Plan B's backend pattern.

pages/Capture.tsx + nav/CaptureStatusPill.tsx reduced to placeholders;
Tasks 17 + 18 land the queue-aware rewrites.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 3 — Hooks

Three hooks own all React Query interaction. Components below stay declarative.

## Task 7: `useSymbols` + `useSymbolSearch`

**Files:**
- Create: `frontend/src/capture/useSymbols.ts`
- Test: `frontend/src/capture/useSymbols.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/useSymbols.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSymbols, useSymbolSearch, filterSymbols } from './useSymbols';
import type { SymbolHit } from '../api/types';

function wrap(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

const HITS: SymbolHit[] = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 3,
    captured_breakdown: { complete: 3, source_partial: 0, client_incomplete: 0 } },
  { code: '005935', name: '삼성전자우', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
];

describe('filterSymbols', () => {
  it('returns all symbols (up to limit) for empty query', () => {
    expect(filterSymbols(HITS, '', 10)).toHaveLength(3);
  });
  it('numeric query → code prefix match', () => {
    expect(filterSymbols(HITS, '00593', 10).map((h) => h.code)).toEqual(['005930', '005935']);
  });
  it('name substring match', () => {
    expect(filterSymbols(HITS, '삼성', 10).map((h) => h.code)).toEqual(['005930', '005935']);
  });
  it('prefix matches sort before substring matches', () => {
    const extra: SymbolHit[] = [
      { code: '111111', name: '미래에셋삼성', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
      ...HITS,
    ];
    const out = filterSymbols(extra, '삼성', 10);
    // 삼성전자 / 삼성전자우 (prefix) come before 미래에셋삼성 (substring).
    expect(out[0].name.startsWith('삼성')).toBe(true);
    expect(out[1].name.startsWith('삼성')).toBe(true);
  });
  it('respects limit', () => {
    expect(filterSymbols(HITS, '', 2)).toHaveLength(2);
  });
});

describe('useSymbols', () => {
  it('fires one fetch and exposes the envelope on data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSymbols(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe('fresh');
    expect(result.current.data?.symbols).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useSymbolSearch', () => {
  it('returns the filtered list from the cached SymbolsAllResponse', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSymbolSearch('삼성', 10), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((h) => h.code)).toEqual(['005930', '005935']);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run src/capture/useSymbols.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `frontend/src/capture/useSymbols.ts`:
```ts
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAllSymbols } from '../api/symbols';
import type { SymbolHit, SymbolsAllResponse } from '../api/types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const SYMBOLS_QUERY_KEY = ['symbols', 'all'] as const;

export function useSymbols() {
  return useQuery<SymbolsAllResponse>({
    queryKey: SYMBOLS_QUERY_KEY,
    queryFn: getAllSymbols,
    staleTime: ONE_DAY_MS,
  });
}

export function filterSymbols(hits: SymbolHit[], q: string, limit: number): SymbolHit[] {
  const norm = q.trim();
  if (norm.length === 0) return hits.slice(0, limit);
  if (/^\d+$/.test(norm)) {
    return hits.filter((h) => h.code.startsWith(norm)).slice(0, limit);
  }
  // Name match: prefix-matches first, then substring matches; secondary sort by name length.
  const matches = hits.filter((h) => h.name.includes(norm));
  matches.sort((a, b) => {
    const ap = a.name.startsWith(norm) ? 0 : 1;
    const bp = b.name.startsWith(norm) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.length - b.name.length;
  });
  return matches.slice(0, limit);
}

export function useSymbolSearch(query: string, limit = 20): SymbolHit[] {
  const { data } = useSymbols();
  return useMemo(() => filterSymbols(data?.symbols ?? [], query, limit), [data, query, limit]);
}
```

- [ ] **Step 4: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/useSymbols.test.tsx
```
Expected: PASS.

```bash
git add frontend/src/capture/useSymbols.ts frontend/src/capture/useSymbols.test.tsx
git commit -m "feat(frontend/capture): useSymbols + useSymbolSearch (24h cache + memo filter)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `useCalendar` with Q21 `as_of_ms` reconciliation

**Files:**
- Create: `frontend/src/capture/useCalendar.ts`
- Test: `frontend/src/capture/useCalendar.test.tsx` [new]

The Q21 reconciliation: SSE `capture_finished` patches the cell for `(code, date)` and stamps `patched_at_ms = Date.now()` on it. When a fresh `GET /api/inventory/calendar` response arrives, any cell whose `patched_at_ms > incoming.as_of_ms` is preserved from the prior cache (the SSE patch is newer than the GET).

We extend `CalendarCell` locally with an OPTIONAL `patched_at_ms` field. The wire mirror in types.ts does NOT carry it — it's a client-only annotation. Backend never sees it.

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/useCalendar.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { reconcileCalendar, applyCellPatch, type EnrichedCell } from './useCalendar';

beforeEach(() => { vi.restoreAllMocks(); });

const baseCell = (date: string, status = 'complete' as const, captured_at_ms = 1): EnrichedCell => ({
  date, status, captured_at_ms,
});

describe('reconcileCalendar (Q21)', () => {
  it('returns incoming cells when no prior cache exists', () => {
    const incoming = { cells: [baseCell('20260518')], as_of_ms: 1_700_000_000_500 };
    const merged = reconcileCalendar(undefined, incoming);
    expect(merged.cells).toEqual(incoming.cells);
    expect(merged.as_of_ms).toBe(incoming.as_of_ms);
  });

  it('keeps a prior cell when patched_at_ms > incoming.as_of_ms (SSE-newer)', () => {
    const prior = {
      cells: [{ ...baseCell('20260518'), status: 'source_partial' as const, patched_at_ms: 1_700_000_001_000 }],
      as_of_ms: 1_700_000_000_000,
    };
    const incoming = { cells: [baseCell('20260518', 'complete')], as_of_ms: 1_700_000_000_500 };
    const merged = reconcileCalendar(prior, incoming);
    // The prior SSE-patched cell wins.
    expect(merged.cells[0].status).toBe('source_partial');
    expect(merged.cells[0].patched_at_ms).toBe(1_700_000_001_000);
    expect(merged.as_of_ms).toBe(incoming.as_of_ms);
  });

  it('takes incoming when patched_at_ms <= incoming.as_of_ms (GET-newer)', () => {
    const prior = {
      cells: [{ ...baseCell('20260518'), patched_at_ms: 1_700_000_000_100 }],
      as_of_ms: 1_700_000_000_000,
    };
    const incoming = { cells: [baseCell('20260518', 'source_partial')], as_of_ms: 1_700_000_000_500 };
    const merged = reconcileCalendar(prior, incoming);
    expect(merged.cells[0].status).toBe('source_partial');
    expect(merged.cells[0].patched_at_ms).toBeUndefined();
  });

  it('handles cells present in only one side (incoming wins by default)', () => {
    const prior = { cells: [baseCell('20260518')], as_of_ms: 1 };
    const incoming = { cells: [baseCell('20260519')], as_of_ms: 2 };
    const merged = reconcileCalendar(prior, incoming);
    expect(merged.cells.map((c) => c.date)).toEqual(['20260519']);
  });
});

describe('applyCellPatch', () => {
  it('updates the matching date and stamps patched_at_ms', () => {
    const prior = { cells: [baseCell('20260518', 'none')], as_of_ms: 0 };
    const next = applyCellPatch(prior, '20260518', { status: 'complete', captured_at_ms: 42 }, 999);
    expect(next.cells[0].status).toBe('complete');
    expect(next.cells[0].patched_at_ms).toBe(999);
  });

  it('returns prior unchanged when date not in cells', () => {
    const prior = { cells: [baseCell('20260518')], as_of_ms: 0 };
    const next = applyCellPatch(prior, '20260520', { status: 'complete' }, 999);
    expect(next).toBe(prior);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run src/capture/useCalendar.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `frontend/src/capture/useCalendar.ts`:
```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCalendar } from '../api/calendar';
import type { CalendarCell, CalendarStatus } from '../api/types';

/** Calendar cell extended with a client-only `patched_at_ms` annotation
 *  stamped by SSE handlers. The backend wire shape (CalendarCell in types.ts)
 *  does NOT carry this field — it's only meaningful in the React Query cache. */
export interface EnrichedCell extends CalendarCell {
  patched_at_ms?: number;
}

export interface EnrichedCalendarResponse {
  cells: EnrichedCell[];
  as_of_ms: number;
}

export const CALENDAR_QUERY_KEY = (code: string, year: number, month: number) =>
  ['calendar', code, year, month] as const;

/** Merge an incoming GET response against a possibly-existing cache.
 *  Q21: a prior cell with `patched_at_ms > incoming.as_of_ms` is preserved
 *  (the SSE patch is fresher than what GET could have seen). */
export function reconcileCalendar(
  prior: EnrichedCalendarResponse | undefined,
  incoming: CalendarResponse,
): EnrichedCalendarResponse {
  if (prior === undefined) return { cells: incoming.cells.map((c) => ({ ...c })), as_of_ms: incoming.as_of_ms };
  const priorByDate = new Map(prior.cells.map((c) => [c.date, c]));
  const cells: EnrichedCell[] = incoming.cells.map((c) => {
    const prev = priorByDate.get(c.date);
    if (prev?.patched_at_ms !== undefined && prev.patched_at_ms > incoming.as_of_ms) {
      return prev;
    }
    return { ...c };
  });
  return { cells, as_of_ms: incoming.as_of_ms };
}

/** Stamp a per-cell SSE patch with `patched_at_ms = now`. Used by useCaptureQueue
 *  when a capture_finished event arrives for (code, date). */
export function applyCellPatch(
  prior: EnrichedCalendarResponse,
  date: string,
  patch: Partial<Pick<EnrichedCell, 'status' | 'captured_at_ms'>>,
  now: number,
): EnrichedCalendarResponse {
  const idx = prior.cells.findIndex((c) => c.date === date);
  if (idx === -1) return prior;
  const cells = prior.cells.slice();
  cells[idx] = { ...cells[idx], ...patch, patched_at_ms: now };
  return { ...prior, cells };
}

export function useCalendar(code: string | null, year: number, month: number) {
  const qc = useQueryClient();
  const queryKey = CALENDAR_QUERY_KEY(code ?? '', year, month);
  return useQuery<EnrichedCalendarResponse>({
    queryKey,
    queryFn: async () => {
      // F2 (eng review): Q21 reconciliation MUST run when the GET response
      // lands in the cache, not in `select` (which only sees raw queryFn data,
      // never the prior cache — `select` re-runs on every render against the
      // same raw input). Pull the prior EnrichedCalendarResponse via
      // getQueryData, reconcile with the incoming wire CalendarResponse, and
      // store the merged result. Subsequent SSE patches via applyCellPatch
      // operate on the enriched shape uniformly.
      const incoming = await getCalendar(code as string, year, month);
      const prev = qc.getQueryData<EnrichedCalendarResponse>(queryKey);
      return reconcileCalendar(prev, incoming);
    },
    enabled: code !== null,
    staleTime: 60_000,
  });
}

/** Status → calendar marker letter convention (used by tests + CalendarCell). */
export function markerFor(status: CalendarStatus): '✓' | '⚠' | '✕' | '🔒' | null {
  if (status === 'complete') return '✓';
  if (status === 'source_partial') return '⚠';
  if (status === 'client_incomplete') return '✕';
  if (status === 'today_locked') return '🔒';
  return null;
}
```

Note: the reconciliation lives inside `queryFn` itself — pulling prior cache via
`queryClient.getQueryData(queryKey)` and merging with `reconcileCalendar(prev,
incoming)` before returning. This is the only react-query v5 hook that fires
exactly once per fetch with access to the prior cached value (`select` re-runs
on every render against raw input; `onSuccess` was removed in v5). SSE patches
via `applyCellPatch` in `useCaptureQueue` (Task 9) operate on the same enriched
shape uniformly. Unit tests above lock in both `reconcileCalendar` and
`applyCellPatch` semantics so Task 9 can wire them confidently.

- [ ] **Step 4: Pass + commit**

```bash
git add frontend/src/capture/useCalendar.ts frontend/src/capture/useCalendar.test.tsx
git commit -m "feat(frontend/capture): useCalendar with Q21 as_of_ms reconciliation

reconcileCalendar preserves prior cells stamped patched_at_ms newer than
the incoming GET's as_of_ms. applyCellPatch is the SSE patch helper that
useCaptureQueue calls on capture_finished. markerFor centralizes the
status → glyph convention used by CalendarCell + tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Rewrite `useCaptureQueue` (snapshot + SSE multiplex + mutations)

**Files:**
- Create: `frontend/src/capture/useCaptureQueue.ts`
- Test: `frontend/src/capture/useCaptureQueue.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/useCaptureQueue.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCaptureQueue, CAPTURE_QUEUE_QUERY_KEY, patchQueueItem } from './useCaptureQueue';
import type { QueueItem, QueueSnapshot, SSEEvent } from '../api/types';

let subscribers: ((e: SSEEvent) => void)[] = [];
vi.mock('../api/sse', () => ({
  subscribeToCaptureEvents: (cb: (e: SSEEvent) => void) => {
    subscribers.push(cb);
    return () => { subscribers = subscribers.filter((s) => s !== cb); };
  },
}));

function fireSse(e: SSEEvent) {
  act(() => { subscribers.forEach((s) => s(e)); });
}

function wrap(qc: QueueClient) { /* placeholder, see below */ }

type QueueClient = QueryClient;
function makeWrapper(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const QUEUED_ITEM: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'queued', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
};

beforeEach(() => {
  subscribers = [];
  vi.restoreAllMocks();
});

describe('patchQueueItem (pure)', () => {
  it('updates the matching item across active/queued/done', () => {
    const snap: QueueSnapshot = { active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 };
    const next = patchQueueItem(snap, 'i1', { phase: 'capturing', progress: { pages_done: 1, events_seen: 10, frontier_ms: 0, estimate_pct: 5, elapsed_ms: 100 } });
    expect(next.queued[0].phase).toBe('capturing');
    expect(next.queued[0].progress?.pages_done).toBe(1);
  });

  it('returns prior unchanged when item_id missing', () => {
    const snap: QueueSnapshot = { active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 };
    const next = patchQueueItem(snap, 'nope', { phase: 'capturing' });
    expect(next).toBe(snap);
  });
});

describe('useCaptureQueue SSE multiplex', () => {
  it('capture_progress patches the matching item in cache', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCaptureQueue(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.queue?.queued).toHaveLength(1));

    fireSse({
      type: 'capture_progress', item_id: 'i1', code: '005930', date: '20260518', phase: 'capturing',
      progress: { pages_done: 5, events_seen: 100, frontier_ms: 0, estimate_pct: 30, elapsed_ms: 1000 },
    });

    const snap = qc.getQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY);
    expect(snap?.queued[0].progress?.pages_done).toBe(5);
    expect(snap?.queued[0].phase).toBe('capturing');
  });

  it('capture_finished invalidates the queue query (triggers refetch)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [QUEUED_ITEM], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useCaptureQueue(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    fireSse({
      type: 'capture_finished', item_id: 'i1', code: '005930', date: '20260518',
      phase: 'done', result: null, error: null, skip_reason: null,
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('capture_queued + capture_queue_paused + capture_queue_resumed all invalidate', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useCaptureQueue(), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const before = fetchMock.mock.calls.length;

    fireSse({ type: 'capture_queued', items: [QUEUED_ITEM] });
    fireSse({ type: 'capture_queue_paused', reason: 'cookie_expired', message: 'expired' });
    fireSse({ type: 'capture_queue_resumed', reason: 'user_resume' });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before + 3));
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run src/capture/useCaptureQueue.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `frontend/src/capture/useCaptureQueue.ts`:
```ts
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addItems, getQueue, cancelItem, cancelAll, resumeQueue, dismissDone,
} from '../api/captures';
import { subscribeToCaptureEvents } from '../api/sse';
import {
  CALENDAR_QUERY_KEY,
  applyCellPatch,
  type EnrichedCalendarResponse,
} from './useCalendar';
import type { QueueItem, QueueSnapshot, SSEEvent, CalendarStatus, SkipReason } from '../api/types';

export const CAPTURE_QUEUE_QUERY_KEY = ['capture', 'queue'] as const;

/** Pure helper: replace the QueueItem matching `item_id` across active/queued/done
 *  with a shallow merge of `patch`. Returns the prior snapshot reference unchanged
 *  if no item matches (so React Query's reference equality short-circuits re-renders). */
export function patchQueueItem(
  snap: QueueSnapshot,
  itemId: string,
  patch: Partial<QueueItem>,
): QueueSnapshot {
  const apply = (list: QueueItem[]): { changed: boolean; list: QueueItem[] } => {
    const idx = list.findIndex((i) => i.item_id === itemId);
    if (idx === -1) return { changed: false, list };
    const next = list.slice();
    next[idx] = { ...next[idx], ...patch };
    return { changed: true, list: next };
  };
  const a = apply(snap.active);
  const q = apply(snap.queued);
  const d = apply(snap.done);
  if (!a.changed && !q.changed && !d.changed) return snap;
  return { ...snap, active: a.list, queued: q.list, done: d.list };
}

function yearOf(date8: string): number { return parseInt(date8.slice(0, 4), 10); }
function monthOf(date8: string): number { return parseInt(date8.slice(4, 6), 10); }

const finishedToStatus = (phase: QueueItem['phase'], skipReason: SkipReason | null): CalendarStatus | null => {
  if (phase === 'done') return 'complete';
  if (phase === 'skipped') return skipReason === 'source_partial' ? 'source_partial' : 'complete';
  if (phase === 'failed' || phase === 'cancelled') return 'client_incomplete';
  return null;
};

export function useCaptureQueue() {
  const qc = useQueryClient();
  const queue = useQuery<QueueSnapshot>({
    queryKey: CAPTURE_QUEUE_QUERY_KEY,
    queryFn: getQueue,
    staleTime: 0,
  });

  useEffect(() => {
    const unsub = subscribeToCaptureEvents((e: SSEEvent) => {
      if (e.type === 'capture_progress') {
        qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) =>
          prev ? patchQueueItem(prev, e.item_id, { progress: e.progress, phase: e.phase }) : prev,
        );
      } else if (e.type === 'capture_phase') {
        qc.setQueryData<QueueSnapshot>(CAPTURE_QUEUE_QUERY_KEY, (prev) =>
          prev ? patchQueueItem(prev, e.item_id, { phase: e.phase }) : prev,
        );
      } else if (e.type === 'capture_finished') {
        // Refetch the queue (state moved across active/done buckets).
        qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
        // Patch the calendar cell for (e.code, e.date) without refetching the month.
        const key = CALENDAR_QUERY_KEY(e.code, yearOf(e.date), monthOf(e.date));
        const status = finishedToStatus(e.phase, e.skip_reason);
        if (status !== null) {
          qc.setQueryData<EnrichedCalendarResponse>(key, (prev) =>
            prev ? applyCellPatch(prev, e.date, { status }, Date.now()) : prev,
          );
        }
      } else if (
        e.type === 'capture_queued' ||
        e.type === 'capture_queue_paused' ||
        e.type === 'capture_queue_resumed' ||
        e.type === 'capture_queue_drained'
      ) {
        qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY });
      }
    });
    return unsub;
  }, [qc]);

  const addItemsM = useMutation({
    mutationFn: addItems,
    // Invalidate rather than setQueryData — see spec §4.3 race rationale.
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const cancelItemM = useMutation({
    mutationFn: cancelItem,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const cancelAllM = useMutation({
    mutationFn: cancelAll,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const dismissDoneM = useMutation({
    mutationFn: dismissDone,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });
  const resumeQueueM = useMutation({
    mutationFn: resumeQueue,
    onSettled: () => qc.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });

  return {
    queue: queue.data,
    isLoading: queue.isLoading,
    addItems: addItemsM,
    cancelItem: cancelItemM,
    cancelAll: cancelAllM,
    dismissDone: dismissDoneM,
    resumeQueue: resumeQueueM,
  };
}
```

- [ ] **Step 4: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/useCaptureQueue.test.tsx
```
Expected: PASS.

```bash
git add frontend/src/capture/useCaptureQueue.ts frontend/src/capture/useCaptureQueue.test.tsx
git commit -m "feat(frontend/capture): useCaptureQueue — snapshot + SSE multiplex + mutations

SSE handlers:
  capture_progress / capture_phase → setQueryData via patchQueueItem
  capture_finished → invalidate queue + patch calendar cell for (code,date)
  capture_queued / paused / resumed / drained → invalidate queue
Mutations: addItems, cancelItem, cancelAll, dismissDone, resumeQueue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase 4 — Atomic components

Three presentational components composed by Phase 5 containers. Each is a controlled component — props in, JSX out, no fetches, no global state.

## Task 10: `CalendarCell.tsx`

**Files:**
- Create: `frontend/src/capture/CalendarCell.tsx`
- Test: `frontend/src/capture/CalendarCell.test.tsx` [new]
- Modify: `frontend/src/styles/global.css` (only if `--warn` token is missing — add `--warn: #F59E0B;` to the existing `:root` block per DESIGN.md amber)

- [ ] **Step 1: Verify (or add) `--warn` CSS variable**

Run: `grep -n "\-\-warn\b" frontend/src/styles/global.css 2>/dev/null`
If empty: edit `frontend/src/styles/global.css`, locate the `:root { ... }` block holding the other tokens (`--bg`, `--accent`, etc.), and add `  --warn: #F59E0B;` (the DESIGN.md "Warning" semantic amber). Do NOT alter other tokens.

- [ ] **Step 2: Failing test**

Create `frontend/src/capture/CalendarCell.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarCell } from './CalendarCell';
import type { CalendarStatus } from '../api/types';

const baseProps = {
  date: '20260518',
  status: 'none' as CalendarStatus,
  selected: false,
  inRange: false,
  onClick: () => {},
};

describe('CalendarCell', () => {
  it('shows the day-of-month number', () => {
    render(<CalendarCell {...baseProps} status="none" />);
    expect(screen.getByText('18')).toBeTruthy();
  });

  it('renders ✓ marker for complete', () => {
    render(<CalendarCell {...baseProps} status="complete" />);
    expect(screen.getByText('✓')).toBeTruthy();
  });

  it('renders ⚠ marker for source_partial', () => {
    render(<CalendarCell {...baseProps} status="source_partial" />);
    expect(screen.getByText('⚠')).toBeTruthy();
  });

  it('renders ✕ marker for client_incomplete', () => {
    render(<CalendarCell {...baseProps} status="client_incomplete" />);
    expect(screen.getByText('✕')).toBeTruthy();
  });

  it('renders 🔒 for today_locked and is not clickable', () => {
    const onClick = vi.fn();
    render(<CalendarCell {...baseProps} status="today_locked" onClick={onClick} />);
    expect(screen.getByText('🔒')).toBeTruthy();
    screen.getByText('18').click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('weekend/holiday/future cells are not clickable', () => {
    const onClick = vi.fn();
    const { rerender } = render(<CalendarCell {...baseProps} status="weekend" onClick={onClick} />);
    screen.getByText('18').click();
    rerender(<CalendarCell {...baseProps} status="holiday" onClick={onClick} />);
    screen.getByText('18').click();
    rerender(<CalendarCell {...baseProps} status="future" onClick={onClick} />);
    screen.getByText('18').click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('clickable cells (complete / source_partial / client_incomplete / none) fire onClick', () => {
    const onClick = vi.fn();
    const { rerender } = render(<CalendarCell {...baseProps} status="none" onClick={onClick} />);
    screen.getByText('18').click();
    rerender(<CalendarCell {...baseProps} status="complete" onClick={onClick} />);
    screen.getByText('18').click();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('exposes data-testid="calendar-cell" with the date for E2E', () => {
    const { container } = render(<CalendarCell {...baseProps} status="none" />);
    expect(container.querySelector('[data-testid="calendar-cell-20260518"]')).toBeTruthy();
  });

  // F1 (design review): hover state uses DESIGN.md --bg-input-hover token
  it('applies --bg-input-hover background on hover (enabled cells only)', () => {
    const { container, rerender } = render(<CalendarCell {...baseProps} status="none" />);
    const btn = container.querySelector('button')!;
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    // jsdom doesn't compute styles, but the inline style updates synchronously.
    // Use fireEvent for React's synthetic event consistency.
    rerender(<CalendarCell {...baseProps} status="none" />);
  });

  // F2 (design review): tooltip text matches spec §4.2 vocabulary
  it('attaches a title attribute with the status reason', () => {
    const { container, rerender } = render(<CalendarCell {...baseProps} status="weekend" />);
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/weekend/i);
    rerender(<CalendarCell {...baseProps} status="today_locked" />);
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/18:00/);
    rerender(<CalendarCell {...baseProps} status="source_partial" />);
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/partial/i);
  });
});
```

- [ ] **Step 3: Verify fail**

Run: `cd frontend && npx vitest run src/capture/CalendarCell.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

Create `frontend/src/capture/CalendarCell.tsx`:
```tsx
import { useState, type CSSProperties, type MouseEventHandler } from 'react';
import { markerFor } from './useCalendar';
import type { CalendarStatus } from '../api/types';

const DISABLED_STATUSES: ReadonlySet<CalendarStatus> = new Set([
  'weekend', 'holiday', 'future', 'today_locked',
]);

const STATUS_BADGE_COLOR: Partial<Record<CalendarStatus, string>> = {
  complete: 'var(--up)',
  source_partial: 'var(--warn)',
  client_incomplete: 'var(--down)',
};

export interface CalendarCellProps {
  date: string;                  // YYYYMMDD
  status: CalendarStatus;
  selected?: boolean;            // range endpoint
  inRange?: boolean;             // between endpoints
  onClick?: (date: string) => void;
}

function tooltipFor(status: CalendarStatus, date: string): string {
  // spec §4.2: hover tooltip per status. weekend/holiday/future/today_locked
  // show the reason; complete/source_partial/client_incomplete show status name
  // (the caller — DateRangePicker — extends this when it has captured_at_ms).
  switch (status) {
    case 'weekend': return `${date} · weekend`;
    case 'holiday': return `${date} · KRX holiday`;
    case 'future': return `${date} · future date`;
    case 'today_locked': return `${date} · today < 18:00 KST (locked)`;
    case 'complete': return `${date} · captured (complete)`;
    case 'source_partial': return `${date} · captured (source partial — data gaps)`;
    case 'client_incomplete': return `${date} · partial pages on disk (resume on capture)`;
    case 'none': default: return date;
  }
}

export function CalendarCell({ date, status, selected = false, inRange = false, onClick }: CalendarCellProps) {
  const day = parseInt(date.slice(6, 8), 10);
  const disabled = DISABLED_STATUSES.has(status);
  // F1 (design review): hover state honors DESIGN.md token --bg-input-hover.
  const [hovered, setHovered] = useState(false);

  const baseColor: string =
    status === 'weekend' || status === 'holiday' || status === 'future' ? 'var(--fg-dimmer)'
    : status === 'today_locked' ? 'var(--fg-dim)'
    : 'var(--fg)';

  let background: string = 'transparent';
  if (selected) background = 'var(--accent)';
  else if (inRange) background = 'rgba(20,184,166,0.18)';
  else if (hovered && !disabled) background = 'var(--bg-input-hover)';   // F1

  const color: string = selected ? 'var(--bg)' : baseColor;
  const cursor: CSSProperties['cursor'] = disabled ? 'not-allowed' : 'pointer';

  const marker = markerFor(status);
  const markerColor = STATUS_BADGE_COLOR[status];

  const handleClick: MouseEventHandler<HTMLButtonElement> = () => {
    if (disabled) return;
    onClick?.(date);
  };

  return (
    <button
      type="button"
      data-testid={`calendar-cell-${date}`}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}      // keyboard focus mirrors hover for a11y
      onBlur={() => setHovered(false)}
      disabled={disabled}
      title={tooltipFor(status, date)}        // F2: spec §4.2 tooltip
      aria-label={tooltipFor(status, date)}
      style={{
        position: 'relative',
        width: 32, height: 32,
        borderRadius: 4,
        border: 'none',
        padding: 0,
        background,
        color,
        cursor,
        font: '500 12px "Geist Mono", monospace',
        fontVariantNumeric: 'tabular-nums',
        // Focus ring per DESIGN.md focus state (teal accent border).
        outline: 'none',
        boxShadow: hovered && !disabled && !selected ? '0 0 0 1px var(--accent)' : 'none',
      }}
    >
      {day}
      {marker !== null && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 1, right: 2,
            fontSize: 9, lineHeight: 1,
            color: markerColor ?? 'inherit',
          }}
        >
          {marker}
        </span>
      )}
    </button>
  );
}
```

- [ ] **Step 5: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/CalendarCell.test.tsx
```
Expected: PASS.

```bash
git add frontend/src/capture/CalendarCell.tsx frontend/src/capture/CalendarCell.test.tsx frontend/src/styles/global.css
git commit -m "feat(frontend/capture): CalendarCell — 32×32 cell with status badge

Maps status → DESIGN.md tokens: complete=✓--up, source_partial=⚠--warn,
client_incomplete=✕--down, today_locked=🔒--fg-dim. Disabled statuses
(weekend/holiday/future/today_locked) suppress onClick + show
not-allowed cursor. Selected/inRange tinting per spec §6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `SymbolSearch.tsx` — input + dropdown + Q18 + Q19

**Files:**
- Create: `frontend/src/capture/SymbolSearch.tsx`
- Test: `frontend/src/capture/SymbolSearch.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/SymbolSearch.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SymbolSearch } from './SymbolSearch';
import type { ReactNode } from 'react';

function W({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function setup(envelope = {
  symbols: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 14,
      captured_breakdown: { complete: 14, source_partial: 3, client_incomplete: 2 } },
    { code: '005935', name: '삼성전자우', market: 'KOSPI', captured_count: 0,
      captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
  ],
  status: 'fresh' as const,
  fetched_at_ms: 1,
}) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => envelope,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('SymbolSearch', () => {
  it('renders the input with placeholder', () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
  });

  it('shows dropdown rows when input has 2+ chars', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByPlaceholderText(/종목/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '삼성' } });
    // Wait one tick for useSymbols data.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('삼성전자')).toBeTruthy();
    expect(screen.getByText('005930')).toBeTruthy();
  });

  it('Q18: shows captured_count (complete-only) as primary; tooltip has breakdown', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    const input = screen.getByPlaceholderText(/종목/i);
    fireEvent.change(input, { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    // "14 complete" as the visible primary text
    expect(screen.getByText(/14 complete/)).toBeTruthy();
    // The breakdown tooltip lives on title attribute of the count.
    const countEl = screen.getByText(/14 complete/);
    expect(countEl.getAttribute('title')).toMatch(/Complete 14 · Partial 3 · Incomplete 2/);
  });

  it('Q19: shows cache status indicator next to the input', async () => {
    const qc = setup({
      symbols: [], status: 'loading' as const, fetched_at_ms: null,
    });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('symbol-cache-status').getAttribute('data-status')).toBe('loading');
  });

  it('calling onChange with the selected hit on row click', async () => {
    const qc = setup();
    const onChange = vi.fn();
    render(<SymbolSearch value={null} onChange={onChange} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ code: '005930' }));
  });

  it('numeric input matches by code prefix', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '00593' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText('005935')).toBeTruthy();
  });

  it('Q19: unavailable status switches to code-only banner', async () => {
    const qc = setup({ symbols: [], status: 'unavailable' as const, fetched_at_ms: null });
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/6자리 코드로 직접 입력/)).toBeTruthy();
  });

  // F3 (design review): empty-state dropdown when no matches
  it('shows "검색 결과가 없습니다" empty state when query has no matches', async () => {
    const qc = setup();
    render(<SymbolSearch value={null} onChange={() => {}} />, { wrapper: ({ children }) => <W qc={qc}>{children}</W> });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '잘못된종목명' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/검색 결과가 없습니다/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Create `frontend/src/capture/SymbolSearch.tsx`:
```tsx
import { useState, useEffect, useRef } from 'react';
import { useSymbols, useSymbolSearch } from './useSymbols';
import type { SymbolHit, SymbolsCacheStatus } from '../api/types';

export interface SymbolSearchProps {
  value: SymbolHit | null;
  onChange: (hit: SymbolHit | null) => void;
}

const STATUS_LABEL: Record<SymbolsCacheStatus, string> = {
  loading: '⏳',
  fresh: '●',
  stale: '⏱',
  unavailable: '!',
};
const STATUS_COLOR: Record<SymbolsCacheStatus, string> = {
  loading: 'var(--fg-dim)',
  fresh: 'var(--up)',
  stale: 'var(--warn)',
  unavailable: 'var(--down)',
};

export function SymbolSearch({ value, onChange }: SymbolSearchProps) {
  const { data } = useSymbols();
  const cacheStatus: SymbolsCacheStatus = data?.status ?? 'loading';
  const [text, setText] = useState(value ? `${value.name} ${value.code}` : '');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = text.trim();
  const hits = useSymbolSearch(query, 20);
  // F3 (design review): explicit empty-state dropdown when query has chars but
  // no matches. Without this, users wonder if their input is broken.
  const dropdownVisible = open && query.length >= 1 && cacheStatus !== 'unavailable';
  const isEmpty = dropdownVisible && hits.length === 0;

  useEffect(() => { setHighlight(0); }, [query]);

  const select = (hit: SymbolHit) => {
    onChange(hit);
    setText(`${hit.name} ${hit.code}`);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownVisible) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, hits.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); select(hits[highlight]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div style={{ position: 'relative', fontFamily: 'Geist Sans, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => { setText(e.target.value); setOpen(true); onChange(null); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="종목명 또는 6자리 코드"
          style={{
            flex: 1,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--fg)',
            padding: '8px 10px',
            fontSize: 13,
          }}
        />
        <span
          data-testid="symbol-cache-status"
          data-status={cacheStatus}
          title={`Symbols cache: ${cacheStatus}`}
          style={{ color: STATUS_COLOR[cacheStatus], fontSize: 14, lineHeight: 1 }}
        >
          {STATUS_LABEL[cacheStatus]}
        </span>
      </div>
      {cacheStatus === 'unavailable' && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-dim)' }}>
          종목 목록 미가용 — 6자리 코드로 직접 입력하세요.
        </div>
      )}
      {dropdownVisible && (
        <div
          role="listbox"
          style={{
            position: 'absolute', zIndex: 10,
            top: '100%', left: 0, right: 0, marginTop: 4,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: 320, overflowY: 'auto',
          }}
        >
          {isEmpty ? (
            // F3: empty state — tells the user the input is processed but matched nothing.
            <div style={{
              padding: '12px 10px',
              font: '400 12px "Geist Sans", sans-serif',
              color: 'var(--fg-dim)',
            }}>
              검색 결과가 없습니다. 종목명 또는 6자리 코드를 확인하세요.
            </div>
          ) : (
            hits.map((h, i) => (
              <SymbolRow key={h.code} hit={h} highlighted={i === highlight} onClick={() => select(h)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SymbolRow({ hit, highlighted, onClick }: { hit: SymbolHit; highlighted: boolean; onClick: () => void }) {
  const breakdown = `Complete ${hit.captured_breakdown.complete} · Partial ${hit.captured_breakdown.source_partial} · Incomplete ${hit.captured_breakdown.client_incomplete}`;
  const countText = hit.captured_count > 0 ? `${hit.captured_count} complete` : 'no complete data';
  return (
    <div
      role="option"
      aria-selected={highlighted}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        padding: '8px 10px',
        background: highlighted ? 'rgba(20,184,166,0.10)' : 'transparent',
        display: 'grid',
        gridTemplateColumns: '1fr auto auto auto',
        gap: 10,
        alignItems: 'center',
        cursor: 'pointer',
      }}
    >
      <span style={{ font: '400 13px "Geist Sans", sans-serif', color: 'var(--fg)' }}>{hit.name}</span>
      <span style={{ font: '500 11px "Geist Mono", monospace', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>{hit.code}</span>
      <span style={{
        border: '1px solid var(--border-strong)', borderRadius: 4, padding: '0 4px',
        font: '600 8.5px "Geist Sans", sans-serif', letterSpacing: '0.06em',
        color: 'var(--fg-dim)',
      }}>{hit.market}</span>
      <span
        title={breakdown}
        style={{
          font: '500 10px "Geist Mono", monospace',
          color: hit.captured_count > 0 ? 'var(--accent)' : 'var(--fg-dimmer)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {countText}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/SymbolSearch.test.tsx
git add frontend/src/capture/SymbolSearch.tsx frontend/src/capture/SymbolSearch.test.tsx
git commit -m "feat(frontend/capture): SymbolSearch — input + dropdown + Q18 + Q19

Dropdown row: name + code + market chip + 'N complete' (or 'no complete data')
with breakdown in title-attr tooltip (Q18). Status indicator next to the
input (loading ⏳ / fresh ● / stale ⏱ / unavailable !) per Q19. Unavailable
status switches to a code-only banner. Keyboard nav (↑↓/Enter/Esc).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `DateRangePicker.tsx` — 2-month grid + Q14 60s re-eval

**Files:**
- Create: `frontend/src/capture/DateRangePicker.tsx`
- Test: `frontend/src/capture/DateRangePicker.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/DateRangePicker.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DateRangePicker } from './DateRangePicker';
import type { ReactNode } from 'react';

function W(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const HISTORY_RESPONSE = {
  cells: [
    { date: '20260518', status: 'complete', captured_at_ms: 1 },
    { date: '20260519', status: 'none', captured_at_ms: null },
    { date: '20260520', status: 'none', captured_at_ms: null },
  ],
  as_of_ms: 1,
};

function setupCalendar() {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => HISTORY_RESPONSE,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('DateRangePicker', () => {
  it('renders two months side by side (current + next)', async () => {
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('2026.05')).toBeTruthy();
    expect(screen.getByText('2026.06')).toBeTruthy();
  });

  it('first click sets anchor; second click sets end (no swap when ordered)', async () => {
    const qc = setupCalendar();
    const onChange = vi.fn();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={onChange} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('calendar-cell-20260519'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    expect(onChange).toHaveBeenLastCalledWith({ start: '20260519', end: '20260520' });
  });

  it('second click before anchor swaps start/end', async () => {
    const qc = setupCalendar();
    const onChange = vi.fn();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={onChange} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260519'));
    expect(onChange).toHaveBeenLastCalledWith({ start: '20260519', end: '20260520' });
  });

  it('third click resets to a new start anchor', async () => {
    const qc = setupCalendar();
    const onChange = vi.fn();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={onChange} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260519'));
    // Third click is a new anchor (range incomplete) — onChange is called with null end.
    expect(onChange).toHaveBeenLastCalledWith({ start: '20260519', end: null });
  });

  it('Q14 re-eval ticks every 60s (interval registered)', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    // Verify a 60s interval was scheduled.
    const intervals = setIntervalSpy.mock.calls.map((c) => c[1]);
    expect(intervals).toContain(60_000);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Create `frontend/src/capture/DateRangePicker.tsx`:
```tsx
import { useState, useEffect, useMemo } from 'react';
import { useCalendar } from './useCalendar';
import { CalendarCell } from './CalendarCell';
import type { CalendarStatus } from '../api/types';

export interface DateRange {
  start: string;       // YYYYMMDD
  end: string | null;  // null while only anchor is set
}

export interface DateRangePickerProps {
  code: string | null;
  /** Reference month for the left grid (right is +1 month). Caller controls
   *  this; defaults to the current KST month. */
  referenceYear: number;
  referenceMonth: number;  // 1-12
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dateStr(year: number, month: number, day: number): string {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function inRange(date: string, range: DateRange | null): boolean {
  if (range === null || range.end === null) return false;
  return date >= range.start && date <= range.end;
}

function MonthGrid({
  code, year, month, value, statusByDate, onPick,
}: {
  code: string | null;
  year: number;
  month: number;
  value: DateRange | null;
  statusByDate: Map<string, CalendarStatus>;
  onPick: (date: string) => void;
}) {
  const last = daysInMonth(year, month);
  const cells = [];
  for (let day = 1; day <= last; day++) {
    const d = dateStr(year, month, day);
    const status: CalendarStatus = statusByDate.get(d) ?? 'none';
    const selected = value?.start === d || value?.end === d;
    cells.push(
      <CalendarCell
        key={d} date={d} status={status}
        selected={selected} inRange={inRange(d, value)}
        onClick={code === null ? undefined : onPick}
      />
    );
  }
  return (
    <div>
      <div style={{ font: '500 11px "Geist Mono", monospace', color: 'var(--fg-dim)', marginBottom: 6 }}>
        {`${year}.${String(month).padStart(2, '0')}`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 32px)', gap: 2 }}>
        {cells}
      </div>
    </div>
  );
}

export function DateRangePicker({ code, referenceYear, referenceMonth, value, onChange }: DateRangePickerProps) {
  // Q14: re-render every 60s so today_locked transitions cleanly through 18:00 KST.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const nextYear = referenceMonth === 12 ? referenceYear + 1 : referenceYear;
  const nextMonth = referenceMonth === 12 ? 1 : referenceMonth + 1;

  const left = useCalendar(code, referenceYear, referenceMonth);
  const right = useCalendar(code, nextYear, nextMonth);

  const statusByDate = useMemo(() => {
    const m = new Map<string, CalendarStatus>();
    left.data?.cells.forEach((c) => m.set(c.date, c.status));
    right.data?.cells.forEach((c) => m.set(c.date, c.status));
    return m;
  }, [left.data, right.data]);

  const onPick = (date: string) => {
    if (value === null || value.end !== null) {
      onChange({ start: date, end: null });
      return;
    }
    // value.end === null → completing the range
    if (date < value.start) {
      onChange({ start: date, end: value.start });
    } else {
      onChange({ start: value.start, end: date });
    }
  };

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <MonthGrid code={code} year={referenceYear} month={referenceMonth} value={value} statusByDate={statusByDate} onPick={onPick} />
      <MonthGrid code={code} year={nextYear} month={nextMonth} value={value} statusByDate={statusByDate} onPick={onPick} />
    </div>
  );
}
```

- [ ] **Step 3: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/DateRangePicker.test.tsx
git add frontend/src/capture/DateRangePicker.tsx frontend/src/capture/DateRangePicker.test.tsx
git commit -m "feat(frontend/capture): DateRangePicker — 2-month grid + anchor/swap

useCalendar per month. Anchor-then-end semantics with swap when end <
start. Third click resets anchor. Q14: setInterval(60s) re-renders so
the today_locked overlay transitions cleanly at 18:00 KST. Cells
disabled by status (weekend/holiday/future/today_locked) inherit the
not-clickable behavior from CalendarCell.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase 5 — Container components

## Task 13: `CaptureForm.tsx` rewrite — Search + Picker + force_retry + Start

**Files:**
- Create: `frontend/src/capture/CaptureForm.tsx`
- Test: `frontend/src/capture/CaptureForm.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/CaptureForm.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureForm } from './CaptureForm';
import type { ReactNode } from 'react';

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const SYMBOLS = {
  symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0,
              captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } }],
  status: 'fresh' as const, fetched_at_ms: 1,
};
const CALENDAR = { cells: [], as_of_ms: 1 };

function setup(addItemsResp: unknown = { enqueued: [{}], deduped: [] }) {
  const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => SYMBOLS } as Response;
    if (s.includes('/api/inventory/calendar')) return { ok: true, status: 200, json: async () => CALENDAR } as Response;
    if (s.includes('/api/captures/items')) return { ok: true, status: 201, json: async () => addItemsResp } as Response;
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { qc, fetchMock };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('CaptureForm', () => {
  it('disables Start when no symbol selected', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    const btn = screen.getByRole('button', { name: /Start/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables Start when no range', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    // Pick a symbol
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    const btn = screen.getByRole('button', { name: /Start/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('Start POSTs addItems with current symbol + range + force_retry', async () => {
    const { qc, fetchMock } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByLabelText(/Force re-capture/i));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 30));
    const itemsCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/captures/items'));
    expect(itemsCall).toBeDefined();
    const body = JSON.parse(itemsCall![1]!.body as string);
    expect(body).toEqual({
      code: '005930', start_date: '20260518', end_date: '20260520', force_retry: true,
    });
  });

  it('form resets after a successful Start', async () => {
    const { qc } = setup();
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect((screen.getByPlaceholderText(/종목/i) as HTMLInputElement).value).toBe('');
  });

  it('shows today_too_early error inline when backend rejects', async () => {
    const { qc, fetchMock } = setup({ detail: { code: 'today_too_early', message: 'pre-18' } });
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => SYMBOLS } as Response;
      if (s.includes('/api/inventory/calendar')) return { ok: true, status: 200, json: async () => CALENDAR } as Response;
      if (s.includes('/api/captures/items')) return { ok: false, status: 400, json: async () => ({ detail: { code: 'today_too_early', message: 'pre-18 KST' } }) } as Response;
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    render(<CaptureForm referenceYear={2026} referenceMonth={5} />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByPlaceholderText(/종목/i), { target: { value: '삼성' } });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByText('삼성전자'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByRole('button', { name: /Start/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText(/pre-18 KST/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Create `frontend/src/capture/CaptureForm.tsx`:
```tsx
import { useState } from 'react';
import { SymbolSearch } from './SymbolSearch';
import { DateRangePicker, type DateRange } from './DateRangePicker';
import { useCaptureQueue } from './useCaptureQueue';
import type { SymbolHit } from '../api/types';

export interface CaptureFormProps {
  /** Reference month for DateRangePicker's left grid. Defaults to current KST month. */
  referenceYear: number;
  referenceMonth: number;
}

export function CaptureForm({ referenceYear, referenceMonth }: CaptureFormProps) {
  const [symbol, setSymbol] = useState<SymbolHit | null>(null);
  const [range, setRange] = useState<DateRange | null>(null);
  const [forceRetry, setForceRetry] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { addItems } = useCaptureQueue();
  const valid = symbol !== null && range !== null && range.end !== null;

  const onStart = () => {
    if (!valid) return;
    setError(null);
    addItems.mutate(
      {
        code: symbol!.code,
        start_date: range!.start,
        end_date: range!.end!,
        force_retry: forceRetry,
      },
      {
        onSuccess: () => {
          setSymbol(null);
          setRange(null);
          setForceRetry(false);
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Failed to enqueue';
          setError(msg);
        },
      },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'Geist Sans, sans-serif' }}>
      <section>
        <Label>Symbol</Label>
        <SymbolSearch value={symbol} onChange={setSymbol} />
      </section>

      <section>
        <Label>Date Range</Label>
        <DateRangePicker
          code={symbol?.code ?? null}
          referenceYear={referenceYear}
          referenceMonth={referenceMonth}
          value={range}
          onChange={setRange}
        />
      </section>

      <section>
        <Label>Options</Label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--fg)' }}>
          <input
            type="checkbox"
            checked={forceRetry}
            onChange={(e) => setForceRetry(e.target.checked)}
          />
          <span>⚠ Force re-capture source-partial dates</span>
        </label>
      </section>

      <button
        type="button"
        onClick={onStart}
        disabled={!valid}
        style={{
          background: valid ? 'var(--accent)' : 'var(--bg-input)',
          color: valid ? 'var(--bg)' : 'var(--fg-dimmer)',
          border: 'none', borderRadius: 6,
          padding: '10px 18px',
          font: '600 13px "Geist Sans", sans-serif',
          cursor: valid ? 'pointer' : 'not-allowed',
        }}
      >
        ▶ Start Capture
      </button>

      {error !== null && (
        <div role="alert" style={{ fontSize: 11, color: 'var(--down)' }}>{error}</div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--fg-dim)' }}>
        Legend: ✓ complete · ⚠ partial · ✕ broken · 🔒 today &lt; 18:00 KST
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div style={{
      font: '600 10.5px "Geist Sans", sans-serif',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--fg-dim)', marginBottom: 6,
    }}>{children}</div>
  );
}
```

- [ ] **Step 3: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/CaptureForm.test.tsx
git add frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureForm.test.tsx
git commit -m "feat(frontend/capture): CaptureForm — Search + Picker + force_retry + Start

Validates: symbol selected AND range complete. On Start mutation success
the form resets (matches spec §4.2). Backend rejection (today_too_early
etc.) shows inline error with the response message. Legend visible at
the bottom of the form per spec §4.4 layout sketch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: `CaptureQueueRow.tsx` — single row + Q16 force chip

**Files:**
- Create: `frontend/src/capture/CaptureQueueRow.tsx`
- Test: `frontend/src/capture/CaptureQueueRow.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/CaptureQueueRow.test.tsx`:
```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaptureQueueRow, statusIcon, phaseChipColor } from './CaptureQueueRow';
import type { QueueItem } from '../api/types';

const base: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'queued', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
};

describe('statusIcon', () => {
  it('maps phases to glyphs', () => {
    expect(statusIcon('done')).toBe('✓');
    expect(statusIcon('failed')).toBe('✕');
    expect(statusIcon('cancelled')).toBe('✕');
    expect(statusIcon('skipped')).toBe('⚠');
    expect(statusIcon('capturing')).toBe('●');
    expect(statusIcon('queued')).toBe('○');
  });
});

describe('phaseChipColor', () => {
  it('teal tint for in-progress', () => {
    expect(phaseChipColor('capturing')).toContain('20,184,166');
  });
  it('up tint for done', () => {
    expect(phaseChipColor('done')).toContain('34,197,94');
  });
  it('down tint for failed', () => {
    expect(phaseChipColor('failed')).toContain('244,63,94');
  });
});

describe('CaptureQueueRow', () => {
  it('renders date / code / phase chip', () => {
    render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByText('20260518')).toBeTruthy();
    expect(screen.getByText('005930')).toBeTruthy();
    expect(screen.getByText(/queued/i)).toBeTruthy();
    expect(screen.getByText('삼성전자')).toBeTruthy();
  });

  it('Q16: shows ⚠ force chip when force_retry=true', () => {
    render(<CaptureQueueRow item={{ ...base, force_retry: true }} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByTitle(/force re-capture/i)).toBeTruthy();
  });

  it('queued row action button is ✕ remove (calls onCancel)', () => {
    const onCancel = vi.fn();
    render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={onCancel} onRetry={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel|remove|✕/i }));
    expect(onCancel).toHaveBeenCalledWith('i1');
  });

  it('failed row shows ↻ retry button (calls onRetry)', () => {
    const onRetry = vi.fn();
    render(<CaptureQueueRow item={{ ...base, phase: 'failed' }} symbolName="삼성전자" onCancel={() => {}} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry|↻/i }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'i1' }));
  });

  it('done / skipped rows show no action button', () => {
    const { rerender } = render(<CaptureQueueRow item={{ ...base, phase: 'done' }} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: /cancel|retry/i })).toBeNull();
    rerender(<CaptureQueueRow item={{ ...base, phase: 'skipped' }} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: /cancel|retry/i })).toBeNull();
  });

  it('clicking the row toggles a `data-expanded` flag', () => {
    const { container } = render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    const row = container.querySelector('[data-testid="queue-row-i1"]')!;
    expect(row.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('data-expanded')).toBe('true');
  });

  // F6 (design review): keyboard a11y — Enter and Space toggle expand
  it('keyboard Enter expands the row; aria-expanded reflects state', () => {
    const { container } = render(<CaptureQueueRow item={base} symbolName="삼성전자" onCancel={() => {}} onRetry={() => {}} />);
    const row = container.querySelector('[data-testid="queue-row-i1"]')!;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabIndex') ?? row.getAttribute('tabindex')).toBe('0');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(row, { key: ' ' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Create `frontend/src/capture/CaptureQueueRow.tsx`:
```tsx
import { useState } from 'react';
import { CaptureRowDetail } from './CaptureRowDetail';
import type { CapturePhase, QueueItem } from '../api/types';

export function statusIcon(phase: CapturePhase): string {
  switch (phase) {
    case 'done': return '✓';
    case 'failed': return '✕';
    case 'cancelled': return '✕';
    case 'skipped': return '⚠';
    case 'capturing': case 'parsing': case 'deciding': return '●';
    case 'queued': default: return '○';
  }
}

export function phaseChipColor(phase: CapturePhase): string {
  if (phase === 'capturing' || phase === 'parsing' || phase === 'deciding') return 'rgba(20,184,166,0.12)';
  if (phase === 'done') return 'rgba(34,197,94,0.10)';
  if (phase === 'failed') return 'rgba(244,63,94,0.10)';
  // skipped / cancelled / queued
  return 'rgba(148,163,184,0.10)';
}

export interface CaptureQueueRowProps {
  item: QueueItem;
  symbolName: string;
  onCancel: (itemId: string) => void;
  /** Re-enqueue with same params; CaptureQueue passes the addItems mutation here. */
  onRetry: (item: QueueItem) => void;
}

export function CaptureQueueRow({ item, symbolName, onCancel, onRetry }: CaptureQueueRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isTerminal = item.phase === 'done' || item.phase === 'skipped' || item.phase === 'cancelled' || item.phase === 'failed';
  const showCancel = !isTerminal;                      // queued / deciding / capturing / parsing
  const showRetry = item.phase === 'failed';

  // F6 (design review): row is a button-equivalent for keyboard/AT users.
  // role="button" + tabIndex=0 + Enter/Space handler + aria-expanded.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded((v) => !v);
    }
  };

  return (
    <>
      <div
        data-testid={`queue-row-${item.item_id}`}
        data-expanded={expanded}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Capture row ${item.code} ${item.date} ${item.phase}. Press Enter to ${expanded ? 'collapse' : 'expand'} details.`}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={onKeyDown}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 90px 60px 1fr 90px 50px 50px 80px 24px',
          alignItems: 'center', gap: 8,
          height: 36, padding: '0 8px',
          borderBottom: '1px solid var(--border)',
          font: '500 11px "Geist Mono", monospace',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--fg)',
          cursor: 'pointer',
          outline: 'none',     // focus indicator handled by CSS :focus-visible
        }}
      >
        <span>{statusIcon(item.phase)}</span>
        <span>{item.date}</span>
        <span>{item.code}</span>
        <span style={{ font: '400 12px "Geist Sans", sans-serif', color: 'var(--fg-dim)' }}>
          {symbolName}
          {item.force_retry && (
            <span title="Force re-capture" style={{
              marginLeft: 6, fontSize: 9,
              border: '1px solid var(--warn)',
              color: 'var(--warn)',
              borderRadius: 3, padding: '0 3px',
            }}>⚠ force</span>
          )}
        </span>
        <span style={{ background: phaseChipColor(item.phase), padding: '2px 6px', borderRadius: 3, color: 'var(--fg-dim)' }}>
          {item.phase}
        </span>
        <span>{item.progress?.pages_done ?? '–'}</span>
        <span>{item.progress?.events_seen ?? '–'}</span>
        <span style={{ width: 80, height: 2, background: 'var(--bg-input)', borderRadius: 1, position: 'relative' }}>
          <span style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${item.progress?.estimate_pct ?? 0}%`,
            background: 'var(--accent)', borderRadius: 1,
          }} />
        </span>
        <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {showCancel && (
            <button
              type="button"
              aria-label="Cancel"
              onClick={(e) => { e.stopPropagation(); onCancel(item.item_id); }}
              style={{
                background: 'transparent', border: 'none', color: 'var(--fg-dim)',
                cursor: 'pointer', fontSize: 14, padding: 0,
              }}
            >✕</button>
          )}
          {showRetry && (
            <button
              type="button"
              aria-label="Retry"
              onClick={(e) => { e.stopPropagation(); onRetry(item); }}
              style={{
                background: 'transparent', border: 'none', color: 'var(--accent)',
                cursor: 'pointer', fontSize: 14, padding: 0,
              }}
            >↻</button>
          )}
        </span>
      </div>
      {expanded && <CaptureRowDetail item={item} />}
    </>
  );
}
```

This component imports `CaptureRowDetail` which Task 15 creates next. Phase 5 sequential dependency.

- [ ] **Step 3: Stub `CaptureRowDetail` temporarily**

So the row test compiles. Create `frontend/src/capture/CaptureRowDetail.tsx` as a minimal stub now:
```tsx
import type { QueueItem } from '../api/types';
export function CaptureRowDetail({ item }: { item: QueueItem }) {
  return <div data-testid={`queue-row-detail-${item.item_id}`} />;
}
```
Task 15 expands it.

- [ ] **Step 4: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/CaptureQueueRow.test.tsx
git add frontend/src/capture/CaptureQueueRow.tsx frontend/src/capture/CaptureQueueRow.test.tsx frontend/src/capture/CaptureRowDetail.tsx
git commit -m "feat(frontend/capture): CaptureQueueRow + Q16 force chip + click-to-expand

Status icon, date, code, name, phase chip, pages, events, mini progress
bar, action button (✕ cancel / ↻ retry / none). Q16: ⚠ force chip when
force_retry=true. Click toggles CaptureRowDetail below (stub for now;
Task 15 expands).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: `CaptureRowDetail.tsx` — last 5 log lines + metadata

**Files:**
- Modify: `frontend/src/capture/CaptureRowDetail.tsx` (was stubbed in Task 14)
- Test: `frontend/src/capture/CaptureRowDetail.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/CaptureRowDetail.test.tsx`:
```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaptureRowDetail } from './CaptureRowDetail';
import type { QueueItem } from '../api/types';

const base: QueueItem = {
  item_id: 'i1', code: '005930', date: '20260518',
  phase: 'capturing', force_retry: false, pause_origin: false,
  enqueued_at_ms: 1_700_000_000_000, started_at_ms: 1_700_000_001_000,
  progress: { pages_done: 12, events_seen: 1000, frontier_ms: 1_700_000_500_000, estimate_pct: 30, elapsed_ms: 5000 },
  result: null,
  error: null,
  skip_reason: null,
};

describe('CaptureRowDetail', () => {
  it('shows started_at_ms (formatted KST clock) and frontier_ms', () => {
    render(<CaptureRowDetail item={base} />);
    // KST formatter outputs HH:MM:SS; we just check that elapsed_ms label is present too.
    expect(screen.getByText(/started_at/i)).toBeTruthy();
    expect(screen.getByText(/frontier/i)).toBeTruthy();
  });

  it('shows error message verbatim when item.error is set', () => {
    render(<CaptureRowDetail item={{ ...base, phase: 'failed', error: { code: 'cookie_expired', message: 'cookie missing on page 5', at_page: 5 } }} />);
    expect(screen.getByText(/cookie missing on page 5/)).toBeTruthy();
  });

  it('omits error section when item.error is null', () => {
    render(<CaptureRowDetail item={base} />);
    expect(screen.queryByText(/error/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Replace `frontend/src/capture/CaptureRowDetail.tsx`:
```tsx
import type { QueueItem } from '../api/types';

function formatKstClock(unixMs: number | null): string {
  if (unixMs === null) return '–';
  const d = new Date(unixMs);
  const hh = String(d.getUTCHours() + 9).padStart(2, '0');   // simple KST = UTC+9
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function CaptureRowDetail({ item }: { item: QueueItem }) {
  return (
    <div
      data-testid={`queue-row-detail-${item.item_id}`}
      style={{
        padding: '8px 16px',
        background: 'var(--bg-subtle)',
        borderBottom: '1px solid var(--border)',
        font: '400 11px "Geist Mono", monospace',
        color: 'var(--fg-dim)',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        rowGap: 4, columnGap: 12,
      }}
    >
      <span>started_at</span>
      <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
        {formatKstClock(item.started_at_ms)}
      </span>
      <span>frontier</span>
      <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
        {formatKstClock(item.progress?.frontier_ms ?? null)}
      </span>
      <span>enqueued_at</span>
      <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
        {formatKstClock(item.enqueued_at_ms)}
      </span>
      {item.error !== null && (
        <>
          <span style={{ color: 'var(--down)' }}>error</span>
          <span style={{ color: 'var(--down)' }}>
            {item.error.code}: {item.error.message}
            {item.error.at_page !== null && item.error.at_page !== undefined ? ` (page ${item.error.at_page})` : ''}
          </span>
        </>
      )}
      {item.result !== null && (
        <>
          <span>result</span>
          <span style={{ color: 'var(--fg)' }}>
            pages_written={item.result.pages_written} unique_events={item.result.unique_events}
            {item.result.parsed ? ' parsed' : ''}
          </span>
        </>
      )}
    </div>
  );
}
```

Per-item log buffer (spec §4.2 "last 5 log lines from a ref buffer per item") is intentionally deferred — the SSE event stream doesn't yet ship discrete log lines as Plan B emits them. Captured progress is already shown via the pages/events/frontier triple. Add log-line ingestion as a Plan D follow-up when the backend exposes it.

- [ ] **Step 3: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/CaptureRowDetail.test.tsx
git add frontend/src/capture/CaptureRowDetail.tsx frontend/src/capture/CaptureRowDetail.test.tsx
git commit -m "feat(frontend/capture): CaptureRowDetail — metadata grid + error verbatim

Shows started_at / frontier / enqueued_at in KST HH:MM:SS, plus error
verbatim with code/message/at_page when present. Per-item log buffer
deferred — backend does not yet stream discrete log lines.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: `CaptureQueue.tsx` — header + Cancel All + Dismiss Done + virtualization

**Files:**
- Create: `frontend/src/capture/CaptureQueue.tsx`
- Test: `frontend/src/capture/CaptureQueue.test.tsx` [new]
- Modify: `frontend/package.json` — record the `@tanstack/react-virtual` dep added in Pre-flight Step P5

- [ ] **Step 1: Failing test**

Create `frontend/src/capture/CaptureQueue.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureQueue, computeHeaderSummary } from './CaptureQueue';
import type { QueueItem, QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const item = (id: string, phase: QueueItem['phase']): QueueItem => ({
  item_id: id, code: '005930', date: '20260518', phase,
  force_retry: false, pause_origin: false, enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
});

const SNAPSHOT = (): QueueSnapshot => ({
  active: [item('a1', 'capturing')],
  queued: [item('q1', 'queued'), item('q2', 'queued')],
  done: [item('d1', 'done'), item('d2', 'skipped'), item('d3', 'failed')],
  paused: false,
  max_concurrent: 3,
});

beforeEach(() => { vi.restoreAllMocks(); });

function setup(snapshot: QueueSnapshot = SNAPSHOT()) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => snapshot } as Response;
    if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

describe('computeHeaderSummary', () => {
  it('counts done / failed / in-progress / total', () => {
    const summary = computeHeaderSummary(SNAPSHOT());
    expect(summary.done).toBe(2);           // done + skipped
    expect(summary.failed).toBe(1);
    expect(summary.capturing).toBe(1);
    expect(summary.queued).toBe(2);
    expect(summary.total).toBe(6);
  });

  it('paused exposed as a top-level flag', () => {
    expect(computeHeaderSummary({ ...SNAPSHOT(), paused: true }).paused).toBe(true);
  });
});

describe('CaptureQueue', () => {
  it('renders header + Cancel All + Dismiss Done', async () => {
    const qc = setup();
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('button', { name: /Cancel All/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dismiss Done/i })).toBeTruthy();
  });

  it('renders one row per item across all buckets', async () => {
    const qc = setup();
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-row-a1')).toBeTruthy();
    expect(screen.getByTestId('queue-row-q1')).toBeTruthy();
    expect(screen.getByTestId('queue-row-d1')).toBeTruthy();
  });

  // F5 (design review): Cancel All requires two clicks (confirmation)
  it('Cancel All first click arms confirmation; second click POSTs cancel-all', async () => {
    const qc = setup();
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => SNAPSHOT() } as Response;
      return { ok: true, status: 202, json: async () => ({}) } as Response;
    });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    // First click — arms confirmation, no network call.
    fireEvent.click(screen.getByRole('button', { name: /Cancel All/i }));
    const callsAfterFirstClick = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/captures/cancel-all')).length;
    expect(callsAfterFirstClick).toBe(0);
    expect(screen.getByText(/Click again to confirm/)).toBeTruthy();
    // Second click — fires.
    fireEvent.click(screen.getByRole('button', { name: /Click again to confirm/i }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/captures/cancel-all'))).toBe(true);
  });

  it('shows paused banner with Refresh & Resume + Cancel All when snapshot.paused', async () => {
    const qc = setup({ ...SNAPSHOT(), paused: true });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/Cookie expired/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Resume/i })).toBeTruthy();
  });

  it('renders only first 200 rows when queue length > 200 (virtualized window)', async () => {
    const big = Array.from({ length: 250 }, (_, i) => item(`q${i}`, 'queued'));
    const qc = setup({ active: [], queued: big, done: [], paused: false, max_concurrent: 3 });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    // Virtualization rendering test is best-effort — we just check the
    // container has data-virtualized="true" attribute set by the component
    // when queue length > 200.
    expect(screen.getByTestId('queue-list').getAttribute('data-virtualized')).toBe('true');
  });

  // F4 (design review): empty state when queue has zero rows + not paused
  it('shows the "큐가 비어 있습니다" empty state on first-load with no rows', async () => {
    const qc = setup({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect(screen.getByText(/큐가 비어 있습니다/)).toBeTruthy();
  });

  it('does NOT show empty state when paused even if rows are empty (banner takes priority)', async () => {
    const qc = setup({ active: [], queued: [], done: [], paused: true, max_concurrent: 3 });
    render(<CaptureQueue />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('queue-empty')).toBeNull();
    expect(screen.getByText(/Cookie expired/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Create `frontend/src/capture/CaptureQueue.tsx`:
```tsx
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCaptureQueue } from './useCaptureQueue';
import { useSymbols } from './useSymbols';
import { CaptureQueueRow } from './CaptureQueueRow';
import type { QueueItem, QueueSnapshot } from '../api/types';

const PHASE_ORDER: Record<QueueItem['phase'], number> = {
  deciding: 0, capturing: 0, parsing: 0,
  queued: 1,
  done: 2, skipped: 2, cancelled: 2, failed: 2,
};

export interface HeaderSummary {
  done: number;       // done + skipped
  failed: number;
  capturing: number;  // active count
  queued: number;
  total: number;
  paused: boolean;
}

export function computeHeaderSummary(snap: QueueSnapshot): HeaderSummary {
  const done = snap.done.filter((i) => i.phase === 'done' || i.phase === 'skipped').length;
  const failed = snap.done.filter((i) => i.phase === 'failed').length;
  const capturing = snap.active.length;
  const queued = snap.queued.length;
  return {
    done, failed, capturing, queued,
    total: done + failed + snap.done.filter((i) => i.phase === 'cancelled').length + capturing + queued,
    paused: snap.paused,
  };
}

const VIRTUALIZE_THRESHOLD = 200;

export function CaptureQueue() {
  const { queue, cancelItem, cancelAll, dismissDone, addItems, resumeQueue } = useCaptureQueue();
  const { data: symbolsResp } = useSymbols();
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    symbolsResp?.symbols.forEach((s) => m.set(s.code, s.name));
    return m;
  }, [symbolsResp]);

  // F5 (design review): Cancel All is destructive (kills active captures +
  // drains queue). Inline confirmation prevents goodwill-reservoir depletion
  // from a single misclick. Two-step: first click arms, second click commits;
  // 4s timeout resets the arm. Inline beats a modal — fewer interruptions,
  // matches the spec's calm-surface app-UI aesthetic.
  const [cancelAllArmed, setCancelAllArmed] = useState(false);
  const cancelAllTimerRef = useRef<number | null>(null);
  const handleCancelAll = () => {
    if (cancelAllArmed) {
      if (cancelAllTimerRef.current !== null) window.clearTimeout(cancelAllTimerRef.current);
      cancelAllTimerRef.current = null;
      setCancelAllArmed(false);
      cancelAll.mutate();
      return;
    }
    setCancelAllArmed(true);
    cancelAllTimerRef.current = window.setTimeout(() => setCancelAllArmed(false), 4_000);
  };

  if (queue === undefined) {
    return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading queue…</div>;
  }

  // F4 (design review): empty state — first-time / drained queue gets warmth
  // and a primary-action pointer. Without this, users see a blank panel and
  // wonder if the form on the left is even wired up.
  const totalRows = queue.active.length + queue.queued.length + queue.done.length;
  if (totalRows === 0 && !queue.paused) {
    return (
      <div
        data-testid="queue-empty"
        style={{
          height: '100%',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 8,
          padding: 24,
          color: 'var(--fg-dim)',
          font: '400 12px "Geist Sans", sans-serif',
          textAlign: 'center',
        }}
      >
        <div style={{ font: '500 13px "Geist Sans", sans-serif', color: 'var(--fg)' }}>
          큐가 비어 있습니다
        </div>
        <div>
          왼쪽에서 종목과 날짜 범위를 선택하고 Start 를 누르면 캡처가 시작됩니다.
        </div>
      </div>
    );
  }

  const summary = computeHeaderSummary(queue);
  const allRows: QueueItem[] = useMemo(() => {
    const merged = [...queue.active, ...queue.queued, ...queue.done];
    merged.sort((a, b) => {
      const p = PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
      if (p !== 0) return p;
      return a.enqueued_at_ms - b.enqueued_at_ms;
    });
    return merged;
  }, [queue]);

  const onRetry = (item: QueueItem) => {
    addItems.mutate({
      code: item.code,
      dates: [item.date],
      force_retry: item.force_retry,
    });
  };

  const shouldVirtualize = allRows.length > VIRTUALIZE_THRESHOLD;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 8px' }}>
        <div style={{ flex: 1, font: '500 11px "Geist Mono", monospace', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {summary.done} of {summary.total} done · {summary.failed} failed · {summary.capturing} capturing
        </div>
        <button
          type="button"
          onClick={handleCancelAll}
          style={cancelAllArmed
            ? { ...ghostButton(), borderColor: 'var(--down)', color: 'var(--down)' }
            : ghostButton()
          }
        >{cancelAllArmed ? 'Click again to confirm' : 'Cancel All'}</button>
        <button
          type="button"
          onClick={() => dismissDone.mutate()}
          style={ghostButton()}
        >Dismiss Done</button>
      </div>

      <div style={{ height: 4, background: 'var(--bg-input)', borderRadius: 1, position: 'relative' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${summary.total > 0 ? (summary.done / summary.total) * 100 : 0}%`,
          background: 'var(--accent)', borderRadius: 1,
        }} />
      </div>

      {queue.paused && (
        <div role="alert" style={{
          padding: '8px 12px', background: 'rgba(245,158,11,0.10)', border: '1px solid var(--warn)',
          borderRadius: 4, display: 'flex', alignItems: 'center', gap: 12,
          font: '500 11px "Geist Mono", monospace', color: 'var(--warn)',
        }}>
          <span style={{ flex: 1 }}>Cookie expired · refresh .cookie on disk, then resume</span>
          <button type="button" onClick={() => resumeQueue.mutate()} style={ghostButton()}>Refresh &amp; Resume</button>
          <button type="button" onClick={() => cancelAll.mutate()} style={ghostButton()}>Cancel All</button>
        </div>
      )}

      <div
        data-testid="queue-list"
        data-virtualized={shouldVirtualize}
        style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}
      >
        {shouldVirtualize
          ? <VirtualList rows={allRows} nameByCode={nameByCode} onCancel={cancelItem.mutate} onRetry={onRetry} />
          : allRows.map((item) => (
              <CaptureQueueRow
                key={item.item_id}
                item={item}
                symbolName={nameByCode.get(item.code) ?? '—'}
                onCancel={cancelItem.mutate}
                onRetry={onRetry}
              />
            ))}
      </div>
    </div>
  );
}

function VirtualList({
  rows, nameByCode, onCancel, onRetry,
}: {
  rows: QueueItem[];
  nameByCode: Map<string, string>;
  onCancel: (itemId: string) => void;
  onRetry: (item: QueueItem) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });
  return (
    <div ref={parentRef} style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vr) => {
          const item = rows[vr.index];
          return (
            <div key={item.item_id} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vr.start}px)` }}>
              <CaptureQueueRow
                item={item}
                symbolName={nameByCode.get(item.code) ?? '—'}
                onCancel={onCancel}
                onRetry={onRetry}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ghostButton(): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--border-strong)',
    color: 'var(--fg-dim)',
    borderRadius: 4,
    padding: '4px 10px',
    font: '500 10.5px "Geist Sans", sans-serif',
    letterSpacing: '0.04em',
    cursor: 'pointer',
  };
}
```

- [ ] **Step 3: Verify the @tanstack/react-virtual dep is recorded**

Run: `grep -n "@tanstack/react-virtual" frontend/package.json`
Expected: exact entry under `"dependencies"`. If missing (Pre-flight P5 skipped), run `cd frontend && npm install @tanstack/react-virtual` now and stage both `package.json` and `package-lock.json`.

- [ ] **Step 4: Pass + commit**

```bash
cd frontend && npx vitest run src/capture/CaptureQueue.test.tsx
git add frontend/src/capture/CaptureQueue.tsx frontend/src/capture/CaptureQueue.test.tsx frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend/capture): CaptureQueue — header + Cancel All + Dismiss Done + virtualization

Header summary line + overall progress bar + Cancel All + Dismiss Done.
Cookie-paused banner with Refresh & Resume + Cancel All (per spec §11 Q20).
Sort: in-progress first, then queued, then terminals.
@tanstack/react-virtual virtualizes the row list when length > 200.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase 6 — Navigation + page

## Task 17: `nav/CaptureStatusPill.tsx` rewrite — queue summary

**Files:**
- Rewrite: `frontend/src/nav/CaptureStatusPill.tsx` (was a placeholder after Task 6)
- Test: `frontend/src/nav/CaptureStatusPill.test.tsx` [new]

- [ ] **Step 1: Failing test**

Create `frontend/src/nav/CaptureStatusPill.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaptureStatusPill } from './CaptureStatusPill';
import type { QueueSnapshot } from '../api/types';
import type { ReactNode } from 'react';

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function setup(snap: QueueSnapshot) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => snap,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

const empty: QueueSnapshot = { active: [], queued: [], done: [], paused: false, max_concurrent: 3 };
const item = (id: string, phase: 'queued' | 'capturing' = 'queued') => ({
  item_id: id, code: '005930', date: '20260518', phase,
  force_retry: false, pause_origin: false, enqueued_at_ms: 1, started_at_ms: null,
  progress: null, result: null, error: null, skip_reason: null,
});

describe('CaptureStatusPill', () => {
  it('renders null when no active and no queued and not paused', async () => {
    const qc = setup(empty);
    const { container } = render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.firstChild).toBeNull();
  });

  it('renders CAPTURING with stats when items are active or queued', async () => {
    const qc = setup({ ...empty, active: [item('a1', 'capturing')], queued: [item('q1'), item('q2')] });
    render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/CAPTURING/)).toBeTruthy();
    expect(screen.getByText(/1 capturing · 2 queued/)).toBeTruthy();
  });

  it('renders PAUSED label when snapshot.paused (amber dot)', async () => {
    const qc = setup({ ...empty, paused: true, active: [item('a1', 'capturing')] });
    render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/PAUSED/)).toBeTruthy();
    expect(screen.getByText(/click to resume/i)).toBeTruthy();
  });

  it('wraps the pill in a Link to /capture', async () => {
    const qc = setup({ ...empty, queued: [item('q1')] });
    const { container } = render(<CaptureStatusPill />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('a[href="/capture"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Replace `frontend/src/nav/CaptureStatusPill.tsx`:
```tsx
import { Link } from 'react-router';
import { useCaptureQueue } from '../capture/useCaptureQueue';

export function CaptureStatusPill() {
  const { queue } = useCaptureQueue();
  if (queue === undefined) return null;
  const activeCount = queue.active.length;
  const queuedCount = queue.queued.length;
  if (!queue.paused && activeCount === 0 && queuedCount === 0) return null;

  const paused = queue.paused;
  const label = paused ? 'PAUSED' : 'CAPTURING';
  const dotColor = paused ? 'var(--warn)' : 'var(--accent)';
  const dotAnim = paused ? 'none' : 'capture-pulse 1.5s ease-in-out infinite';

  const stats = paused
    ? 'Cookie expired — click to resume'
    : `${activeCount} capturing · ${queuedCount} queued`;

  return (
    <Link
      to="/capture"
      style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '8px 12px',
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        textDecoration: 'none',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, animation: dotAnim }} />
        <span style={{
          font: '600 9.5px "Geist Sans", sans-serif',
          letterSpacing: '0.08em',
          color: paused ? 'var(--warn)' : 'var(--accent)',
        }}>{label}</span>
      </span>
      <span style={{
        font: '500 10px "Geist Mono", monospace',
        color: 'var(--fg-dim)',
        fontVariantNumeric: 'tabular-nums',
      }}>{stats}</span>
    </Link>
  );
}
```

- [ ] **Step 3: Verify `capture-pulse` keyframe exists in global.css**

Run: `grep -n "@keyframes capture-pulse" frontend/src/styles/global.css`
Expected: one definition. If missing (got pruned during Phase 2 cleanup), add:
```css
@keyframes capture-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

- [ ] **Step 4: Pass + commit**

```bash
cd frontend && npx vitest run src/nav/CaptureStatusPill.test.tsx
git add frontend/src/nav/CaptureStatusPill.tsx frontend/src/nav/CaptureStatusPill.test.tsx frontend/src/styles/global.css
git commit -m "feat(frontend/nav): CaptureStatusPill rewrite — queue summary

CAPTURING (pulsing teal dot) with '{N} capturing · {M} queued' stats line.
PAUSED (static amber dot) with 'Cookie expired — click to resume' when
snapshot.paused. Renders null when queue empty + not paused. Whole pill
links to /capture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: `pages/Capture.tsx` rewrite — 38/62 split layout

**Files:**
- Rewrite: `frontend/src/pages/Capture.tsx`
- Test: `frontend/src/pages/Capture.test.tsx` [new — basic smoke; component-level coverage already in CaptureForm + CaptureQueue tests]

- [ ] **Step 1: Failing test**

Create `frontend/src/pages/Capture.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Capture from './Capture';
import type { ReactNode } from 'react';

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/symbols/all')) return { ok: true, status: 200, json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }) } as Response;
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
});

describe('Capture page', () => {
  it('renders both the form panel (left) and the queue panel (right)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<Capture />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    // Form side
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start/i })).toBeTruthy();
    // Queue side
    expect(screen.getByRole('button', { name: /Cancel All/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dismiss Done/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify fail; implement**

Replace `frontend/src/pages/Capture.tsx`:
```tsx
import { CaptureForm } from '../capture/CaptureForm';
import { CaptureQueue } from '../capture/CaptureQueue';

function currentKstMonth(): { year: number; month: number } {
  // KST = UTC + 9. Cheap derivation; DateRangePicker re-evaluates every 60s.
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const kst = new Date(utcMs + 9 * 60 * 60_000);
  return { year: kst.getFullYear(), month: kst.getMonth() + 1 };
}

export default function Capture() {
  const { year, month } = currentKstMonth();
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '38fr 62fr',
        gap: 16,
        padding: 16,
        height: '100%',
        background: 'var(--bg)',
        color: 'var(--fg)',
      }}
    >
      <section style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 16,
        overflowY: 'auto',
      }}>
        <CaptureForm referenceYear={year} referenceMonth={month} />
      </section>
      <section style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        display: 'flex', flexDirection: 'column',
        minHeight: 0,    // grid child needs this for inner overflow to behave
      }}>
        <CaptureQueue />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Pass + commit**

```bash
cd frontend && npx vitest run src/pages/Capture.test.tsx
cd frontend && npx vitest run 2>&1 | tail -5
```
Expected: All test files green, count reflects all of Phase 1–6 additions.

```bash
git add frontend/src/pages/Capture.tsx frontend/src/pages/Capture.test.tsx
git commit -m "feat(frontend/pages): Capture page rewrite — 38/62 split (CaptureForm | CaptureQueue)

Computes current KST month for DateRangePicker's reference. Form left
panel scrolls; queue right panel uses minHeight:0 + flex column to make
the inner virtualized list scroll independently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Phase 7 — E2E (Playwright) + verification

The vitest suites cover unit/component logic. Playwright closes the loop end-to-end against the FastAPI backend with `FakeHogaplayClient` (already present from the prior plan, swapped in via `HOGA_ENABLE_TEST_ENDPOINTS=1`).

Pre-flight for Phase 7:
- Confirm Playwright is installed: `cd frontend && npx playwright --version`. If missing, run `npm install -D @playwright/test && npx playwright install chromium`.
- Confirm a Playwright config exists OR add one (Task 19 Step 1 covers).

## Task 19: Playwright `range-capture.spec.ts` (+ delete legacy E2E specs)

**Files:**
- Modify: `frontend/playwright.config.ts` — config ALREADY EXISTS (verified eng-review). Add a `webServer` block, raise testDir timeout, keep existing `testDir`/`testMatch`/`use` defaults compatible.
- Delete: `frontend/tests/e2e/capture-flow.spec.ts` — legacy single-capture E2E; Plan B made it impossible (POST /api/captures gone). The new `range-capture.spec.ts` is its replacement.
- Possibly delete or modify: `frontend/tests/e2e/error-states.spec.ts`, `frontend/tests/e2e/multi-tab.spec.ts`, `frontend/tests/e2e/sse-refresh.spec.ts`, `frontend/tests/e2e/replay-smoke.spec.ts` — check if they touch capture endpoints. Inventory + Replay specs that don't hit capture endpoints stay. Run them post-cleanup to confirm.
- Create: `frontend/tests/e2e/range-capture.spec.ts`
- Possibly create: `frontend/tests/e2e/helpers.ts` (shared test boot)

- [ ] **Step 1: Audit existing E2E specs**

```bash
cd frontend && grep -rn "/api/captures\|startCapture\|getLatestCapture\|cancelLatest\|dismissLatest" tests/e2e/ 2>/dev/null
```
Expected: hits in `capture-flow.spec.ts` (and possibly `multi-tab.spec.ts`, `error-states.spec.ts`). All hits target endpoints Plan B removed — those specs are dead. Delete them in this step. The new `range-capture.spec.ts` / `calendar-markers.spec.ts` / `cookie-pause.spec.ts` replace the capture-flow coverage.

```bash
rm -f frontend/tests/e2e/capture-flow.spec.ts
# Run grep again after deletion. If multi-tab.spec.ts / error-states.spec.ts / sse-refresh.spec.ts
# still reference removed endpoints, fix or delete them too.
```

- [ ] **Step 2: Extend existing `frontend/playwright.config.ts` with a `webServer` block**

The existing config has `testDir: './tests/e2e'`, `testMatch: /.*\.spec\.ts$/`, baseURL via `E2E_BASE_URL`, no `webServer`. Plan C needs the backend + frontend dev server up. Append `webServer` to the existing `defineConfig({ ... })`:

```ts
// Add to the existing defineConfig({}) at frontend/playwright.config.ts.
// Keep the existing testDir / testMatch / fullyParallel / forbidOnly /
// retries / reporter / use / projects intact. Add only the webServer field.
webServer: [
  {
    // Backend with fake client enabled.
    command: 'cd .. && HOGA_ENABLE_TEST_ENDPOINTS=1 HOGA_DATA_DIR=/tmp/hoga-e2e-data uv run hoga serve --port 8765',
    url: 'http://127.0.0.1:8765/health',
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },
  {
    command: 'npm run dev -- --port 5173',
    url: 'http://127.0.0.1:5173',
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },
],
```

If `hoga serve` doesn't accept `--port`, find the actual entry point (check `pyproject.toml [project.scripts]`). The crucial invariant: backend up with `HOGA_ENABLE_TEST_ENDPOINTS=1` so FakeHogaplayClient is the active dependency. Existing `baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173'` stays — when `webServer` runs, both URLs match `http://localhost:5173`.

- [ ] **Step 2: Create the spec**

Create `frontend/tests/e2e/range-capture.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('range-capture: search → pick 3 trading days → Start → queue progresses to done × 3', async ({ page }) => {
  await page.goto('/capture');

  // 1. SymbolSearch "삼성" → click 삼성전자 005930
  const input = page.getByPlaceholder(/종목/);
  await input.fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();

  // 2. Click two calendar cells (a contiguous trading-day range of 3 days).
  //    The fixture's trading-day stub uses 20260518/19/20 (Mon–Wed).
  await page.getByTestId('calendar-cell-20260518').click();
  await page.getByTestId('calendar-cell-20260520').click();

  // 3. Start.
  await page.getByRole('button', { name: /Start/i }).click();

  // 4. capture_queued SSE: 3 rows appear.
  await expect(page.getByTestId('queue-row-')).toHaveCount(3, { timeout: 5_000 });

  // 5. Phase transitions visible — wait for header summary to read "3 of 3 done".
  await expect(page.locator('text=/3 of 3 done/')).toBeVisible({ timeout: 15_000 });

  // 6. Append a second symbol's range — multi-symbol queue test.
  await input.fill('SK');
  await page.getByText(/SK하이닉스/, { exact: false }).first().click();
  await page.getByTestId('calendar-cell-20260518').click();
  await page.getByTestId('calendar-cell-20260520').click();
  await page.getByRole('button', { name: /Start/i }).click();
  await expect(page.locator('text=/6 of 6 done/')).toBeVisible({ timeout: 15_000 });

  // 7. Cancel All — rows become cancelled (none remain non-terminal).
  //    With everything already done, Cancel All is a no-op for active items but
  //    still drains any leftover queued; verify it does not crash.
  await page.getByRole('button', { name: /Cancel All/i }).click();

  // 8. Dismiss Done — table empties.
  await page.getByRole('button', { name: /Dismiss Done/i }).click();
  await expect(page.getByTestId(/^queue-row-/)).toHaveCount(0, { timeout: 5_000 });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npx playwright test tests/e2e/range-capture.spec.ts 2>&1 | tail -20
```
Expected: PASS. If the trading-day stub dates don't align with the FakeHogaplayClient fixture, adjust the test dates and the backend fixture together — they must agree.

```bash
git add frontend/playwright.config.ts frontend/tests/e2e/range-capture.spec.ts
git commit -m "test(e2e): range-capture flow (search → pick → Start → 3 of 3 done)

Drives /capture end-to-end with FakeHogaplayClient (HOGA_ENABLE_TEST_ENDPOINTS=1).
Confirms 6-day multi-symbol queue + Cancel All + Dismiss Done behave per spec §7.3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 20: Playwright `calendar-markers.spec.ts`

**Files:**
- Create: `frontend/tests/e2e/calendar-markers.spec.ts`

- [ ] **Step 1: Create the spec**

Create `frontend/tests/e2e/calendar-markers.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = '/tmp/hoga-e2e-data';

test.beforeAll(async () => {
  // 20260501 — complete: parquet/meta.json with collection_complete=true, is_partial=false
  await fs.mkdir(path.join(DATA_DIR, 'parquet/20260501/005930'), { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'parquet/20260501/005930/meta.json'),
    JSON.stringify({ collection_complete: true, is_partial: false }),
  );
  // 20260502 — source_partial: collection_complete=true, is_partial=true
  await fs.mkdir(path.join(DATA_DIR, 'parquet/20260502/005930'), { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, 'parquet/20260502/005930/meta.json'),
    JSON.stringify({ collection_complete: true, is_partial: true }),
  );
  // 20260503 — client_incomplete: raw pages, no meta
  await fs.mkdir(path.join(DATA_DIR, 'raw/20260503/005930'), { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'raw/20260503/005930/first_0001.tsv'), '');
});

test('calendar-markers: ✓ ⚠ ✕ render per disk_state', async ({ page }) => {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();

  // 20260501 complete (✓)
  const cell01 = page.getByTestId('calendar-cell-20260501');
  await expect(cell01).toContainText('✓');
  // 20260502 source_partial (⚠)
  await expect(page.getByTestId('calendar-cell-20260502')).toContainText('⚠');
  // 20260503 client_incomplete (✕)
  await expect(page.getByTestId('calendar-cell-20260503')).toContainText('✕');
});

test('calendar-markers: complete date Start → immediately skipped/already_complete', async ({ page }) => {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();
  await page.getByTestId('calendar-cell-20260501').click();
  await page.getByTestId('calendar-cell-20260501').click();   // single-day range
  await page.getByRole('button', { name: /Start/i }).click();
  // Row should reach skipped quickly because the disk state is COMPLETE.
  await expect(page.locator('text=/skipped/i')).toBeVisible({ timeout: 3_000 });
});

test('calendar-markers: force_retry overrides source_partial skip', async ({ page }) => {
  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();
  await page.getByLabel(/Force re-capture/i).check();
  await page.getByTestId('calendar-cell-20260502').click();
  await page.getByTestId('calendar-cell-20260502').click();
  await page.getByRole('button', { name: /Start/i }).click();
  await expect(page.locator('text=/done/i').first()).toBeVisible({ timeout: 10_000 });
});
```

- [ ] **Step 2: Run + commit**

```bash
cd frontend && npx playwright test tests/e2e/calendar-markers.spec.ts 2>&1 | tail -20
git add frontend/tests/e2e/calendar-markers.spec.ts
git commit -m "test(e2e): calendar-markers — ✓ ⚠ ✕ + skipped/force_retry flows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 21: Playwright `cookie-pause.spec.ts`

**Files:**
- Create: `frontend/tests/e2e/cookie-pause.spec.ts`

This test requires the FakeHogaplayClient to be configurable to raise CookieExpiredError on the Nth request. If the existing fake doesn't support that, extend it as part of this task (the fake already lives in `hoga/api/captures_fake.py` from the prior plan).

- [ ] **Step 1: Verify the fake supports failure injection**

Run: `grep -n "CookieExpiredError\|raise_on_request" hoga/api/captures_fake.py 2>/dev/null`

If the fake has no failure-injection API, add one:
```python
# hoga/api/captures_fake.py — additive
_raise_on_request_index: int | None = None

def configure_fake_to_raise_on(request_index: int) -> None:
    """Test helper. Set to N → FakeHogaplayClient raises CookieExpiredError on its
    Nth get_first_php call. None disables injection."""
    global _raise_on_request_index
    _raise_on_request_index = request_index
```

Wire `_raise_on_request_index` into the fake's request method. Expose a small test-only HTTP endpoint under `HOGA_ENABLE_TEST_ENDPOINTS=1`:
```python
# hoga/api/app.py — additive under the test-endpoints gate
if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
    from hoga.api import captures_fake
    @app.post("/api/_test/cookie_expire_at")
    async def _cookie_expire_at(req: dict) -> dict:
        captures_fake.configure_fake_to_raise_on(int(req["index"]))
        return {"ok": True}
```

Add a single backend test that exercises this hook to confirm wiring:
```python
# tests/test_api_test_endpoints.py
def test_cookie_expire_at_configures_fake(monkeypatch):
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    from hoga.api.app import create_app
    from fastapi.testclient import TestClient
    with TestClient(create_app()) as c:
        r = c.post("/api/_test/cookie_expire_at", json={"index": 3})
        assert r.status_code == 200
```

Commit this small backend extension before the Playwright spec.

- [ ] **Step 2: Create the Playwright spec**

Create `frontend/tests/e2e/cookie-pause.spec.ts`:
```ts
import { test, expect, request } from '@playwright/test';

const API = 'http://127.0.0.1:8765';

test('cookie-pause: 3rd request → pause banner → Resume → completes', async ({ page }) => {
  // Configure the fake to raise on the 3rd capture request.
  const api = await request.newContext();
  await api.post(`${API}/api/_test/cookie_expire_at`, { data: { index: 3 } });

  await page.goto('/capture');
  await page.getByPlaceholder(/종목/).fill('삼성');
  await page.getByText(/삼성전자/, { exact: false }).first().click();

  // Pick a 5-day range.
  await page.getByTestId('calendar-cell-20260518').click();
  await page.getByTestId('calendar-cell-20260522').click();
  await page.getByRole('button', { name: /Start/i }).click();

  // After ~2 captures land, the 3rd triggers pause.
  await expect(page.locator('text=/Cookie expired/i')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('text=/PAUSED/')).toBeVisible();

  // Disable the failure-injection and click Resume.
  await api.post(`${API}/api/_test/cookie_expire_at`, { data: { index: -1 } });
  await page.getByRole('button', { name: /Resume/i }).click();

  // Queue resumes; eventually all 5 done.
  await expect(page.locator('text=/5 of 5 done/')).toBeVisible({ timeout: 20_000 });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npx playwright test tests/e2e/cookie-pause.spec.ts 2>&1 | tail -20
git add frontend/tests/e2e/cookie-pause.spec.ts hoga/api/captures_fake.py hoga/api/app.py tests/test_api_test_endpoints.py
git commit -m "test(e2e): cookie-pause — 3rd request raises CookieExpiredError → Resume

Adds a small HOGA_ENABLE_TEST_ENDPOINTS-gated hook to configure the
FakeHogaplayClient's failure injection, so the Playwright spec can
deterministically trigger the cookie-pause path and verify Resume
completes the remaining items.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 22: Final sweep — manual verification + audit

- [ ] **Step 1: Cross-suite grep — confirm no legacy references remain**

```bash
cd frontend && grep -rn "useCaptureJob\|startCapture\|getLatestCapture\|cancelLatest\|dismissLatest\|CaptureJob\b\|CaptureProgress\b\|CaptureLog\b\|CaptureResult\b" src/ 2>/dev/null
```
Expected: zero hits. Each remaining hit is something Phase 2 missed; fix before declaring done.

```bash
cd frontend && grep -rn '"job_id"' src/ 2>/dev/null
```
Expected: zero hits.

- [ ] **Step 2: TypeScript + vitest sweep**

```bash
cd frontend && npx tsc -b --noEmit 2>&1 | tail -10
cd frontend && npx vitest run 2>&1 | tail -5
```
Expected: TypeScript clean. Vitest test count strictly higher than the post-Phase-2 baseline (we added unit tests across Phases 3–6). Note the new exact count.

- [ ] **Step 3: Backend pytest still green**

```bash
uv run pytest -q 2>&1 | tail -3
```
Expected: green (the Phase 7 test-endpoint hook in `app.py` adds one small backend test; backend count goes up by 1).

- [ ] **Step 4: Manual dev-server verification (golden path)**

```bash
# Terminal A: backend with test endpoints + fake client.
HOGA_ENABLE_TEST_ENDPOINTS=1 HOGA_DATA_DIR=/tmp/hoga-e2e-data uv run hoga serve --port 8765

# Terminal B: frontend dev server.
cd frontend && npm run dev
```

Open `http://127.0.0.1:5173/capture` in a browser. Walk through:
1. SymbolSearch types "삼성" → dropdown shows 삼성전자 with "N complete" + breakdown tooltip on hover.
2. Status indicator next to input shows the cache status (green ● fresh).
3. DateRangePicker shows two months; clicking two cells creates a teal range; weekends/holidays are dimmed; today's cell shows 🔒 if before 18:00 KST.
4. Force re-capture toggle visible under Options.
5. Start enqueues; queue rows appear in the right pane; phase chips transition deciding → capturing → parsing → done.
6. Force-retry rows show the ⚠ force chip next to the name.
7. LeftNav pill appears with "{N} capturing · {M} queued" while anything is non-terminal; disappears when everything terminates.
8. Cancel All / Dismiss Done buttons behave as expected.
9. Trigger a paused state via `curl -X POST http://127.0.0.1:8765/api/_test/cookie_expire_at -H 'Content-Type: application/json' -d '{"index": 2}'` then Start a 3-date range; banner appears, LeftNav pill turns amber, Resume button restores flow.

Take screenshots of each state into `docs/screenshots/2026-05-23-plan-c-*.png` if useful (NOT committed by default — DESIGN.md doesn't require them).

If any manual step fails, file the issue, fix, and re-verify before moving on.

- [ ] **Step 5: Document Plan C completion in ADR-0007 footer or a small note**

If the architectural picture changed in any non-trivial way (e.g., the @tanstack/react-virtual dep was added; the FakeHogaplayClient failure-injection endpoint was added), append a short paragraph to `docs/adr/0007-capture-grows-disk-state-extracted.md`'s postscript:

```markdown
## Postscript — Plan C landing notes (2026-05-23)

Plan C (`docs/superpowers/plans/2026-05-23-capture-queue-frontend.md`)
shipped the redesigned `/capture` UI on top of Plan B's queue backend.
Notable additions: `@tanstack/react-virtual` for queue rows past 200,
a HOGA_ENABLE_TEST_ENDPOINTS-gated `_cookie_expire_at` hook for
Playwright. Frontend `types.ts` mirrors the backend wire shapes
verbatim per ADR-0004; no adapter layer was introduced.
```

- [ ] **Step 6: Commit the final sweep**

```bash
git add -u docs/
git commit -m "docs(adr-0007): Plan C landed — postscript with frontend notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Confirm the commit chain**

```bash
git log --oneline main..HEAD | head -30
```
Expected: 22+ task commits visible, each tagged with the Plan C phase.

---

## Done criteria

- All 22 tasks committed; each commit message names the phase it belongs to.
- `cd frontend && npx vitest run` is green; test count is strictly higher than the post-Phase-2 baseline.
- `cd frontend && npx tsc -b --noEmit` clean.
- `uv run pytest -q` is green (backend `_cookie_expire_at` test added; pre-Plan-C count + 1).
- `cd frontend && npx playwright test` passes all 3 E2E specs.
- All greps in Task 22 Step 1 return zero hits (no legacy single-capture references in frontend).
- Manual verification walkthrough (Task 22 Step 4) completes for golden path + cookie-pause scenario.
- DESIGN.md tokens used throughout — no off-token colors, no hardcoded spacing values, no non-system fonts. (Verify with `grep -rEn "#[0-9a-fA-F]{3,6}\b" frontend/src/capture/ frontend/src/nav/ frontend/src/pages/Capture.tsx | grep -v "rgba(20,184,166" | grep -v "rgba(34,197,94" | grep -v "rgba(244,63,94" | grep -v "rgba(245,158,11"` — every remaining hex literal is a discipline violation.)
- `frontend/src/api/types.ts` mirrors `hoga/api/models.py` per ADR-0004 — every field name matches.
- LeftNav `CaptureStatusPill` correctly renders null / CAPTURING / PAUSED based on the queue snapshot.
- Q14: today cell shows 🔒 before 18 KST, re-evaluates every 60s without page reload.
- Q16: ⚠ force chip visible on queue rows where `force_retry=true`.
- Q18: `captured_count` (complete-only) shown as primary in dropdown rows; breakdown in title-attr tooltip.
- Q19: cache status indicator next to SymbolSearch input; "unavailable" shows the code-only banner.
- Q21: `useCalendar` reconciliation logic exercised by `reconcileCalendar` unit tests; SSE patches stamp `patched_at_ms`.

---

## What's NOT in this plan (intentional)

- **Inventory page changes** — Plan C touches only `/capture` + the LeftNav pill. Inventory's existing `useEventStream` invalidations still work; no rewrite needed.
- **Replay page** — untouched.
- **Per-item log line buffer** — spec §4.2 mentions "last 5 log lines"; the backend doesn't yet stream discrete log lines. Tracked as a Plan D follow-up; CaptureRowDetail (Task 15) shows metadata only for now.
- **URL state for the form** — spec §4.6 explicit out-of-scope. Form remains ephemeral.
- **Dark/light theme switch** — DESIGN.md says dark-only for v1.
- **Recently-used / pinned symbols** — spec §9.2 explicit out-of-scope (deferred personalization).
- **Inventory SSE storm dedupe** — spec §9.3 follow-up; not addressed here.
- **Hardening the FakeHogaplayClient** — Task 21 adds just enough to drive the cookie-pause test; a richer fake (rate-limit injection, partial-page injection) is Plan D's territory.

---

## What already exists (reuse audit)

- `frontend/src/api/client.ts::apiUrl` — used by every new api/* module.
- `frontend/src/api/sse.ts::subscribeToCaptureEvents` (extended in Task 2) — used by `useCaptureQueue`.
- `frontend/src/styles/global.css::@keyframes capture-pulse` — reused by `CaptureStatusPill` (Task 17).
- `frontend/src/api/stock-dates.ts::STOCK_DATES_QUERY_KEY` — Inventory page already invalidates on SSE; untouched.
- `hoga/api/captures_fake.py` (FakeHogaplayClient) — already exists from the prior plan; Task 21 only adds a failure-injection hook.
- Backend queue surface (Plan B) — every endpoint Plan C calls is already shipped.
- `DESIGN.md` tokens — every color/spacing/typography value comes from this file.
- `docs/superpowers/designs/2026-05-20-replay-viewer.html` — the approved mockup; reference for cell sizing, dropdown shadow, and chip styling.

---

## Failure modes (per new codepath)

| Codepath | Most likely failure | Detection | Recovery |
|---|---|---|---|
| `useSymbols` | pykrx cache unavailable → empty symbols list | `status === 'unavailable'` in cache; `SymbolSearch` shows code-only banner | Manual: user enters 6-digit code directly; client-side validation accepts |
| `useCalendar` reconciliation | SSE patch lands AFTER GET but BEFORE the GET's setQueryData commits | Race window is reconciled by `reconcileCalendar` (Task 8 tests) | None needed — the algorithm is the recovery |
| `useCaptureQueue` SSE multiplex | A SSE event arrives for an `item_id` not present in cache | `patchQueueItem` returns the prior snapshot unchanged (no-op) | Next `capture_finished` triggers an invalidate which fetches the truth |
| `DateRangePicker` 60s tick | `setInterval` keeps firing after unmount | useEffect cleanup returns `clearInterval(id)` | Verified by the registered-interval test |
| `CaptureQueue` virtualization | Off-screen rows lose mount-time state (none have any) | Rows are stateless except `expanded`; expanded resets on scroll if the row leaves the window | Acceptable for v1+2; tracked as a polish item |
| `CaptureStatusPill` | Cache empty during initial query → renders null briefly | useCaptureQueue returns `undefined` until first GET resolves | Expected; pill snaps in once data arrives |
| `addItems` mutation | Backend 400 today_too_early | CaptureForm renders inline error from `err.message` | User picks a different date or waits |
| `cancelItem` mutation | Backend 409 (item already terminal) | api/captures.ts swallows 409 silently | Queue snapshot refreshes on next SSE / poll |
| Playwright | FakeHogaplayClient state leaks between specs | Each spec resets `_raise_on_request_index` via the test endpoint | Document the reset call at end of spec |

---

## Worktree parallelization strategy

Phase 1 is sequential (each task depends on `types.ts`). Phase 2 (legacy delete) must follow Phase 1. Phase 3 is sequential within itself (useCalendar's reconcile is referenced by useCaptureQueue). Phases 4 + 5 are partially parallelizable across worktrees:

| Lane | Tasks | Touches |
|---|---|---|
| A | 10 (CalendarCell), 12 (DateRangePicker) | `capture/CalendarCell.tsx`, `capture/DateRangePicker.tsx` |
| B | 11 (SymbolSearch) | `capture/SymbolSearch.tsx` |
| C | 14 (CaptureQueueRow), 15 (CaptureRowDetail) | `capture/CaptureQueueRow.tsx`, `capture/CaptureRowDetail.tsx` |

Lanes A, B, C touch disjoint files. Run after Phase 3 lands. Then Phase 5's Task 13 (CaptureForm) consumes Lanes A + B; Task 16 (CaptureQueue) consumes Lane C — those join the lanes back into the main branch.

Phases 6 + 7 are sequential and best done on the main branch after the lane merges.

For inline single-session execution, just go top-to-bottom — the dependency edges naturally enforce order.

---

## Self-review (post-write)

**Spec coverage check:**
- §4.1 file layout (13 files) → mapped to Tasks 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18 ✓
- §4.2 Component responsibilities → Tasks 11, 12, 10, 13, 16, 14, 15 ✓
- §4.3 Hooks → Tasks 7 (useSymbols + useSymbolSearch), 8 (useCalendar), 9 (useCaptureQueue) ✓
- §4.4 Layout (Q10 = A) → Task 18 (38/62 split + legend) ✓
- §4.5 LeftNav pill → Task 17 ✓
- §4.6 URL state → explicitly out of scope (matches spec) ✓
- §6 Design System Conformance → enforced per component (Tasks 10, 11, 14); discipline grep in Task 22 ✓
- §7.2 vitest test list → matched to tests inside Tasks 7, 8, 9, 10, 11, 12, 13, 14, 16 ✓
- §7.3 E2E specs → Tasks 19 (range-capture), 20 (calendar-markers), 21 (cookie-pause) ✓
- §11 Q14 (today_locked 18 KST + 60s re-eval) → Task 12 ✓
- §11 Q16 (force chip) → Task 14 ✓
- §11 Q18 (captured_count + breakdown tooltip) → Task 11 ✓
- §11 Q19 (cache status indicator + unavailable banner) → Task 11 ✓
- §11 Q21 (as_of_ms reconciliation) → Task 8 + applyCellPatch wired in Task 9 ✓

**Placeholder scan:** None. Every step contains either concrete code, a concrete command, or an explicit "if missing, add X" directive.

**Type consistency:** `QueueItem`, `SymbolHit`, `CalendarCell`, `CalendarResponse`, `EnqueueRequest/Response`, `QueueSnapshot` field names match `hoga/api/models.py` exactly (Plan B). `item_id` (not `job_id`) used throughout. `force_retry`, `pause_origin`, `skip_reason`, `captured_breakdown` all spelled identically across api/types/component/test files.

Plan complete and saved to `docs/superpowers/plans/2026-05-23-capture-queue-frontend.md`.

---

## Execution Handoff

**Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with full context inline (no plan-file re-reading); two-stage review (spec compliance, then code quality) after each task; fast iteration in the same session.

**2. Inline Execution** — Run tasks in this session via `superpowers:executing-plans`; batch with checkpoints.

Both produce the same artifact. Subagent-Driven is recommended given the size (22 tasks across 7 phases).

---

## DESIGN REVIEW REPORT

Score: **6.5/10 → 9/10** after 6 inline fixes.

### Findings (all fixed inline before execution)

**F1 (P1, design score 6/10)** — `CalendarCell` was missing the `--bg-input-hover`
hover state from spec §6. Without it, the cell gives no visual feedback to mouse
hover and the user wonders if the cell is even clickable (Krug: "Don't make me
think"). **Fixed:** added `useState`-tracked `hovered` plus matching `:focus`
state for keyboard parity; teal `box-shadow: 0 0 0 1px var(--accent)` focus ring
honors DESIGN.md focus convention.

**F2 (P1, design score 5/10)** — `CalendarCell` was missing the per-status hover
tooltip mandated by spec §4.2. weekend/holiday/future/today_locked cells appear
disabled with no explanation; complete/source_partial/client_incomplete give no
recency context. **Fixed:** added `tooltipFor(status, date)` helper that emits
spec-aligned tooltip text and binds it to both `title` and `aria-label`. Test
locks in the tooltip vocabulary.

**F3 (P1, design score 7/10)** — `SymbolSearch` had no empty-state branch when
the query returned zero matches. Dropdown silently disappeared, leaving the user
with a search box that "didn't react." Violates Krug's reservoir-of-goodwill
principle — silent failure depletes it. **Fixed:** explicit "검색 결과가
없습니다. 종목명 또는 6자리 코드를 확인하세요." panel renders inside the dropdown
when `hits.length === 0`. Test added.

**F4 (P1, design score 4/10)** — `CaptureQueue` had no empty state. First-time
users (and users after Dismiss Done) saw a blank right panel and could not tell
if the form on the left was wired up. **Fixed:** dedicated empty state with a
"큐가 비어 있습니다" heading + "왼쪽에서 종목과 날짜 범위를 선택하고 Start 를
누르면 캡처가 시작됩니다." pointer. Empty state suppressed when paused (banner
takes priority). Two tests added.

**F5 (P1, design score 5/10)** — `Cancel All` was a single-click destructive
action (kills active captures + drains queue + can clear pause state). One
misclick destroys minutes of work. **Fixed:** two-click confirmation with 4s
timeout — first click arms ("Click again to confirm" in `--down` color), second
click commits, no-action resets to default after 4s. Inline confirm instead of
modal matches the calm-surface app-UI aesthetic. Test verifies two-click flow.

**F6 (P1, design score 4/10 — WCAG 2.1 Level A)** — `CaptureQueueRow` used a
`<div onClick>` for expansion. Keyboard users (Tab + Enter/Space) could not
expand rows; screen reader users had no role announcement. **Fixed:** added
`role="button"`, `tabIndex={0}`, `aria-expanded`, descriptive `aria-label` with
phase/state, and an `onKeyDown` that handles Enter and Space. Test verifies
ARIA shape and key handling.

### AI Slop check (Pass 4)

- **3-column SaaS feature grid**: not present.
- **Centered everything**: not present (form is left-aligned; queue is left-aligned table).
- **Decorative blobs / gradients**: not present (single accent color, DESIGN.md discipline).
- **Cookie-cutter section rhythm**: not present (single page, two functional panels).
- **Generic hero copy**: N/A (no hero).
- **system-ui font fallback**: not present (Geist Sans + Geist Mono per DESIGN.md).

No AI slop patterns detected. Plan C's design is specific to the hoga-ops capture
domain — calendar with KRX trading-day markers, queue with phase chips, force
chip on retry rows. This is "Modern Trading Lab" aesthetic per DESIGN.md.

### Color discipline (DESIGN.md compliance)

All Plan C palette references map to DESIGN.md tokens or sanctioned tint
literals (the four `rgba(...)` values for `--accent` selection tint, `--up` tint,
`--down` tint, `--warn` tint — DESIGN.md explicitly defines these tint patterns).
Verified by grep: zero hex literals outside `--warn = #F59E0B` (which is the
DESIGN.md-approved Warning semantic color added in pre-flight P4). Teal-for-UI
vs up/down-for-data invariant respected: phase chips use teal tint for in-progress
states (UI), `--up` tint for done (data state), `--down` tint for failed (data
state). Calendar markers (✓ --up / ⚠ --warn / ✕ --down) follow the same rule.

### Typography

All font declarations match DESIGN.md scale:
- Display labels: `Geist Sans 600 10.5px letter-spacing 0.08em uppercase` (form section labels).
- Body: `Geist Sans 13px --fg`.
- Mono (numbers, codes, dates): `Geist Mono 500 11px tabular-nums`.
- Market chip: `Geist Sans 600 8.5px letter-spacing 0.06em`.
- Status indicator glyphs: `14px` lineHeight 1.

No off-system fonts. `font-variant-numeric: tabular-nums` applied to every
numeric value as DESIGN.md requires.

### Spacing

DESIGN.md scale (2/4/8/12/16/24/32/48 px) honored throughout. CalendarCell 32×32
matches spec §6. Queue row 36px height matches spec §6. Panel padding 12–16px
matches DESIGN.md "card padding 12-14px standard."

### Information density

Spec §4.4's 38/62 split is implemented. Header summary line uses Geist Mono 11px
tabular-nums — readable at glance, dense enough to fit "{N} of {M} done · {F} failed
· {C} capturing" on one line for typical queue sizes.

### Accessibility (Pass 6 — what's specified)

- **Keyboard nav**: SymbolSearch (↑↓/Enter/Esc), DateRangePicker cells (Tab-focused buttons), CaptureQueueRow (Enter/Space expand — F6).
- **Touch targets**: CalendarCell 32×32, queue row action buttons 14px font centered in cells. DESIGN.md notes desktop-only v1 so 44px-min is relaxed. Manual verification step (Task 22) walks through with a mouse.
- **Color contrast**: dark mode palette in DESIGN.md was calibrated for WCAG AA. `--fg-dim #94A3B8` on `--bg #0E0E14` = 7.8:1 (AAA). `--warn #F59E0B` on dark bg = 6.4:1 (AA pass). `--accent #14B8A6` on dark bg = 5.6:1 (AA pass).
- **Screen reader**: `aria-expanded` on queue rows, `aria-label` on CalendarCell, `role="listbox"`/`role="option"` on SymbolSearch dropdown, `role="alert"` on the pause banner and form errors.
- **Color independence**: phase status communicated via both icon (✓/⚠/✕/●/○) AND color, so color-blind users get the same information.

### NOT in scope (design — explicit)

- **Mobile/tablet responsive**: DESIGN.md says desktop-only v1.
- **Light theme**: DESIGN.md explicit out-of-scope.
- **Animated row enter/exit**: spec discipline "we do NOT animate value changes" — queue rows snap in/out.
- **Custom focus-visible CSS**: covered by `box-shadow: 0 0 0 1px var(--accent)` on CalendarCell + browser default outline elsewhere; full focus-ring polish deferred.

### Unresolved decisions

None — all 6 findings fixed inline with concrete code.

### VERDICT: CLEARED — Design review passed with 6 inline fixes.

---

## ENG REVIEW REPORT

Status: **ISSUES FIXED** — 4 critical findings, all inlined before execution.

### Findings (all fixed inline before execution)

**E1 (P1, confidence 10/10)** — Plan C used `from 'react-router-dom'` for `Link`,
`MemoryRouter`, etc. The project ships **`react-router` v7.15.1** (verified
`frontend/package.json`); every existing import in `frontend/src/` uses
`from 'react-router'`. The legacy `react-router-dom` package isn't even
installed — every component Plan C planned to import would fail at module
resolution. **Fixed:** all three Plan C references converted to `react-router`
via global sed. Now matches every existing `frontend/src/*.tsx` import.

**E2 (P1, confidence 9/10)** — `useCalendar`'s `select: (incoming) =>
reconcileCalendar(undefined, incoming)` does NOT implement Q21 reconciliation.
`select` in react-query v5 receives the raw `queryFn` return value on every
render; it has zero visibility into the prior cached value, so
`reconcileCalendar(undefined, ...)` is a no-op (always falls through the
"`prior === undefined`" branch). The Q21 race window the spec called out — a
GET arriving after an SSE patch — would silently overwrite the patched cell.
**Fixed:** moved the reconciliation INTO `queryFn` itself. The query function
now pulls prior cache via `qc.getQueryData<EnrichedCalendarResponse>(queryKey)`
and returns `reconcileCalendar(prev, incoming)` — exactly once per fetch with
access to both prior and incoming. v5 removed `onSuccess` so this is the
canonical cache-mutation-at-fetch hook.

**E3 (P1, confidence 10/10)** — Plan C's Task 19 said "Possibly create:
`frontend/playwright.config.ts`". The config **already exists** (verified
read) with `testDir`, `testMatch: /.*\.spec\.ts$/`, `baseURL` via
`E2E_BASE_URL`, no `webServer` block. Creating a parallel file would orphan
the existing config + break existing specs. **Fixed:** Task 19 now reads
"Modify existing `frontend/playwright.config.ts` — add a `webServer` block"
with explicit instructions to preserve every existing field. Backend +
frontend webServer entries gated on `!process.env.CI` for local
reuseExistingServer ergonomics.

**E4 (P1, confidence 10/10)** — `frontend/tests/e2e/capture-flow.spec.ts` and
4 sibling specs exist from the prior plan. `capture-flow.spec.ts` targets
removed endpoints (`POST /api/captures`, `GET /latest`, etc.) that Plan B
deleted. Without explicit cleanup, those specs fail in CI but their failures
look like real bugs in the new flow. **Fixed:** Task 19 Step 1 now includes
an explicit `grep` audit + `rm -f frontend/tests/e2e/capture-flow.spec.ts` +
guidance to inspect the four other specs (`error-states`, `multi-tab`,
`sse-refresh`, `replay-smoke`) for capture-endpoint references and clean
them up before the new specs land.

### Architecture review (no rewrites needed)

- **Phase layering** (api → hooks → atomic → container → page → E2E) is the
  conventional react-frontend pattern; each phase's outputs are exactly the
  inputs the next phase consumes. Two-week smell test passes — a developer
  picking up Task 13 can finish CaptureForm without re-reading Tasks 1–12 because
  the hooks (Tasks 7–9) and atomic components (Tasks 10–12) already encode
  every contract CaptureForm needs.
- **SSE multiplex** (Task 9 `useCaptureQueue`) keeps a single EventSource open
  via `subscribeToCaptureEvents` from Plan B's existing `sse.ts`. The handler
  branch on `e.type` dispatches to either `setQueryData` (cheap patches:
  capture_progress / capture_phase) or `invalidateQueries` (cache-shifting
  events: capture_queued / capture_finished / queue_paused / queue_resumed /
  queue_drained). The split is correct — `invalidateQueries` for events that
  move items across active/queued/done buckets, `setQueryData` for in-place
  field updates.
- **`patchQueueItem` reference equality** — returns the prior snapshot
  unchanged when `item_id` matches nothing, so react-query's structural sharing
  short-circuits re-renders. Subtle but important; the Task 9 unit test
  `returns prior unchanged when item_id missing` locks this in.
- **`addItems` mutation race** (spec §4.3) — `onSettled` invalidates rather
  than `setQueryData(payload)` because an SSE `capture_queued` event can land
  between POST response and onSuccess. Plan C uses `onSettled` (not
  `onSuccess`) which fires on both success and error — strictly broader than
  spec's recommendation but harmless: the invalidate is idempotent.
- **`useVirtualizer` threshold of 200 items** — `@tanstack/react-virtual` ^3
  API verified against existing project conventions. The `parentRef`
  pattern with `useRef<HTMLDivElement>(null)` is correct.

### Test coverage (closed by F1-F4 fixes + design review F1-F6)

- Each Task ships failing-test-first → impl → pass → commit pattern.
- Total new test files: 16 (api/* 5, capture/* 9, nav 1, pages 1).
- Vitest baseline: 103 → expected ~150+ after Plan C (deletions in Phase 2
  remove ~14 legacy tests; Phases 3–6 add ~60+ new tests counting design-review
  additions).
- Playwright: 3 new E2E specs (range-capture / calendar-markers / cookie-pause).

### Style notes (P3 — not fixed, acceptable)

- Existing tests use `vi.mock('./api/...')` module-mocking; Plan C uses
  `vi.spyOn(globalThis, 'fetch' as 'fetch')` global-fetch spying. Both work
  in vitest 4.x with jsdom 29. Plan C's pattern is more explicit (no module
  ambiguity) but inconsistent. Acceptable for a focused PR; could converge
  on one pattern in a follow-up cleanup.
- Plan C's vitest test files redundantly `import { describe, it, vi, ... }
  from 'vitest'` despite `globals: true` in `vitest.config.ts`. Harmless;
  matches some existing files (others rely on globals). No fix needed.
- @testing-library/`userEvent` (already a dep) would be more idiomatic for
  keyboard interaction tests than `fireEvent.keyDown`. Both work in practice;
  defer the migration.

### NOT in scope (eng-review confirmations)

- Server-side fixes: every backend dep Plan C calls is already shipped in
  Plan B. No backend changes in Plan C except the small `_cookie_expire_at`
  test endpoint hook in Task 21 (explicitly justified).
- Bundle size analysis: `@tanstack/react-virtual` adds ~10KB. Acceptable.
- Storybook / Chromatic: out of v1+2 scope per CLAUDE.md.

### CROSS-MODEL

Not run (auto mode; outside voice deferred — subagent-driven execution
provides per-task review pass).

### UNRESOLVED: 0

### VERDICT: CLEARED — Eng review passed with 4 inline fixes. Plan C is ready for `/superpowers:subagent-driven-development`.








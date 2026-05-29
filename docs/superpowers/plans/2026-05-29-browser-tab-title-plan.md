---
scope: frontend
spec: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
---

# Dynamic browser tab title — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `<title>frontend</title>` with the active **Code**'s name on `/replay` and `/live`, falling back to `hoga-ops` everywhere else.

**Architecture:** One hook (`useDocumentTitle`) is the sole writer to `document.title`. Pages with a current-**Code** concept call it; cleanup on unmount restores `'hoga-ops'`. Name lookup uses the existing **Symbol Master** cache via `useSymbols()`.

**Tech Stack:** React 18 hooks, Zustand store (`useTabsStore`, `useLivePageStore`), TanStack Query (`useSymbols`), Vitest + `@testing-library/react` for the hook test.

## Invariants (from spec — must hold after implementation)

- **Single writer**: `useDocumentTitle` is the only code path that writes to `document.title`. Verified empty pre-implementation (`git grep "document.title" frontend/src/` → 0).
- **Default-on-unmount**: After unmounting a Code-page, `document.title === 'hoga-ops'`.
- **Precedence**: `name (Symbol Master) ?? code ?? 'hoga-ops'` for a single hook call.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/util/useDocumentTitle.ts` | Create | The hook; sole `document.title` writer |
| `frontend/src/util/useDocumentTitle.test.ts` | Create | Hook unit tests (Vitest + `renderHook`) |
| `frontend/index.html` | Modify (line 7) | Static `<title>` → `hoga-ops` |
| `frontend/src/pages/ReplayViewer.tsx` | Modify | Call `useDocumentTitle(active.selection?.code)` |
| `frontend/src/live/LivePage.tsx` | Modify | Call `useDocumentTitle(activeCode)` reusing line 53 |

Naming convention: matches existing `frontend/src/util/sessionTime.ts` / `wheelInteractions.ts` patterns — pure-ish utility hooks in `util/`, colocated `.test.ts` (no JSX → `.ts`, not `.tsx`).

---

## Task 1: Implement `useDocumentTitle` hook (TDD)

**Files:**
- Create: `frontend/src/util/useDocumentTitle.ts`
- Create: `frontend/src/util/useDocumentTitle.test.ts`

### Step 1: Write the failing test

Create `frontend/src/util/useDocumentTitle.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDocumentTitle } from './useDocumentTitle';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import type { SymbolHit, SymbolsAllResponse } from '../api/types';

const HITS: SymbolHit[] = [
  {
    code: '005930',
    name: '삼성전자',
    market: 'KOSPI',
    captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
  },
];

function makeQc(seedSymbols: SymbolsAllResponse | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedSymbols) {
    // Seed the cache so useSymbols() returns synchronously without hitting fetch.
    qc.setQueryData(SYMBOLS_QUERY_KEY, seedSymbols);
  }
  return qc;
}

function wrap(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  document.title = 'before-test';
  // Block any accidental network fetch — useSymbols falls back to data:undefined.
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }),
  } as Response);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDocumentTitle', () => {
  it('sets document.title to "hoga-ops" when code is null', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle(null), { wrapper: wrap(qc) });
    expect(document.title).toBe('hoga-ops');
  });

  it('sets document.title to "hoga-ops" for whitespace-only code', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('   '), { wrapper: wrap(qc) });
    expect(document.title).toBe('hoga-ops');
  });

  it('resolves a known code to its Symbol Master name', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
  });

  it('falls back to the raw code when Symbol Master has no match', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('999999'), { wrapper: wrap(qc) });
    expect(document.title).toBe('999999');
  });

  it('falls back to the raw code while Symbol Master is still loading', () => {
    const qc = makeQc(undefined);
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('005930');
  });

  it('updates document.title when code changes', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { rerender } = renderHook(
      ({ code }: { code: string | null }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: null } as { code: string | null } },
    );
    expect(document.title).toBe('hoga-ops');
    rerender({ code: '005930' });
    expect(document.title).toBe('삼성전자');
  });

  it('restores "hoga-ops" on unmount', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { unmount } = renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
    unmount();
    expect(document.title).toBe('hoga-ops');
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd frontend && npx vitest run src/util/useDocumentTitle.test.ts`

Expected: FAIL with `Cannot find module './useDocumentTitle'` (or similar resolve error).

### Step 3: Write the minimal implementation

Create `frontend/src/util/useDocumentTitle.ts`:

```ts
import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';

const DEFAULT_TITLE = 'hoga-ops';

/**
 * Sole writer to `document.title`. Resolves a Code to its Symbol Master name;
 * falls back to the Code itself, then to `'hoga-ops'`. Cleanup restores the
 * default so pages without a current-Code concept inherit it automatically.
 *
 * See: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
 */
export function useDocumentTitle(code: string | null | undefined): void {
  const { data } = useSymbols();
  useEffect(() => {
    const trimmed = code?.trim() || null;
    const name = trimmed
      ? data?.symbols.find((s) => s.code === trimmed)?.name
      : undefined;
    document.title = name ?? trimmed ?? DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [code, data]);
}
```

### Step 4: Run test to verify it passes

Run: `cd frontend && npx vitest run src/util/useDocumentTitle.test.ts`

Expected: PASS — 7 tests pass.

### Step 5: Commit

```bash
git add frontend/src/util/useDocumentTitle.ts frontend/src/util/useDocumentTitle.test.ts
git commit -m "feat(frontend/title): add useDocumentTitle hook + tests"
```

---

## Task 2: Replace the static index.html title

**Files:**
- Modify: `frontend/index.html` (line 7)

### Step 1: Edit index.html

Change line 7 from:

```html
<title>frontend</title>
```

to:

```html
<title>hoga-ops</title>
```

(This ensures direct entry to a page — before React mounts — shows the correct default rather than the Vite scaffold name.)

### Step 2: Verify the file

Run: `grep -n "<title>" frontend/index.html`

Expected output: `7:    <title>hoga-ops</title>`

### Step 3: Commit

```bash
git add frontend/index.html
git commit -m "feat(frontend/title): replace Vite-default static title with hoga-ops"
```

---

## Task 3: Wire `useDocumentTitle` into ReplayViewer

**Files:**
- Modify: `frontend/src/pages/ReplayViewer.tsx`

### Step 1: Inspect current state

Run: `sed -n '53,67p' frontend/src/pages/ReplayViewer.tsx`

Expected output shows the existing function body starting with `export default function ReplayViewer() {` (around line 54) and the line `const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);` already computed.

### Step 2: Add the import

Add this import alongside the existing imports at the top of `frontend/src/pages/ReplayViewer.tsx`:

```ts
import { useDocumentTitle } from '../util/useDocumentTitle';
```

(Place it after the other relative-path imports; preserve alphabetical-ish grouping the file already uses.)

### Step 3: Add the hook call

In the `ReplayViewer` function body, immediately after the existing line:

```ts
const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
```

add:

```ts
useDocumentTitle(active.selection?.code);
```

The result should look like:

```ts
export default function ReplayViewer() {
  useUrlSync();
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  useDocumentTitle(active.selection?.code);
  return (
    // ... unchanged
  );
}
```

Rationale: `active.selection` is `null` on an empty new tab → hook receives `undefined` → falls back to `'hoga-ops'`. When the user picks a stock, the selection's `code` flows in and the title updates.

### Step 4: Type-check and build

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json`

Expected: clean (no errors). If errors are unrelated to this change, capture and stop.

### Step 5: Verify in a smoke test

Run: `cd frontend && npm run build`

Expected: build succeeds.

### Step 6: Commit

```bash
git add frontend/src/pages/ReplayViewer.tsx
git commit -m "feat(frontend/title): wire useDocumentTitle into ReplayViewer"
```

---

## Task 4: Wire `useDocumentTitle` into LivePage

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`

### Step 1: Inspect current state

Run: `sed -n '50,56p' frontend/src/live/LivePage.tsx`

Expected output includes line 53: `const activeCode = queryCode ?? storedCode;`

### Step 2: Add the import

Add this import to `frontend/src/live/LivePage.tsx`:

```ts
import { useDocumentTitle } from '../util/useDocumentTitle';
```

(Place it with the other relative imports near the top.)

### Step 3: Add the hook call

Immediately after the existing line 53:

```ts
const activeCode = queryCode ?? storedCode;
```

add:

```ts
useDocumentTitle(activeCode);
```

The result should look like:

```ts
  const activeCode = queryCode ?? storedCode;
  useDocumentTitle(activeCode);
  const watchlistEmpty = banner.primary === 'watchlist_empty';
```

Rationale (from spec): reusing the already-computed `activeCode` means any future change to active-Code resolution (e.g. Stage 11 watchlist-first fallback per the file's own header comment) automatically flows into the title.

### Step 4: Type-check and build

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json`

Expected: clean.

Run: `cd frontend && npm run build`

Expected: build succeeds.

### Step 5: Verify the invariant — single writer

Run: `git grep -n "document.title" frontend/src/`

Expected output: exactly two occurrences, both inside `frontend/src/util/useDocumentTitle.ts` (the `document.title = …` assignment and the cleanup `document.title = DEFAULT_TITLE;`).

If any other file shows up, stop and investigate — that file would violate the **Single writer** invariant.

### Step 6: Commit

```bash
git add frontend/src/live/LivePage.tsx
git commit -m "feat(frontend/title): wire useDocumentTitle into LivePage"
```

---

## Task 5: Final invariant + smoke check

**Files:** none (verification only).

### Step 1: Run the full frontend test suite

Run: `cd frontend && npx vitest run`

Expected: all tests pass, including the 7 new `useDocumentTitle` tests.

### Step 2: Re-confirm the Single-writer invariant

Run: `git grep -nE "document\.title\s*=" frontend/src/`

Expected output: exactly two matches in `frontend/src/util/useDocumentTitle.ts`. No other file mutates `document.title`.

### Step 3: Build one more time

Run: `cd frontend && npm run build`

Expected: build succeeds.

### Step 4: Manual smoke (if a dev server is available)

If `npm run dev` is running, open these and check the browser tab title:

- `http://localhost:5173/replay` with a stock selected → tab title is the stock name (e.g. `삼성전자`).
- `http://localhost:5173/replay` with a fresh empty tab (no selection) → tab title is `hoga-ops`.
- `http://localhost:5173/live?code=005930` → tab title is `삼성전자`.
- `http://localhost:5173/live` with no `?code=` and empty `activeCode` → tab title is `hoga-ops`.
- `http://localhost:5173/inventory` → tab title is `hoga-ops`.
- Navigate `/replay (selection=005930)` → `/inventory` → tab title transitions `삼성전자` → `hoga-ops`.

If `npm run dev` is not running, skip — the unit tests already cover the same matrix.

---

## Self-review notes

- Spec coverage: §Architecture (Task 1), §Components (Tasks 1-4), §Hook contract (Task 1 code), §Data flow (Tasks 3-4), §Edge cases (Task 1 tests cover all 8 rows: 6 explicit tests + the two `/replay new tab` and `/live no code` rows are covered transitively by the `null code → hoga-ops` test combined with the Task 3/4 wiring code which forwards `undefined`/`null` directly).
- Invariants: Single writer = Task 4 Step 5 + Task 5 Step 2 verification. Default-on-unmount = Task 1 Step 1 (unmount test). Precedence = Task 1 Step 1 (name → code → default tests).
- Placeholder scan: none.
- Type consistency: hook signature `useDocumentTitle(code: string | null | undefined): void` is identical across Tasks 1, 3, 4.

## Deferred review notes

플랜 디자인 리뷰(2026-05-29, 인라인)에서 식별했으나 이번 변경 범위에 포함하지 않음:

- **Same-Code 다중 브라우저 탭 disambiguation**: 같은 **Code**(예: 005930)를 두 개 이상의 브라우저 탭에 띄우면 둘 다 `'삼성전자'`로 보여 구분 불가. 가능한 해결책: 탭별로 fromDate/timeframe 접미사 부가, favicon 색상 hint. 미루는 이유: 발생 빈도 낮음(같은 종목을 다른 기간/타임프레임으로 동시 비교하는 케이스). 사용자가 실제로 부딪히면 다시 결정.
- **First-fetch flicker (`code` → `name`)**: useSymbols 캐시 미스시 한 번 코드 → 이름 깜빡임. spec §Goals에서 옵션 A로 의식적 수용됨. 만약 거슬리면 옵션 B(이름 준비 전까지 `'hoga-ops'` 유지)로 후속 변경 가능.
- **Screen reader 영향**: `document.title` 변경은 일부 screen reader가 페이지 전환시 발화. `'frontend'` → 종목명은 명백한 개선이며 추가 a11y 작업 불필요. WCAG `2.4.2 Page Titled` 준수 (제목이 페이지 내용을 식별).

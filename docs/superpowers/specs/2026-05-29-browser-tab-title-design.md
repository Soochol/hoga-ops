# Dynamic browser tab title

**Date:** 2026-05-29
**Status:** Draft
**Scope:** frontend

## Problem

`frontend/index.html` ships with a static `<title>frontend</title>` tag. When users have multiple browser tabs open, every hoga-ops tab is labelled "frontend", indistinguishable from each other and from any other Vite-default project the user may have running.

The Replay Viewer and `/live` page already know which **Code** the user is looking at (the active Replay Tab's `TabSelection.code` on `/replay`, `useLivePageStore.activeCode` on `/live`). That information should reach the browser tab title so users can pick out a hoga-ops tab — and tell apart two hoga-ops tabs viewing different Codes — at a glance.

## Invariants

기존 시스템에 `document.title`을 쓰는 코드 경로는 없다 (정적 `<title>frontend</title>` 외). 이 spec이 *신설하는* invariant들:

- **Single writer**: `useDocumentTitle` 훅만 `document.title`에 쓴다. 다른 컴포넌트가 직접 `document.title = …`를 호출하면 cleanup 기반 default 복원 가정이 깨진다. 근거: [frontend/src/util/useDocumentTitle.ts](frontend/src/util/useDocumentTitle.ts) (이 spec이 신설).
- **Default-on-unmount**: Code 페이지(`/replay`, `/live`)에서 다른 페이지로 이동하면 `document.title === 'hoga-ops'`로 복원된다. 근거: 훅의 cleanup 함수가 무조건 `DEFAULT_TITLE`을 쓰며, 비-Code 페이지는 훅을 호출하지 않아 cleanup 후 값이 보존된다.
- **Precedence**: 한 번의 `useDocumentTitle(code)` 호출이 결정하는 title은 `(name (Symbol Master에 있을 때) ?? code)`를 base로 삼고, 해당 **Code**의 **Live Quote**가 있으면 `price`와 `change_pct`를 뒤에 붙인다. base가 없으면 `hoga-ops`. Live Quote가 없거나 `change_pct=null`이면 없는 필드는 생략한다.

## Invariant impact

| Invariant | 영향 | 비고 |
|---|---|---|
| Single writer | preserves (신설) | grill 단계에서 `git grep "document.title" frontend/src/` 결과 0건 확인 — 이 spec이 도입하는 호출이 유일한 writer가 된다 |
| Default-on-unmount | preserves | cleanup 함수가 unconditional, 비-Code 페이지는 훅 미호출 → 값 유지 |
| Precedence | preserves | 훅 내부 단일 `??` 체인; 변경 시 [edge cases](#edge-cases) 표 동시 갱신 |

기존 정적 `<title>frontend</title>` 값은 invariant가 아닌 단순 하드코딩 default이며, index.html 변경으로 `hoga-ops`로 치환된다 — 사용자 시각 가치를 위한 의도된 변경.

## Goals

- Browser tab title reflects the active **Code** on `/replay` and `/live`.
- Pages without a single active-**Code** concept (`/inventory`, `/capture`, `/watchlist`, `/settings`) show the project name `hoga-ops`.
- Direct entry to any page never shows the Vite default "frontend".

## Non-goals

- Showing the resolved name in the in-app UI (TabStrip already does this).
- Persisting title state to localStorage or syncing across tabs.
- Localising the project name fallback. `hoga-ops` is the literal repo name and stays the same in any locale.
- Adding a title-management library (react-helmet, etc.) — direct `document.title` mutation is sufficient.

## Design

### Architecture

A single hook, `useDocumentTitle(code: string | null | undefined)`, owns all writes to `document.title`. Pages that have a current-**Code** concept call it with that Code; other pages do not call it at all. The hook's cleanup function restores the project-name default on unmount, so navigating from a Code page to a non-Code page automatically falls back to `hoga-ops` without any code in the destination page.

```
ReplayViewer ─┐
              ├─→ useDocumentTitle(code) ─→ useSymbols() name lookup ─→ document.title
LivePage    ──┘
                                          unmount cleanup → 'hoga-ops'
```

Why this shape:
- **Single writer.** Only the hook touches `document.title`. No other component should set it. This keeps the contract on what's allowed in the title in one place.
- **Pull, not push.** The hook reads from `useSymbols()` (already cached via TanStack Query) instead of requiring each page to thread the resolved name through. Pages only need to know the code.
- **Default via cleanup, not via every page.** Non-symbol pages do not need to opt in. The previous page's cleanup leaves `document.title === 'hoga-ops'` and that's what shows until something else calls the hook.

### Components

**New:**

- [`frontend/src/util/useDocumentTitle.ts`](frontend/src/util/useDocumentTitle.ts) — the hook.
- [`frontend/src/util/useDocumentTitle.test.ts`](frontend/src/util/useDocumentTitle.test.ts) — Vitest unit tests.

**Modified:**

- [`frontend/index.html`](frontend/index.html) — change `<title>frontend</title>` to `<title>hoga-ops</title>` so the very first paint (before React mounts) matches the default.
- [`frontend/src/pages/ReplayViewer.tsx`](frontend/src/pages/ReplayViewer.tsx) — call `useDocumentTitle(activeTab?.selection?.code)`.
- [`frontend/src/live/LivePage.tsx`](frontend/src/live/LivePage.tsx) — call `useDocumentTitle(activeCode)` reusing the already-computed `const activeCode = queryCode ?? storedCode;` on line 53. Reusing the variable means any future change to active-code resolution (e.g. Stage 11 watchlist-first fallback per the file's own header comment) flows into the title automatically.

### Hook contract

```ts
// frontend/src/util/useDocumentTitle.ts
import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';
import { useQuoteByCode, type LiveQuote } from '../api/liveQuotes';

const DEFAULT_TITLE = 'hoga-ops';

function formatTitleBase(base: string, quote: LiveQuote | undefined): string {
  if (!quote) return base;
  const parts = [base, quote.price.toLocaleString('ko-KR')];
  if (quote.change_pct !== null) {
    parts.push(`${quote.change_pct > 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%`);
  }
  return parts.join(' ');
}

export function useDocumentTitle(code: string | null | undefined): void {
  const { data } = useSymbols();
  const { data: quote } = useQuoteByCode(code);
  useEffect(() => {
    const trimmed = code?.trim() || null;
    const name = trimmed
      ? data?.symbols.find((s) => s.code === trimmed)?.name
      : undefined;
    const base = name ?? trimmed;
    document.title = base ? formatTitleBase(base, quote) : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [code, data, quote]);
}
```

Title resolution precedence (first non-empty wins, then quote augmentation if available):

1. Name from the **Symbol Master** (via `useSymbols()` cache), if `code` is provided and a match exists.
2. The `code` itself, if provided but not yet resolved to a name.
3. `'hoga-ops'`.

### Data flow

**`/replay`:**

```
useTabsStore (activeTabId, tabs)
  → tabs.find(t => t.id === activeTabId).selection?.code
  → useDocumentTitle(code)
  → useSymbols() (shared TanStack Query cache)
  → useQuoteByCode(code)
  → document.title = base ? formatTitleBase(base, quote) : 'hoga-ops'
```

**`/live`:**

```
useSearchParams() → queryCode
useLivePageStore → storedCode
  → activeCode = queryCode ?? storedCode  // already computed at LivePage.tsx:53
  → useDocumentTitle(activeCode)
  → useSymbols()
  → useQuoteByCode(activeCode)
  → document.title = base ? formatTitleBase(base, quote) : 'hoga-ops'
```

`useSymbols()` is already called by `TabStrip`, `CaptureQueue`, `StockCombobox`, and others; calling it from the hook adds no network traffic, only a shared subscription to the cached value.

### Edge cases

| Case | Title shown |
|---|---|
| `code` is `null`, `undefined`, empty, or whitespace-only | `hoga-ops` |
| `code` present, name resolved, Live Quote present | `name price change_pct` (e.g. `삼성전자 71,200 +1.23%`) |
| `code` present, name resolved, Live Quote present but `change_pct=null` | `name price` (e.g. `삼성전자 71,200`) |
| `code` present, name resolved, Live Quote missing | name (e.g. `삼성전자`) |
| `code` present, `useSymbols` still loading | `code` (e.g. `005930`), updates to name on resolve |
| `code` present, **Code** absent from **Symbol Master** (new IPO / delisted) | `code` |
| `useSymbols` query in error state | `code` (data is `undefined`, so `name` is `undefined`) |
| `/replay` new tab with `selection === null` | `hoga-ops` |
| `/live` with no `?code=` and empty `activeCode` | `hoga-ops` |
| Navigation from `/replay` → `/inventory` | Previous hook's cleanup writes `hoga-ops`; no hook runs on `/inventory`, so it stays |
| Reverse navigation `/inventory` → `/replay` | New hook runs on mount, writes resolved title |
| `code` unchanged across renders (e.g. unrelated re-render) | `useEffect` skips (dependency identity unchanged) |

### Error handling

The hook has no explicit error path. Every failure mode (loading, network error, missing symbol) degrades silently to the next fallback in the precedence list. This matches the existing pattern in `TabStrip` and `CaptureQueue`, which also fall back to showing the code when the name is unavailable.

### Testing

`useDocumentTitle.test.ts` — Vitest + `renderHook` from `@testing-library/react`:

1. `code = null` → `document.title === 'hoga-ops'`.
2. `code = null`, then re-render with `code = '005930'` and `useSymbols` data containing it → `document.title === '삼성전자'`.
3. `code = '005930'`, `useSymbols` data empty → `document.title === '005930'`.
4. `code = '005930'`, useSymbols transitions from empty → containing the symbol → title updates from `005930` to `삼성전자`.
5. `code = '   '` (whitespace) → `document.title === 'hoga-ops'`.
6. Unmount → `document.title === 'hoga-ops'`.

`useSymbols()` will be mocked via `vi.mock` so the test doesn't depend on the TanStack Query client. The mock returns a typed `{ data: { symbols: [...] } }` shape that matches the real hook.

No integration test on `ReplayViewer` or `LivePage` — both changes are a single `useDocumentTitle(...)` call, the regression surface is the hook itself, and the page-level wiring is shallow.

## Rollout

Direct edit, no flag. The change is observable only through the tab title, which is a pure UX improvement with no data-correctness impact.

## Alternatives considered

- **React Helmet / `react-helmet-async`.** Adds a dependency and a `<Helmet>` JSX node for what is one line of imperative code. Rejected.
- **Title-management Zustand store.** Each page would write to the store; an `App.tsx` effect would mirror it to `document.title`. More indirection, no clear benefit over calling the hook directly from the page that owns the symbol context. Rejected.
- **Mandatory `useDocumentTitle(null)` call on every non-symbol page.** Explicit, but every new page would need to remember to call it. The cleanup-based default keeps non-symbol pages zero-effort. Rejected.
- **Format `"name (code)"` or `"name — hoga"`.** User chose `name` only — tab strips truncate aggressively and the most identifying info should be first.

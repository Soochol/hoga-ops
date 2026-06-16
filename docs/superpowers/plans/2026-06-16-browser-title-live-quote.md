# Browser Tab Title Live Quote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Show the active **Code** in the browser tab title as name, current price, and change percent, for example `삼성전자 71,200 +1.23%`.

**Architecture:** Keep `frontend/src/util/useDocumentTitle.ts` as the sole writer to `document.title`. Extend it to read the active code's existing live quote through `useQuoteByCode`, format the quote locally, and fall back to the current title behavior until quote data is available.

**Tech Stack:** React 18, TanStack Query, Vitest, Testing Library, TypeScript.

---

## File Structure

- Modify: `frontend/src/util/useDocumentTitle.ts`
  - Continue resolving `code` to Symbol Master name via `useSymbols`.
  - Add live quote lookup via `useQuoteByCode`.
  - Add small pure formatting helpers for price and change percent.
  - Keep cleanup behavior that restores `hoga-ops` on unmount.
- Modify: `frontend/src/util/useDocumentTitle.test.tsx`
  - Seed the React Query cache for `['live-quotes', code]`.
  - Cover price + positive/negative/zero/null change percent.
  - Preserve existing fallback tests for null code, whitespace code, unknown symbol, and loading symbol master.
- No backend files change.
- Modify: `frontend/src/live/LivePage.tsx`
  - Stop passing `timeframe` to `useDocumentTitle`; browser tab titles do not include 봉 labels.
- Modify: `docs/superpowers/specs/2026-05-29-browser-tab-title-design.md`
  - Amend the title precedence and edge-case table so the existing spec matches the new Live Quote suffix behavior.
- Modify: `CONTEXT.md`
  - Add a **Browser Tab Title** glossary entry and update the **Live Quote** entry so the title is listed as a lightweight title-only consumer.

## Formatting Rules

- Known symbol + quote: `삼성전자 71,200 +1.23%`
- Known symbol + quote without change percent: `삼성전자 71,200`
- Known symbol without quote: `삼성전자`
- Unknown symbol with quote: `999999 71,200 +1.23%`
- Null or blank code: `hoga-ops`

The browser title should not render placeholder glyphs such as `—`; missing quote fields are simply omitted.

## Data Flow

```text
LivePage
  └─ activeCode
      └─ useDocumentTitle(code)          sole document.title writer
          ├─ useSymbols()                Code -> Symbol Master name
          ├─ useQuoteByCode([code])       Code -> Live Quote(price, change_pct)
          └─ document.title
              ├─ no Code                 hoga-ops
              ├─ Code/name only          삼성전자
              ├─ quote.price only        삼성전자 71,200
              └─ price + change_pct      삼성전자 71,200 +1.23%
```

---

### Task 1: Add Document Title Quote Formatting Tests

**Files:**
- Modify: `frontend/src/util/useDocumentTitle.test.tsx`

- [x] **Step 1: Add quote fixtures and query-cache seeding helper**

Add this import near the existing imports:

```tsx
import * as client from '../api/client';
```

Insert this code after the existing `HITS` fixture:

```tsx
const LIVE_QUOTES_QUERY_KEY = (code: string) => ['live-quotes', code] as const;

function seedQuote(
  qc: QueryClient,
  code: string,
  quote: { price: number; change_pct: number | null; change_won: number | null },
) {
  qc.setQueryData(LIVE_QUOTES_QUERY_KEY(code), {
    phase: 'open',
    quotes: [{ code, ...quote }],
  });
}
```

Replace the existing `beforeEach` network stub:

```tsx
beforeEach(() => {
  document.title = 'before-test';
  // Block any accidental network fetch — useSymbols falls back to data:undefined.
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }),
  } as Response);
});
```

with:

```tsx
beforeEach(() => {
  document.title = 'before-test';
  // Block accidental network resolution. Most tests seed symbols/quotes in
  // React Query; unseeded queries stay pending so the hook exercises fallback
  // states without mixing Symbols and Live Quote response shapes.
  vi.spyOn(client, 'apiCall').mockReturnValue(new Promise<never>(() => {}));
});
```

- [x] **Step 2: Add a failing test for price and positive change percent**

Delete the existing timeframe suffix test from `frontend/src/util/useDocumentTitle.test.tsx`:

```tsx
  it('appends the live timeframe label when provided', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930', '5m'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 5분봉');
  });
```

Browser Tab Titles no longer include 봉 labels; in-app Live Tab labels remain covered by `frontend/src/live/liveViewLabel.test.ts`.

Insert this test inside `describe('useDocumentTitle', () => { ... })` after `resolves a known code to its Symbol Master name`:

```tsx
  it('includes live price and positive change percent when quote is cached', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 71,200 +1.23%');
  });
```

- [x] **Step 3: Add failing tests for negative, zero, and null change percent**

Insert these tests after the positive-change test:

```tsx
  it('includes live price and negative change percent when quote is cached', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70500, change_pct: -0.8, change_won: -570 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,500 -0.80%');
  });

  it('includes live price and zero change percent without a plus sign', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70000, change_pct: 0, change_won: 0 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000 0.00%');
  });

  it('omits change percent when the live quote has null change_pct', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70000, change_pct: null, change_won: null });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000');
  });
```

- [x] **Step 4: Add a failing test for quote arrival after initial render**

Insert this test after the null-change test:

```tsx
  it('updates the title when the live quote arrives after the initial render', async () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');

    qc.setQueryData(LIVE_QUOTES_QUERY_KEY('005930'), {
      phase: 'open',
      quotes: [{ code: '005930', price: 71200, change_pct: 1.23, change_won: 860 }],
    });

    await waitFor(() => {
      expect(document.title).toBe('삼성전자 71,200 +1.23%');
    });
  });
```

- [x] **Step 5: Add a stale-quote guard test for Code changes**

Insert this test after the quote-arrival test:

```tsx
  it('does not attach the previous code quote while the new code quote is loading', () => {
    const qc = makeQc({
      symbols: [
        ...HITS,
        {
          code: '000660',
          name: 'SK하이닉스',
          market: 'KOSPI',
          captured_count: 0,
          captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
        },
      ],
      status: 'fresh',
      fetched_at_ms: 1,
    });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });

    const { rerender } = renderHook(
      ({ code }: { code: string }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    expect(document.title).toBe('삼성전자 71,200 +1.23%');

    rerender({ code: '000660' });
    expect(document.title).toBe('SK하이닉스');
  });
```

This test protects against `useQuotes` `placeholderData` retaining the previous query's data while a new Code's quote request is pending.

- [x] **Step 6: Add an unknown-Code-with-quote test**

Insert this test after the stale-quote guard test:

```tsx
  it('uses the raw Code as the title base when Symbol Master has no match but quote exists', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '999999', { price: 12345, change_pct: 4.56, change_won: 540 });
    renderHook(() => useDocumentTitle('999999'), { wrapper: wrap(qc) });
    expect(document.title).toBe('999999 12,345 +4.56%');
  });
```

Also update the test imports at the top of `frontend/src/util/useDocumentTitle.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
```

- [x] **Step 7: Run the focused test and verify it fails**

Run:

```bash
cd frontend && npx vitest run src/util/useDocumentTitle.test.tsx
```

Expected: FAIL. At least the new positive-change test should report that the received title is still `삼성전자` because the implementation has not yet read live quotes.

- [x] **Step 8: Commit the failing tests**

Run:

```bash
git add frontend/src/util/useDocumentTitle.test.tsx
git commit -m "test: cover live quote browser title"
```

---

### Task 2: Implement Live Quote Browser Title Formatting

**Files:**
- Modify: `frontend/src/util/useDocumentTitle.ts`
- Modify: `frontend/src/live/LivePage.tsx`
- Test: `frontend/src/util/useDocumentTitle.test.tsx`

- [x] **Step 1: Replace `useDocumentTitle.ts` with the quote-aware implementation**

Use this complete file content:

```ts
import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';
import { useQuoteByCode, type LiveQuote } from '../api/liveQuotes';

const DEFAULT_TITLE = 'hoga-ops';

function formatTitlePrice(price: number): string {
  return price.toLocaleString('ko-KR');
}

function formatTitleChangePct(pct: number | null): string | null {
  if (pct === null) return null;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function formatTitleBase(base: string, quote: LiveQuote | undefined): string {
  if (!quote) return base;
  const parts = [base, formatTitlePrice(quote.price)];
  const pct = formatTitleChangePct(quote.change_pct);
  if (pct) parts.push(pct);
  return parts.join(' ');
}

/**
 * Sole writer to `document.title`. Resolves a Code to its Symbol Master name;
 * falls back to the Code itself, then to `'hoga-ops'`. When the live quote cache
 * has the active code, appends current price and change percent.
 *
 * See: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
 */
export function useDocumentTitle(code: string | null | undefined): void {
  const trimmed = code?.trim() || null;
  const { data } = useSymbols();
  const quoteByCode = useQuoteByCode(trimmed ? [trimmed] : []);
  const quote = trimmed ? quoteByCode.get(trimmed) : undefined;

  useEffect(() => {
    const name = trimmed
      ? data?.symbols.find((s) => s.code === trimmed)?.name
      : undefined;
    const base = name ?? trimmed;
    document.title = base ? formatTitleBase(base, quote) : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [trimmed, data, quote]);
}
```

- [x] **Step 2: Remove the timeframe argument from LivePage**

In `frontend/src/live/LivePage.tsx`, change:

```tsx
  useDocumentTitle(activeCode, timeframe);
```

to:

```tsx
  useDocumentTitle(activeCode);
```

- [x] **Step 3: Run the focused test and verify it passes**

Run:

```bash
cd frontend && npx vitest run src/util/useDocumentTitle.test.tsx
```

Expected: PASS. The new quote title tests and all existing fallback tests pass.

- [x] **Step 4: Commit the implementation**

Run:

```bash
git add frontend/src/util/useDocumentTitle.ts frontend/src/util/useDocumentTitle.test.tsx frontend/src/live/LivePage.tsx
git commit -m "feat: show live quote in browser title"
```

---

### Task 3: Amend Browser Tab Title Spec And Glossary

**Files:**
- Modify: `docs/superpowers/specs/2026-05-29-browser-tab-title-design.md`
- Modify: `CONTEXT.md`

- [x] **Step 1: Update the Precedence invariant**

In `docs/superpowers/specs/2026-05-29-browser-tab-title-design.md`, replace the existing `Precedence` invariant:

```markdown
- **Precedence**: 한 번의 `useDocumentTitle(code)` 호출이 결정하는 title은 `name (Symbol Master에 있을 때) ?? code ?? 'hoga-ops'` 순서. 근거: 훅 내 `??` 체인.
```

with:

```markdown
- **Precedence**: 한 번의 `useDocumentTitle(code)` 호출이 결정하는 title은 `(name (Symbol Master에 있을 때) ?? code)`를 base로 삼고, 해당 **Code**의 **Live Quote**가 있으면 `price`와 `change_pct`를 뒤에 붙인다. base가 없으면 `hoga-ops`. Live Quote가 없거나 `change_pct=null`이면 없는 필드는 생략한다.
```

- [x] **Step 2: Update the hook contract example**

Replace the hook contract example so it matches the quote-aware implementation from Task 2. The important changes are:

```ts
import { useQuoteByCode, type LiveQuote } from '../api/liveQuotes';

function formatTitleBase(base: string, quote: LiveQuote | undefined): string {
  if (!quote) return base;
  const parts = [base, quote.price.toLocaleString('ko-KR')];
  if (quote.change_pct !== null) {
    parts.push(`${quote.change_pct > 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%`);
  }
  return parts.join(' ');
}
```

and the final assignment should read:

```ts
document.title = base ? formatTitleBase(base, quote) : DEFAULT_TITLE;
```

- [x] **Step 3: Update edge cases**

In the edge-case table, replace the title rows for resolved names with these cases:

```markdown
| `code` present, name resolved, Live Quote present | `name price change_pct` (e.g. `삼성전자 71,200 +1.23%`) |
| `code` present, name resolved, Live Quote present but `change_pct=null` | `name price` (e.g. `삼성전자 71,200`) |
| `code` present, name resolved, Live Quote missing | name (e.g. `삼성전자`) |
```

- [x] **Step 4: Add the Browser Tab Title glossary entry**

In `CONTEXT.md`, add this entry near the other `/live` UI surface terms, before **Live Quote**:

```markdown
**Browser Tab Title**:
The browser chrome title (`document.title`) for the current hoga-ops page. On `/live`, it summarizes the active **Code** for quick OS/browser tab switching: `name price change_pct` when a **Live Quote** is available, `name`/`Code` fallback when it is not, and `hoga-ops` when there is no active Code. It is distinct from the in-app **Live Tab** label, which may include **Timeframe**/봉 labels and belongs to the `/live` tab strip UI.
_Avoid_: "tab label" alone (ambiguous with the in-app **Live Tab** label), "browser label" (too vague), putting 봉 labels here (kept out to preserve short OS/browser tab text).
```

- [x] **Step 5: Update the Live Quote glossary entry**

In `CONTEXT.md`, update the **Live Quote** paragraph so its consumer list includes the Browser Tab Title. Keep this as domain language, not implementation detail. Replace:

```markdown
and — 등락률(%)만 — on the **Live Status Bar** beside the active symbol's price.
```

with:

```markdown
and — 등락률(%)만 — on the **Live Status Bar** beside the active Code's chart price and in the **Browser Tab Title** beside the active Code's name.
```

Also append this sentence near the end of the same paragraph:

```markdown
The **Browser Tab Title** uses only `price` + `change_pct` from the Live Quote and omits 봉 labels and `change_won` to stay short.
```

- [x] **Step 6: Commit the spec and glossary update**

Run:

```bash
git add docs/superpowers/specs/2026-05-29-browser-tab-title-design.md CONTEXT.md
git commit -m "docs: amend browser tab title live quote contract"
```

---

### Task 4: Run Integration-Adjacent Frontend Checks

**Files:**
- Test: `frontend/src/util/useDocumentTitle.test.tsx`
- Test: `frontend/src/api/liveQuotes.test.tsx`
- Test: `frontend/src/live/LiveStatusBar.test.tsx`
- Test: `frontend/src/live/LivePage.test.tsx`

- [x] **Step 1: Add a LivePage browser title smoke test**

In `frontend/src/live/LivePage.test.tsx`, add this line to the existing `beforeEach` block:

```tsx
    document.title = 'before-test';
```

In `frontend/src/live/LivePage.test.tsx`, add this test near the existing `reads activeCode from ?code= query param` test:

```tsx
  it('sets the browser tab title from the active Code on /live', async () => {
    renderWithRouter('/live?code=005930');
    await waitFor(() => expect(document.title).toBe('005930'));
  });
```

This page-level test intentionally expects the raw Code, not the Symbol Master name or quote, because the shell test does not seed the symbols or live quote caches. The hook-level tests cover the richer title formatting; this smoke test only proves `/live` still wires its active Code into the sole title writer.

- [x] **Step 2: Run tests around the affected data paths**

Run:

```bash
cd frontend && npx vitest run \
  src/util/useDocumentTitle.test.tsx \
  src/api/liveQuotes.test.tsx \
  src/live/LiveStatusBar.test.tsx \
  src/live/LivePage.test.tsx
```

Expected: PASS. These cover the document title hook, live quote cache shape, the status bar's quote display, and `/live` mounting.

- [x] **Step 3: Run TypeScript build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS. `tsc -b` accepts the new `LiveQuote` type import and Vite builds the app.

- [x] **Step 4: Commit verification-only fixes if any were needed**

If Step 1 or Step 2 required code changes, run:

```bash
git add frontend/src/util/useDocumentTitle.ts frontend/src/util/useDocumentTitle.test.tsx
git commit -m "fix: stabilize browser title quote formatting"
```

If no changes were needed after Task 3, skip this commit.

---

## Self-Review

**Spec coverage:** The requested browser tab title format `종목명 가격 등락률%` is implemented by Task 2 through `formatTitleBase`. Timeframe suffixes stay out of the browser tab title to keep it short; in-app Live Tab labels still own 봉 labels. Task 3 updates the existing browser tab title spec so its Precedence invariant no longer conflicts with the new Live Quote suffix.

**Data source coverage:** No backend work is needed. `useQuoteByCode` already fetches `/api/live/quotes` and exposes `price` plus `change_pct`; the title uses the same 10-second quote source as watchlist/screener/status-bar quote displays.

**ADR coverage:** No new ADR is needed. This is a reversible Browser Tab Title formatting extension using the already-accepted **Live Quote** source (ADR-0056); Task 3 amends the existing browser tab title spec and glossary instead.

**Fallback coverage:** Null code, blank code, unknown symbols, Symbol Master loading, missing quote, and null `change_pct` all have explicit tests or preserved existing tests.

**Placeholder scan:** This plan contains no placeholder implementation steps. Every code change has exact file paths, code snippets, commands, and expected results.

**Type consistency:** `LiveQuote.price` and `LiveQuote.change_pct` match `frontend/src/api/liveQuotes.ts`. The query key seeded in tests is `['live-quotes', code]`, matching `useQuotes` for a single active code.

## Verification Performed While Writing This Plan

- Confirmed `frontend/src/util/useDocumentTitle.ts` is the sole browser title writer and currently formats symbol name/code plus optional timeframe; this plan removes the timeframe from the browser title.
- Confirmed `frontend/src/api/liveQuotes.ts` already exposes `LiveQuote.price` and `LiveQuote.change_pct`.
- Confirmed `frontend/src/live/LiveStatusBar.tsx` already consumes `useQuoteByCode` for the same active-code quote data.
- Confirmed focused frontend tests are run with `cd frontend && npx vitest run <test files>`.

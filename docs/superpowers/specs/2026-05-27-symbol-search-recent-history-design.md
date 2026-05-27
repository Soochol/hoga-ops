# Symbol Search — Recent History Dropdown

**Date**: 2026-05-27
**Surface**: `/capture` page → `SymbolSearch` component
**Status**: Design approved, ready for implementation plan

## Problem

On the `/capture` page, when a user clicks the symbol search input with no
text, the dropdown stays closed. To re-capture a symbol they recently looked
at, they must retype the name or remember the 6-digit code. Users who cycle
through a small set of symbols (e.g. tracking a watchlist's worth of stocks
across different date ranges) re-type the same names repeatedly.

## Goal

When the input is focused and empty, show up to 10 recently selected symbols
so the user can re-pick them with one click (or arrow-key + Enter).

## Out of Scope

- Server-side history syncing across browsers / accounts. localStorage is
  sufficient — capture is a per-machine workflow, and the existing project
  pattern (`forceRetryDefault.ts`) uses localStorage for capture-form prefs.
- Cross-feature history (e.g. sharing the list with Watchlist or Inventory
  symbol pickers). If demand emerges later, the storage module can be
  promoted; the hook contract is already feature-agnostic.
- Pinning, grouping, search-within-history, or fuzzy matching against
  history items. YAGNI for current capacity (10 items).

## What Gets Saved

**Trigger**: only confirmed selections — every call to the internal
`select(hit)` function in `SymbolSearch.tsx`. This includes:

- Clicking a dropdown row
- Pressing Enter on a highlighted dropdown row
- `promoteUnverifiedCode()` accepting a 6-digit code when the symbol cache
  is unavailable (the placeholder `SymbolHit` with `name='—'` is saved as
  well — on the next visit, if the cache recovers, the row will render with
  the real name automatically since we only store the code/name/market as a
  fallback and re-resolve from `useSymbols()` cache on render).

**Not saved**: raw typed queries, unsubmitted highlights, captures that
fail to start. The word "종목" (symbol/stock) implies a committed entity,
not a query string.

## Architecture

```
frontend/src/capture/
├── symbolHistory.ts          (new) localStorage I/O + LRU, pure functions
├── symbolHistory.test.ts     (new) JSON round-trip, LRU, corruption guards
├── useSymbolHistory.ts       (new) useSyncExternalStore + cache join
├── useSymbolHistory.test.tsx (new)
├── SymbolSearch.tsx          (modified) history branch in dropdown
└── SymbolSearch.test.tsx     (modified) new branch tests
```

### Storage layer (`symbolHistory.ts`)

- **Key**: `hoga.capture.symbolHistory.v1`. Version lives in the key so
  future schema changes don't have to migrate v1 — they read v2 and
  optionally clean up v1 (matching `tabsPersistence.ts` convention).
- **Shape**:
  ```ts
  type StoredEntry = {
    code: string;             // 6-digit
    name: string;             // fallback if cache miss
    market: 'KOSPI' | 'KOSDAQ';
    ts: number;               // ms epoch, used for LRU + future "X일 전" UI
  };
  type StoredV1 = StoredEntry[];  // newest first, max 10
  ```
- **API**:
  ```ts
  function read(): StoredEntry[];
  function add(entry: Omit<StoredEntry, 'ts'>): StoredEntry[];
  function remove(code: string): StoredEntry[];
  function clearAll(): void;
  ```
- **Guards**: `try/catch` around every `localStorage` call. Corrupt JSON
  (`JSON.parse` throw or Zod-style shape mismatch) → delete the key and
  return `[]`. localStorage unavailable (SSR, private mode quota) → in-memory
  fallback module-scoped variable; session-only but never throws.
- **LRU**: re-add of an existing code moves it to position 0 and refreshes
  `ts`. Length cap at 10 by slicing the tail. Uses `util/lru.ts` if its
  API fits; otherwise an inline `Array.filter` + `unshift` is fine for n=10.

### Hook layer (`useSymbolHistory.ts`)

```ts
function useSymbolHistory(): {
  recent: SymbolHit[];        // live-joined with useSymbols cache
  add(hit: SymbolHit): void;
  remove(code: string): void;
  clearAll(): void;
};
```

- Subscribes to localStorage via `useSyncExternalStore`. The subscriber
  listens for `storage` events (cross-tab) and a module-local event
  emitter (same-tab writes don't fire `storage` natively).
- On every snapshot, joins stored codes against `useSymbols()` data.
  `SymbolsData.symbols` is a `SymbolHit[]` array, so the hook builds a
  `Map<code, SymbolHit>` once per data change via `useMemo` and looks up
  each stored code in O(1).
  - **Cache hit**: returns the live `SymbolHit` (current `captured_count`,
    breakdown, market — all fresh).
  - **Cache miss**: returns a fallback `SymbolHit` using the stored
    `name`/`market` and `captured_count=0`, `breakdown` all zeros. UI
    renders `captured_count=0` as "no complete data" already — no special
    casing needed in the row component.
- The shape of the returned `SymbolHit[]` is identical to
  `useSymbolSearch`'s return, so `SymbolSearch.tsx` can render them
  through the same `SymbolRow` component.

### Component changes (`SymbolSearch.tsx`)

**New visibility predicate** (additive — does not change existing
`dropdownVisible`):

```ts
const historyVisible =
  open
  && query.length === 0
  && recent.length > 0
  && cacheStatus !== 'unavailable';
```

`historyVisible` and `dropdownVisible` are mutually exclusive by
construction (query length condition).

**`select()` hook** — call `addToHistory(hit)` from the existing `select`
function. The `promoteUnverifiedCode` path already routes through
`select()`, so unverified-code commits are captured automatically.

**Dropdown structure** when `historyVisible`:

```
┌────────────────────────────────────────────────────┐
│ 최근 검색                              전체 지우기  │  ← text-xs fg-dim
├────────────────────────────────────────────────────┤
│ <SymbolRow ... />  [×]                             │
│ <SymbolRow ... />  [×]                             │
│ <SymbolRow ... />  [×]                             │
└────────────────────────────────────────────────────┘
```

- Header: `<div>` with "최근 검색" label and "전체 지우기" text button.
  `text-xs text-fg-dim border-b border-border px-sm py-xs`. Per
  `DESIGN.md`, all colors/spacing come from tokens.
- Row: reuse `SymbolRow` exactly as-is for visual consistency with
  search results. Wrap it in a flex container that also holds a `×`
  remove button visible on hover/focus (per-row).
- `×` button: `onMouseDown={(e) => { e.preventDefault();
  e.stopPropagation(); remove(hit.code); }}`. The `preventDefault` keeps
  input focus; `stopPropagation` prevents the row's `onClick` from
  firing.
- "전체 지우기": `onMouseDown` with `preventDefault` + `clearAll()`.
  After clear, `recent.length === 0` → dropdown auto-closes via the
  visibility predicate.

**Keyboard**:

- `ArrowDown` / `ArrowUp`: reuse existing `highlight` state. The keydown
  handler currently branches on `dropdownVisible`; extend it to also
  branch on `historyVisible`. Both branches operate on the same
  `highlight` index against whichever list is rendered.
- `Enter`: highlighted history row → `select(recent[highlight])`. Reuses
  the existing Enter branch by computing the active list once at the
  top of `onKeyDown`.
- `Delete`: when `historyVisible`, remove the highlighted entry without
  closing the dropdown. Clamp `highlight` so it stays valid after the
  splice.
- `Escape`: closes dropdown (existing behavior).

**Empty state**: when `recent.length === 0`, the predicate is false →
no dropdown renders. No "you have no history yet" message — keeps the
empty-focus state visually quiet, matching current behavior.

**Unavailable cache**: the existing hint UI ("종목 목록 미가용 — 6자리
코드 입력...") wins. History is hidden in this mode so the user isn't
distracted from the fallback workflow.

## Edge Cases

| Case | Behavior |
|---|---|
| localStorage throws (SSR, quota) | In-memory fallback; session-only. Never throws to caller. |
| Corrupt JSON in storage | Delete key, return `[]`. Logged once. |
| Stored code missing from cache | Fallback `SymbolHit` from stored name/market; `captured_count=0`. |
| Same code re-selected | LRU: move to position 0, refresh `ts`. No duplicates. |
| Multi-tab race on write | Last writer wins. Acceptable: capture frequency is low. |
| Form reset (after Start) clears `value` | History dropdown shows automatically — user's just-captured symbol sits at row 0 for quick re-pick. |
| 6-digit unverified code committed | Saved with `name='—'`, `market='KOSPI'` (default from `promoteUnverifiedCode`). Heals on next render once cache is back. |

## Test Strategy (TDD order)

### Layer 1 — `symbolHistory.test.ts` (pure)

- empty state → `add()` → array of length 1
- `add()` same code twice → length 1, moved to position 0, `ts` refreshed
- `add()` 11 distinct codes → length 10, oldest dropped
- `remove(code)` → entry gone, others unchanged
- `clearAll()` → empty array, key cleared
- corrupt JSON in storage → returns `[]`, key cleared on next read
- localStorage throws on `setItem` → falls back to in-memory; subsequent
  `read()` reflects the in-memory state

### Layer 2 — `useSymbolHistory.test.tsx`

- with mocked `useSymbols` returning a known cache: stored codes resolve
  to live `SymbolHit` values
- cache miss for a stored code → fallback row with name/market from
  storage, `captured_count=0`
- `storage` event fires from another tab → component re-renders with
  new list
- same-tab `add()` → component re-renders (module event emitter path)

### Layer 3 — `SymbolSearch.test.tsx` (additions)

- empty history + focus → no dropdown
- has history + focus + empty input → "최근 검색" header + rows render
- typing 1 character → history hides, search results show (mutual
  exclusion holds)
- click history row → `onChange` called with that `SymbolHit`
- click `×` on a row → row disappears, `onChange` not called
- click "전체 지우기" → dropdown closes
- after `select()`, reset value, focus → that symbol is at row 0 of
  history
- `cacheStatus === 'unavailable'` → history hidden, hint UI shown
- ArrowDown + Enter on history → selects highlighted row
- Delete key on highlighted history row → removes that row, dropdown
  stays open with `highlight` clamped

## Non-Goals (explicit)

- No analytics on history usage.
- No "pin to top" or per-row metadata UI.
- No de-duplication across casing differences in code (codes are always
  6-digit numeric — case is not a concern).
- No migration from any prior storage key — this is the first version.

## Open Questions

None. All design decisions resolved during brainstorming.

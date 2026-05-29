# SymbolSearch — Recent Codes Dropdown

**Date**: 2026-05-27
**Surface**: `/capture` page → `SymbolSearch` component
**Status**: Design approved + grilled against CONTEXT.md (2026-05-27), ready for plan

## Glossary alignment (grilled)

This spec uses the canonical terms from `CONTEXT.md`:

- **Code** — the 6-digit KRX ticker (per the glossary's _Avoid_ rule against
  bare "symbol"). The thing this feature persists is a list of recently
  picked Codes, not "symbols".
- **Symbol Master** — the (Code, name, market) catalog. `SymbolSearch`,
  `useSymbols`, `SymbolHit`, `SymbolsAllResponse` are sanctioned class-name
  compounds and remain unchanged.
- **Recent Codes** — the new feature's working name (file/module:
  `recentCodes.ts` / `useRecentCodes.ts`). Not a new sanctioned compound:
  it's an internal implementation detail composed of the existing
  glossary terms. Does NOT require a CONTEXT.md entry.

## Problem

On the `/capture` page, when a user clicks the `SymbolSearch` input, the
dropdown does not surface previously picked Codes. To re-capture a Code
they recently worked with, they must retype the name or remember the 6
digits. Users who cycle through a small set of Codes (e.g. a watchlist's
worth across different date ranges) re-type the same names repeatedly.

## Goal

When the user clicks (focuses) the `SymbolSearch` input and is **not
actively typing a new query**, surface up to 10 recently confirmed Codes
so they can re-pick one with a click or arrow-key + Enter.

## Out of Scope

- Server-side history sync. localStorage is sufficient — capture is a
  per-machine workflow; existing capture-form prefs (`forceRetryDefault`)
  already use localStorage.
- Cross-feature reuse (Watchlist, Inventory pickers). The hook is
  feature-agnostic in shape but only wired into `SymbolSearch` for now.
- Pinning, grouping, search-within-history, fuzzy matching of history.
  YAGNI at n=10.

## What Gets Saved

**Trigger**: every call to the internal `select(hit)` function in
`SymbolSearch.tsx`. This includes:

- Clicking a dropdown row
- Pressing Enter on a highlighted dropdown row
- `promoteUnverifiedCode()` accepting a 6-digit Code when the Symbol
  Master cache is `unavailable` (the placeholder `SymbolHit` with
  `name='—'` is saved; on a later visit, when the cache recovers, the
  fallback name disappears because the resolved cache value wins).

**Not saved**: raw typed queries, unsubmitted highlights, captures that
fail to start.

## Architecture

```
frontend/src/capture/
├── recentCodes.ts          (new) localStorage I/O + LRU, pure functions
├── recentCodes.test.ts     (new) JSON round-trip, LRU, corruption guards
├── useRecentCodes.ts       (new) useSyncExternalStore + cache join
├── useRecentCodes.test.tsx (new)
├── SymbolSearch.tsx        (modified) Recent Codes branch + isTyping state
└── SymbolSearch.test.tsx   (modified) new branch tests
```

### Storage layer (`recentCodes.ts`)

- **Key**: `capture.recent_codes.v1`. Matches existing capture-feature key
  convention (`capture.force_retry_default`, `capture.leftPct`); no `hoga.`
  prefix (none of the existing keys use one). Version lives in the key so
  future schema changes don't have to migrate v1 (`tabsPersistence.ts`
  convention).
- **Shape**:
  ```ts
  type StoredEntry = {
    code: string;             // 6-digit
    name: string;             // fallback if Symbol Master cache miss
    market: 'KOSPI' | 'KOSDAQ';
    ts: number;               // ms epoch, LRU sort key
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
  → delete the key, return `[]`. localStorage unavailable (SSR, quota) →
  module-scoped in-memory fallback, session-only, never throws.
- **LRU**: re-add of an existing Code moves it to position 0 and refreshes
  `ts`. Length cap at 10 by slicing the tail. `util/lru.ts` is available
  but for n=10 an inline `Array.filter` + `unshift` is shorter — pick
  inline.

### Hook layer (`useRecentCodes.ts`)

Returns a **discriminated union** instead of a fabricated `SymbolHit[]`,
because "Code is in cache" and "Code is a stale fallback" are different
semantic states with different render contracts:

```ts
type RecentCodeRow =
  | { kind: 'resolved'; hit: SymbolHit }
  | { kind: 'fallback'; code: string; name: string; market: 'KOSPI' | 'KOSDAQ' };

function useRecentCodes(): {
  recent: RecentCodeRow[];
  add(hit: SymbolHit): void;
  remove(code: string): void;
  clearAll(): void;
};
```

- Subscribes to localStorage via `useSyncExternalStore`. Subscribers fire
  on (a) browser `storage` events (cross-tab) and (b) a module-local
  event emitter (same-tab writes do not fire `storage`).
- On every snapshot, joins stored Codes against `useSymbols()` data.
  `SymbolsData.symbols` is a `SymbolHit[]` array, so the hook builds a
  `Map<code, SymbolHit>` once per data change via `useMemo` and looks
  up each stored Code in O(1).
- **Cache hit** → `{ kind: 'resolved', hit }` where `hit.captured_count`
  reflects the current `useSymbols` cache state.
- **Cache miss** → `{ kind: 'fallback', code, name, market }` carrying
  what was stored at selection time. No fake `captured_count`; the row
  renderer shows `—` so the user sees "unknown" instead of a misleading
  "no complete data".

**Freshness contract** (corrected from prior wording): `useSymbols` has
`staleTime: ONE_DAY_MS` (per `useSymbols.ts:14`). A `captured_count`
shown in a resolved Recent Codes row is **as fresh as the Symbol Master
cache**, no more and no less — identical to what the main search
dropdown shows for the same Code. Refresh of the Symbol Master via the
SymbolSearch `Refresh` button or Settings updates both surfaces in
lockstep.

### Component changes (`SymbolSearch.tsx`)

**New `isTyping` state** — distinguishes "user is composing a query"
from "user has the input focused but isn't typing":

```ts
const [isTyping, setIsTyping] = useState(false);
```

- `onFocus` → `setIsTyping(false)`
- `onChange` (every keystroke) → `setIsTyping(true); setOpen(true)`
- `Escape` → existing close behavior + `setIsTyping(false)`
- `select(hit)` → existing close behavior + `setIsTyping(false)`

This is the load-bearing decision behind "click to see history" when the
input already holds a confirmed value: `CaptureForm` does not call
`setSymbol(null)` after Start, so the input keeps the prior selection's
text. With `isTyping`, focus reverts to history mode without forcing a
form reset.

**Visibility predicates** (mutually exclusive by construction):

```ts
const searchVisible =
  open && isTyping && query.length >= 1 && cacheStatus !== 'unavailable';

const historyVisible =
  open && !isTyping && recent.length > 0 && cacheStatus !== 'unavailable';
```

Both predicates require `open`. When the user lands focus on an input
that already shows `"<name> <code>"`, `isTyping === false` → history.
When they start typing, `isTyping → true` and `query.length >= 1` →
search results. The dropdown can never show both simultaneously.

**`select()` hook** — call `add(hit)` from inside `select`. The
`promoteUnverifiedCode` path already routes through `select()`, so
unverified-Code commits are captured automatically.

**Dropdown structure** when `historyVisible`:

```
┌────────────────────────────────────────────────────┐
│ 최근 검색                              전체 지우기  │  ← text-xs fg-dim
├────────────────────────────────────────────────────┤
│ <RecentRow row=... />                          [×] │
│ <RecentRow row=... />                          [×] │
│ <RecentRow row=... />                          [×] │
└────────────────────────────────────────────────────┘
```

- Header: "최근 검색" label + "전체 지우기" text button. Tokens only
  (`DESIGN.md` compliance): `text-xs text-fg-dim border-b border-border
  px-sm py-xs`.
- `RecentRow`: small wrapper component near `SymbolRow` in
  `SymbolSearch.tsx`. Renders the same 4-column grid as `SymbolRow`
  (`name | code | market | count`) for visual consistency. Branch on
  `row.kind`:
  - `'resolved'` → reuse `SymbolRow` exactly as today (same count text,
    same tooltip).
  - `'fallback'` → render name/code/market the same way, but the count
    column shows `—` (em-dash) in `text-fg-dimmer`. No tooltip.
- `×` button: `onMouseDown={(e) => { e.preventDefault();
  e.stopPropagation(); remove(code); }}`. `preventDefault` keeps input
  focus; `stopPropagation` prevents the row's `onClick` from firing.
- "전체 지우기": `onMouseDown` with `preventDefault` + `clearAll()`.
  After clear, `recent.length === 0` → dropdown closes via predicate.

**Keyboard** (extends existing handler):

- The keydown handler computes an `activeList` at the top:
  `historyVisible ? recent : (searchVisible ? hits : null)`.
- `ArrowDown` / `ArrowUp`: reuse `highlight`, clamped to `activeList.length`.
- `Enter`: if `activeList === recent` and a row is highlighted →
  `select(toSymbolHit(recent[highlight]))` where `toSymbolHit` returns
  `row.hit` for resolved rows and constructs a `SymbolHit` with
  `captured_count: 0, breakdown: zeros` ONLY for fallback rows (this is
  the existing behavior of `promoteUnverifiedCode` — the form proceeds
  with what we know).
- `Delete` when `historyVisible`: remove the highlighted row without
  closing the dropdown. Clamp `highlight`. Verified no conflict —
  capture-page files have no other `Delete` handlers.
- `Escape`: existing close behavior + reset `isTyping`.

**Empty state**: `recent.length === 0` → dropdown does not render. No
"no history yet" placeholder.

**Unavailable cache**: existing hint UI ("종목 목록 미가용 — 6자리
코드 입력...") wins; history is hidden so the fallback flow is not
diluted. (The user is in a degraded path; surfacing history would imply
they can use it normally.)

## Edge Cases

| Case | Behavior |
|---|---|
| localStorage throws (SSR, quota) | In-memory fallback; session-only, never throws. |
| Corrupt JSON in storage | Delete key, return `[]`. Logged once. |
| Stored Code missing from Symbol Master cache | `{ kind: 'fallback', ... }`; count column shows `—`. |
| Same Code re-selected | LRU: move to position 0, refresh `ts`. No duplicates. |
| Multi-tab race on write | Last writer wins. Acceptable — capture frequency is low. |
| `CaptureForm` retains symbol after Start | History reachable via `isTyping=false` on next focus — no form change needed. |
| 6-digit unverified Code committed via `promoteUnverifiedCode` | Saved with stored `name='—'`, `market='KOSPI'`. Heals on next render once the Symbol Master cache resolves the real name. |
| User clicks input while typing already in progress | `isTyping` already `true` → search results remain; clicking the input doesn't reset typing state (only `Escape` or `select` does). |

## Test Strategy (TDD order)

### Layer 1 — `recentCodes.test.ts` (pure)

- empty state → `add()` → length 1
- `add()` same Code twice → length 1, position 0, `ts` refreshed
- `add()` 11 distinct Codes → length 10, oldest dropped
- `remove(code)` → entry gone, others unchanged, ordering preserved
- `clearAll()` → empty array, key cleared
- corrupt JSON in storage → returns `[]`, key cleared on next read
- localStorage `setItem` throws → falls back to in-memory; later `read()`
  reflects the in-memory state

### Layer 2 — `useRecentCodes.test.tsx`

- with mocked `useSymbols` returning a known catalog: stored Codes
  resolve to `{ kind: 'resolved', hit }`
- cache miss for a stored Code → `{ kind: 'fallback', code, name, market }`
- `storage` event from another tab → component re-renders
- same-tab `add()` → component re-renders (module emitter path)
- `useSymbols` data changes (refresh) → resolved rows pick up new
  `captured_count` without `add`/`remove` being called

### Layer 3 — `SymbolSearch.test.tsx` (additions)

- empty history + focus → no dropdown
- has history + focus + empty input → "최근 검색" header + rows render
- has history + focus + input shows a confirmed `value` text →
  history still renders (`isTyping === false`)
- typing 1 character → `isTyping → true` → history hides, search results
  show
- click history row → `onChange` called with the row's `SymbolHit`
- click history fallback row → `onChange` called with a constructed
  placeholder `SymbolHit` (matching `promoteUnverifiedCode` semantics)
- click `×` on a row → row disappears, `onChange` not called, input
  retains focus
- click "전체 지우기" → dropdown closes
- after `select()`, the chosen Code is at position 0 of history
- `cacheStatus === 'unavailable'` → history hidden, existing hint UI
  visible
- ArrowDown + Enter on history → selects the highlighted row
- Delete key on highlighted history row → that row removed, dropdown
  stays open, `highlight` clamped

## Non-Goals (explicit)

- No analytics on history usage.
- No pin-to-top, no per-row metadata UI.
- No de-dup across casing differences in Code (Codes are 6-digit
  numeric; casing is N/A).
- No migration from any prior storage key — this is the first version.

## Open Questions

None. All design decisions resolved in brainstorming and the 2026-05-27
grill-with-docs pass.

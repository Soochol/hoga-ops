# attachPersistence helper — design

**Status:** Draft
**Date:** 2026-05-24
**Owner:** frontend

## Problem

After shipping `replay.tabs.v1` persistence, the codebase has **two adapters** of the same pattern:

| Store | Load | Save subscribe | Debounce | HMR dispose |
|---|---|---|---|---|
| `replayLayout.ts` | `loadPersisted()` inlined | inlined at module bottom | none | **missing** |
| `tabs.ts` | `loadPersisted()` via `tabsPersistence.ts` | inlined at module bottom | 250 ms | present |

Two adapters = a real seam (per the deepening principle "one adapter = hypothetical seam, two = real"). The pattern is:

1. On module load, hydrate initial store state from `localStorage`.
2. Subscribe to the store; on every change, serialize and write back.
3. Debounce writes to avoid thrashing on rapid mutations.
4. Dispose the subscription on Vite HMR.

`tabs.ts` does all four; `replayLayout.ts` does only 1+2 (no debounce, no HMR dispose — those are real gaps, not stylistic differences). The next persistent store will copy whichever of the two it spots first. The deepening opportunity is a single helper that owns the save-side pattern.

## Goal

A small helper module — `frontend/src/state/persistentSubscriber.ts` — exporting a single function:

```ts
attachPersistence<TState>(
  store: { subscribe: (listener: (state: TState) => void) => () => void },
  options: { storageKey: string; toSnapshot: (state: TState) => unknown; debounceMs?: number },
): () => void
```

Returns the unsubscribe function so callers can wire HMR dispose. The helper owns:
- The debounce timer (default 250 ms).
- The actual `localStorage.setItem(storageKey, JSON.stringify(snapshot))` call.
- Silent failure on `setItem` throw / SSR.

Migrate `replayLayout.ts` and `tabs.ts` to use the helper.

## Non-goals

- **Load side stays in the caller.** Each store has store-specific seed logic (`replayLayout` builds `Persisted`, `tabs` builds `{tabs, prefs, activeTabId}`). Pushing seed into the helper requires a polymorphic API; the win is small. Keep `loadPersisted()` as a per-store function and seed before calling the store factory.
- **No HMR magic.** The helper returns `unsubscribe`; the caller wires `import.meta.hot?.dispose(unsubscribe)`. Vite HMR is a per-module concern (`import.meta.hot` references the calling module, not the helper).
- **No `fromSnapshot` injection.** The helper does not know snapshot shapes. It only knows how to call `toSnapshot(state)` and `localStorage.setItem`.
- **No schema version / validation.** Versioning + validation stay in per-store load modules (`tabsPersistence.ts`, the inline `loadPersisted` in `replayLayout.ts`). The helper is save-only.
- **No new domain term.** `attachPersistence` is a pattern utility, not a CONTEXT.md concept.

## Architecture

### Module shape

```ts
// frontend/src/state/persistentSubscriber.ts

/** Minimum store shape we depend on — Zustand stores satisfy this naturally;
 *  test fakes can satisfy it too without pulling in Zustand. */
export type SubscribableStore<TState> = {
  subscribe(listener: (state: TState) => void): () => void;
};

export type PersistenceOptions<TState> = {
  /** localStorage key. Versioning lives in the key (e.g. `replay.tabs.v1`). */
  storageKey: string;
  /** Pure projection from store state to a JSON-serializable snapshot. */
  toSnapshot: (state: TState) => unknown;
  /** Debounce window for coalescing rapid writes. Default 250 ms. */
  debounceMs?: number;
};

/** Subscribes to `store`; on every state change, schedules a debounced
 *  `localStorage.setItem(storageKey, JSON.stringify(toSnapshot(state)))`.
 *  Silent on quota / SSR / serialization throw — matches the existing
 *  `savePersisted` policy in `tabsPersistence.ts` and `replayLayout.ts`.
 *
 *  Returns the unsubscribe function. Callers wire HMR dispose:
 *
 *  ```ts
 *  const unsubscribe = attachPersistence(useFooStore, { ... });
 *  if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
 *  ```
 */
export function attachPersistence<TState>(
  store: SubscribableStore<TState>,
  options: PersistenceOptions<TState>,
): () => void;
```

### Internal behavior

1. Module-scope timer per `attachPersistence` call (closure, not shared).
2. On every `state` from `store.subscribe`, `clearTimeout(timer)` → `setTimeout(write, debounceMs)`.
3. `write` calls `toSnapshot(state)` (re-reads current state via the closure — debounce stores the *latest* snapshot, not the snapshot at scheduling time, so the last write wins).
4. Returns `unsubscribe` that calls `store.subscribe`'s returned unsub AND clears the pending timer.

### Migration

**`tabs.ts`** — replace the manual `subscribe + setTimeout + clearTimeout + import.meta.hot.dispose` block at lines 250-276 with:

```ts
import { attachPersistence } from './persistentSubscriber';

const unsubscribePersist = attachPersistence(useTabsStore, {
  storageKey: STORAGE_KEY, // re-exported from tabsPersistence
  toSnapshot: (s) => toSnapshot({ tabs: s.tabs, activeTabId: s.activeTabId, prefs: s.prefs }),
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribePersist);
```

Net delta: ~20 lines removed, ~5 added. The `PERSIST_DEBOUNCE_MS`, `persistTimer`, manual `clearTimeout`/`setTimeout` machinery all disappear.

**`replayLayout.ts`** — replace the bare subscribe at lines 111-113 with:

```ts
import { attachPersistence } from './persistentSubscriber';

const unsubscribeLayout = attachPersistence(useReplayLayoutStore, {
  storageKey: STORAGE_KEY, // promote the local const to exported
  toSnapshot: (s) => ({ sidebarPx: s.sidebarPx, sidebarCollapsed: s.sidebarCollapsed }),
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeLayout);
```

Net delta: bare subscribe + manual `savePersisted` inline disappear; HMR dispose appears (fixing the gap). The `savePersisted` function in `replayLayout.ts` can be deleted — `attachPersistence` owns the write.

### What stays where

| Concern | Before | After |
|---|---|---|
| `localStorage.setItem` + try/catch | Each store (2 places) | `persistentSubscriber.ts` (1 place) |
| Debounce timer | `tabs.ts` only | `persistentSubscriber.ts` (both stores get it) |
| HMR dispose | `tabs.ts` only | Both stores (caller wires) |
| Versioned key constant | Each store | Unchanged — each store keeps its key |
| Load + validation | Each store | Unchanged — `tabsPersistence.ts`, inline in `replayLayout.ts` |
| Snapshot projection | Each store | Unchanged — passed in via `toSnapshot` |
| Snapshot validation / fallback | Each store | Unchanged — load-side concern, not save-side |

## Files

### Created
- `frontend/src/state/persistentSubscriber.ts` — the helper (≤ 60 LOC).
- `frontend/src/state/persistentSubscriber.test.ts` — unit tests with fake store + fake timers.

### Modified
- `frontend/src/state/tabs.ts` — replace inline persist block with `attachPersistence` call.
- `frontend/src/state/replayLayout.ts` — replace bare `subscribe` with `attachPersistence` call; delete the now-redundant inline `savePersisted` function; add HMR dispose.

### Tests touched
- `frontend/src/state/tabs.test.ts` — unchanged (integration tests still drive the live store; debounce behavior still proven via `vi.advanceTimersByTime(250)`).
- `frontend/src/state/replayLayout.test.ts` — verify no regressions; possibly add an HMR-style test using `vi.useFakeTimers` to assert debounce now applies if behavior change is observable. The existing rehydration tests stay valid.

## Behavior contracts (must hold post-migration)

1. **`replayLayout` gets a 250 ms debounce.** Previously every set fired immediately. This is a **behavior change** but a safe one — slider drag was already throttled by React rendering, and `localStorage.setItem` is synchronous I/O. A short debounce only delays the final write by ≤250 ms. The existing `replayLayout.test.ts` (5 tests) must continue to pass.
2. **`tabs` integration tests continue to pass** — 4 tests proving snapshot is written after 250 ms with content matching the latest state.
3. **HMR dispose is now uniform** — both stores' subscriptions get torn down on hot replace, no listener accumulation.
4. **Silent failure semantics preserved** — quota errors and SSR (`typeof localStorage === 'undefined'`) result in no-op, no throw.
5. **No load-side change** — `loadPersisted` shape, validation, fallback all unchanged.

## Edge cases

| Case | Behavior |
|---|---|
| `setItem` throws (quota / private mode) | Silent no-op inside helper's try/catch (matches both existing patterns). |
| `localStorage` undefined (SSR) | Helper checks `typeof localStorage === 'undefined'` before `setItem`; no-op. |
| `toSnapshot` throws | Caught in same try/catch; no-op (defensive — current code doesn't catch this, so the helper is strictly safer). |
| `JSON.stringify` throws (circular ref) | Same try/catch; no-op. |
| `debounceMs: 0` | Pass `setTimeout(fn, 0)` — schedules to microtask-ish; still coalesces synchronous bursts in same tick. Acceptable. (No callers will use 0; default is 250.) |
| Multiple `attachPersistence` calls with the same `storageKey` | Two timers, two writers — last write wins. Caller error, not helper concern. Document. |
| `unsubscribe` called twice | Second call is a no-op (`store.subscribe`'s unsub is idempotent; second `clearTimeout(null)` is a no-op). |
| Unsubscribe called while timer pending | Timer cleared; the pending write is dropped. This is correct — the caller has signaled "stop persisting". |
| HMR fires during pending write | `import.meta.hot.dispose(unsubscribe)` clears the pending timer before the module is replaced, so the new module's `attachPersistence` starts clean. |

## Testing

### Unit tests for `persistentSubscriber.ts` (with `vi.useFakeTimers`)

1. **Writes after debounce window** — set state → no write before `debounceMs` → write at `debounceMs`.
2. **Coalesces bursts** — three sets within `debounceMs` → exactly one `setItem` call, with the last state.
3. **Default debounce is 250 ms** — confirm when `debounceMs` omitted.
4. **Custom debounceMs** — pass 100, verify timer fires at 100.
5. **Unsubscribe cancels pending write** — set state → unsubscribe within `debounceMs` → no write.
6. **Unsubscribe is idempotent** — calling unsubscribe twice does not throw.
7. **`setItem` throw is swallowed** — stub throws QuotaExceededError; helper does not throw.
8. **SSR (`localStorage` undefined)** — does not throw on subscribe or on write.
9. **`toSnapshot` throw is swallowed** — pass a `toSnapshot` that throws; helper does not throw.
10. **Snapshot written is JSON-serialized** — assert `setItem(key, JSON.stringify(snap))` not raw object.

Use a hand-rolled fake store implementing `SubscribableStore<T>` — no Zustand dependency in this test file.

### Regression tests
- `tabs.test.ts` 17 tests — must all pass unchanged.
- `replayLayout.test.ts` 5+ tests — must all pass; if any depend on synchronous save, adjust to `vi.advanceTimersByTime(250)`.

### Manual
- Playwright re-verification: same 4 scenarios from the previous feature should still pass.

## Out of scope / 후속

- Helper for the load side. Each store's load is shaped differently; not enough commonality yet.
- Cross-tab `storage` event subscription. Same out-of-scope as the prior spec.
- Migration utility for schema bumps (`v1 → v2`). Same model — bump key, GC old.
- Telemetry / save-rate metrics. Add when needed.

## Open questions

None.

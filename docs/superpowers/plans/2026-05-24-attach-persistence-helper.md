# attachPersistence Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Extract the localStorage save-side pattern shared by `tabs.ts` and `replayLayout.ts` into a single `attachPersistence` helper in `frontend/src/state/persistentSubscriber.ts`. Migrate both stores. Net effect: persistence policy (debounce, silent failure) and HMR dispose live in one place; `replayLayout` gains the missing debounce + HMR dispose for free.

**Architecture:** Save-only helper. Each store keeps its own load + snapshot shape. The helper takes a `SubscribableStore<TState>` plus `{storageKey, toSnapshot, debounceMs?}` and returns an unsubscribe function. Caller wires `import.meta.hot?.dispose(unsubscribe)`.

**Tech Stack:** TypeScript, Zustand, Vitest (jsdom), Vite HMR.

**Spec:** [docs/superpowers/specs/2026-05-24-attach-persistence-helper-design.md](../specs/2026-05-24-attach-persistence-helper-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `frontend/src/state/persistentSubscriber.ts` | NEW | The helper: `attachPersistence` + types. ≤ 60 LOC. |
| `frontend/src/state/persistentSubscriber.test.ts` | NEW | Unit tests with fake store + fake timers (10 tests). |
| `frontend/src/state/tabs.ts` | MODIFY | Replace inline persist block (lines 250-276) with `attachPersistence` call. |
| `frontend/src/state/replayLayout.ts` | MODIFY | Replace bare `subscribe` (lines 111-113) with `attachPersistence` call; delete inline `savePersisted`; add HMR dispose. |
| `frontend/src/state/replayLayout.test.ts` | MAYBE MODIFY | If any test depends on synchronous save, switch to fake timers + `advanceTimersByTime(250)`. |

**Not touched:** `tabsPersistence.ts` (load + snapshot shapes unchanged), `tabs.test.ts` (integration tests still drive the live store).

---

## Task 1: Scaffold `persistentSubscriber.ts` with types + smoke test

**Files:**
- Create: `frontend/src/state/persistentSubscriber.ts`
- Create: `frontend/src/state/persistentSubscriber.test.ts`

- [ ] **Step 1: Write the smoke test**

Create `frontend/src/state/persistentSubscriber.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { attachPersistence } from './persistentSubscriber';

describe('persistentSubscriber — module scaffold', () => {
  it('exports attachPersistence as a function', () => {
    expect(typeof attachPersistence).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

From `frontend/`: `npx vitest run src/state/persistentSubscriber.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `frontend/src/state/persistentSubscriber.ts`:

```ts
/** Subscribe-side persistence helper. Owns the debounce timer, the
 *  `localStorage.setItem` call, and silent-failure semantics. Load is the
 *  caller's responsibility — each store's snapshot shape differs and
 *  validation lives next to its schema. */

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

const DEFAULT_DEBOUNCE_MS = 250;

/** Subscribes to `store`; debounce-writes `toSnapshot(state)` to
 *  `localStorage[storageKey]` on every state change. Returns the
 *  unsubscribe function. Callers wire HMR dispose:
 *
 *  ```ts
 *  const unsubscribe = attachPersistence(useFooStore, { ... });
 *  if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
 *  ```
 *
 *  Silent on quota / SSR / serialization throw — matches the previous
 *  `savePersisted` policy in `tabsPersistence.ts` / `replayLayout.ts`. */
export function attachPersistence<TState>(
  store: SubscribableStore<TState>,
  options: PersistenceOptions<TState>,
): () => void {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribeStore = store.subscribe((state) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (typeof localStorage === 'undefined') return;
      try {
        const snapshot = options.toSnapshot(state);
        localStorage.setItem(options.storageKey, JSON.stringify(snapshot));
      } catch {
        /* quota / private mode / serialization — silently ignore */
      }
    }, debounceMs);
  });

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribeStore();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/persistentSubscriber.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/persistentSubscriber.ts frontend/src/state/persistentSubscriber.test.ts
git commit -m "feat(state): scaffold attachPersistence helper + smoke test"
```

---

## Task 2: TDD core behavior — debounce + coalesce + JSON write

**Files:** `frontend/src/state/persistentSubscriber.test.ts` (extend)

- [ ] **Step 1: Add failing tests**

Append to `persistentSubscriber.test.ts`:

```ts
import { beforeEach, afterEach, vi } from 'vitest';
import type { SubscribableStore } from './persistentSubscriber';

function makeFakeStore<T>(initial: T): SubscribableStore<T> & { setState(next: T): void } {
  let state = initial;
  const listeners = new Set<(s: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(next) {
      state = next;
      listeners.forEach((l) => l(state));
    },
  };
}

describe('attachPersistence — debounce + write', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('writes a JSON snapshot after the default 250 ms debounce', () => {
    const store = makeFakeStore({ a: 1 });
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => ({ a: s.a }),
    });
    store.setState({ a: 2 });
    expect(localStorage.getItem('test.k')).toBeNull();
    vi.advanceTimersByTime(249);
    expect(localStorage.getItem('test.k')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(JSON.parse(localStorage.getItem('test.k')!)).toEqual({ a: 2 });
  });

  it('respects custom debounceMs', () => {
    const store = makeFakeStore({ a: 0 });
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
      debounceMs: 50,
    });
    store.setState({ a: 1 });
    vi.advanceTimersByTime(50);
    expect(JSON.parse(localStorage.getItem('test.k')!)).toEqual({ a: 1 });
  });

  it('coalesces bursts into a single write with the latest state', () => {
    const store = makeFakeStore({ a: 0 });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    store.setState({ a: 1 });
    vi.advanceTimersByTime(100);
    store.setState({ a: 2 });
    vi.advanceTimersByTime(100);
    store.setState({ a: 3 });
    expect(setItemSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('test.k')!)).toEqual({ a: 3 });
    setItemSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/state/persistentSubscriber.test.ts`
Expected: PASS, 4 tests total.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/state/persistentSubscriber.test.ts
git commit -m "test(state): attachPersistence debounce + coalescing behavior"
```

---

## Task 3: TDD unsubscribe + silent failure paths

**Files:** `frontend/src/state/persistentSubscriber.test.ts` (extend)

- [ ] **Step 1: Add failing tests**

Append:

```ts
describe('attachPersistence — unsubscribe + silent failure', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('unsubscribe cancels a pending write', () => {
    const store = makeFakeStore({ a: 0 });
    const unsub = attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    store.setState({ a: 1 });
    unsub();
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem('test.k')).toBeNull();
  });

  it('unsubscribe is idempotent', () => {
    const store = makeFakeStore({ a: 0 });
    const unsub = attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    expect(() => {
      unsub();
      unsub();
    }).not.toThrow();
  });

  it('unsubscribe detaches the listener (no further writes)', () => {
    const store = makeFakeStore({ a: 0 });
    const unsub = attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: (s) => s,
    });
    unsub();
    store.setState({ a: 99 });
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem('test.k')).toBeNull();
  });

  it('silently swallows setItem throw (quota / private mode)', () => {
    const store = makeFakeStore({ a: 0 });
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    attachPersistence(store, { storageKey: 'test.k', toSnapshot: (s) => s });
    store.setState({ a: 1 });
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(setItemSpy).toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('silently swallows toSnapshot throw', () => {
    const store = makeFakeStore({ a: 0 });
    attachPersistence(store, {
      storageKey: 'test.k',
      toSnapshot: () => { throw new Error('boom'); },
    });
    store.setState({ a: 1 });
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    expect(localStorage.getItem('test.k')).toBeNull();
  });

  it('silently no-ops when localStorage is undefined (SSR)', () => {
    const store = makeFakeStore({ a: 0 });
    const orig = globalThis.localStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).localStorage;
    try {
      expect(() => {
        attachPersistence(store, { storageKey: 'test.k', toSnapshot: (s) => s });
        store.setState({ a: 1 });
        vi.advanceTimersByTime(250);
      }).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/state/persistentSubscriber.test.ts`
Expected: PASS, 10 tests total.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/state/persistentSubscriber.test.ts
git commit -m "test(state): attachPersistence unsubscribe + silent failure paths"
```

---

## Task 4: Migrate `tabs.ts` to use `attachPersistence`

**Files:** `frontend/src/state/tabs.ts`

- [ ] **Step 1: Read the current persistence block**

Run: `sed -n '250,276p' frontend/src/state/tabs.ts`
Expected: shows the manual subscribe + setTimeout/clearTimeout + HMR dispose block.

- [ ] **Step 2: Add the import**

Below the existing `import { loadPersisted, ... } from './tabsPersistence';` line, add:

```ts
import { attachPersistence } from './persistentSubscriber';
```

- [ ] **Step 3: Replace the persistence block**

Replace lines 250-276 (the entire `PERSIST_DEBOUNCE_MS` constant, `persistTimer` variable, manual `subscribe`, and the `import.meta.hot` block) with:

```ts
/** Debounced persistence — every store mutation schedules a save 250ms out.
 *  See spec §"Save 디바운싱" for rationale. */
const unsubscribePersist = attachPersistence(useTabsStore, {
  storageKey: STORAGE_KEY,
  toSnapshot: (s) =>
    toSnapshot({ tabs: s.tabs, activeTabId: s.activeTabId, prefs: s.prefs }),
});

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribePersist);
}
```

You'll need `STORAGE_KEY` imported from `./tabsPersistence` — it should already be exported there. Add it to the existing import line: `import { loadPersisted, savePersisted, toSnapshot, fromSnapshot, STORAGE_KEY, type SnapshotDeps } from './tabsPersistence';`. Drop `savePersisted` from the import — no longer used here.

- [ ] **Step 4: Run the persistence test + tabs integration tests**

```bash
npx vitest run src/state/persistentSubscriber.test.ts src/state/tabsPersistence.test.ts src/state/tabs.test.ts
```

Expected: all green. Specifically tabs.test.ts integration tests (4 with fake timers) must still pass.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b` from `frontend/`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/state/tabs.ts
git commit -m "refactor(state): tabs.ts uses attachPersistence helper"
```

---

## Task 5: Migrate `replayLayout.ts` + delete inline `savePersisted`

**Files:** `frontend/src/state/replayLayout.ts`, possibly `frontend/src/state/replayLayout.test.ts`

- [ ] **Step 1: Read the current file structure**

Run: `sed -n '50,113p' frontend/src/state/replayLayout.ts`

You'll see:
- `STORAGE_KEY` const (private)
- `type Persisted`
- `loadPersisted()` function
- `savePersisted()` function (to be deleted)
- The store `useReplayLayoutStore`
- The bare `subscribe(...)` block at the bottom (to be replaced)

- [ ] **Step 2: Add the import**

At the top, with other imports:

```ts
import { attachPersistence } from './persistentSubscriber';
```

- [ ] **Step 3: Delete the inline `savePersisted` function**

Remove the entire `function savePersisted(p: Persisted): void { ... }` block (around lines 79-86). The helper owns this now.

- [ ] **Step 4: Replace the bare subscribe block**

Replace the current bottom block:

```ts
// Persistence subscriber: writes the persisted slice on every change.
// Registered once at module load; survives HMR via zustand's stable store identity.
useReplayLayoutStore.subscribe((state) => {
  savePersisted({ sidebarPx: state.sidebarPx, sidebarCollapsed: state.sidebarCollapsed });
});
```

with:

```ts
/** Debounced persistence + HMR dispose via the shared helper. */
const unsubscribeLayout = attachPersistence(useReplayLayoutStore, {
  storageKey: STORAGE_KEY,
  toSnapshot: (s) => ({ sidebarPx: s.sidebarPx, sidebarCollapsed: s.sidebarCollapsed }),
});

if (import.meta.hot) {
  import.meta.hot.dispose(unsubscribeLayout);
}
```

- [ ] **Step 5: Run replayLayout tests — adjust if needed**

Run: `npx vitest run src/state/replayLayout.test.ts`

If any test depends on `localStorage` being updated synchronously after a `setSidebarPx` / `setSidebarCollapsed` call, switch that test to use fake timers:

```ts
import { vi } from 'vitest';
// inside the test
vi.useFakeTimers();
useReplayLayoutStore.getState().setSidebarPx(380);
vi.advanceTimersByTime(250);
const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
expect(stored.sidebarPx).toBe(380);
vi.useRealTimers();
```

The existing rehydration tests (which write to localStorage *before* importing the module) are unaffected — they exercise the load side.

- [ ] **Step 6: Run the full state/ suite + typecheck + lint**

```bash
npx vitest run src/state/
npx tsc -b
npx eslint src/state/persistentSubscriber.ts src/state/persistentSubscriber.test.ts src/state/replayLayout.ts src/state/replayLayout.test.ts src/state/tabs.ts
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/state/replayLayout.ts frontend/src/state/replayLayout.test.ts
git commit -m "refactor(state): replayLayout uses attachPersistence (gains debounce + HMR dispose)"
```

(If `replayLayout.test.ts` was not changed, drop it from the `git add`.)

---

## Task 6: Full sweep + manual verify

**Files:** none (verification only).

- [ ] **Step 1: Full vitest suite**

From `frontend/`: `npx vitest run`. Expected: 583 + 10 new = ~593 tests passing.

- [ ] **Step 2: Typecheck + lint**

```bash
npx tsc -b
npx eslint src/state/
```

Expected: clean.

- [ ] **Step 3: Manual Playwright spot-check**

(Only if a previous session's dev servers are still running. Otherwise skip — the unit + integration coverage is the contract.)

Navigate to `http://localhost:5173/replay`. Change sidebar width (drag splitter) and a tab pref (e.g. flip Auction Mask in Settings). Within 1s, verify in DevTools:
- `replay.layout` reflects new sidebarPx
- `replay.tabs.v1` reflects new prefs

Reload page. Both settings restored.

- [ ] **Step 4: If anything failed, fix in place and re-run; otherwise this task produces no commit.**

---

## Out of scope (per spec)
- Helper for the load side.
- Cross-tab `storage` event subscription.
- Schema migration utility.

## Self-Review Notes

- **Spec coverage**: helper API (Task 1), debounce (Task 2), unsubscribe + silent failure (Task 3), tabs migration (Task 4), replayLayout migration (Task 5), sweep (Task 6). All covered.
- **Type consistency**: `SubscribableStore<TState>`, `PersistenceOptions<TState>`, `attachPersistence` — consistent across all tasks.
- **Behavior change flagged**: `replayLayout` gains a 250 ms debounce. Spec called this out; Task 5 step 5 explicitly handles test fallout.
- **Net code reduction**: ~25 lines deleted across `tabs.ts` + `replayLayout.ts`, replaced by ~10 lines of attachPersistence wiring. Helper itself is ~50 LOC. Tests are ~150 LOC. Net feature-area code is roughly flat; the win is consolidation, not LOC.

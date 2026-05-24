# Replay Tab Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `/replay` tabs (selection + chart prefs) to `localStorage["replay.tabs.v1"]` so that the last session survives clean re-entry (`/replay` without URL params), not just F5.

**Architecture:** Follow the existing `replayLayout.ts` pattern — a pure persistence module (`tabsPersistence.ts`) plus a module-load-time `subscribe()` hook in `tabs.ts` that writes on every change (debounced 250 ms). On load, URL is the source of truth; localStorage is the fallback. Cross-module deps go in one direction only (`tabs.ts` → `tabsPersistence.ts`); the persistence module type-imports from `tabs.ts` and takes runtime deps (DEFAULT_PREFS, freshTab) as parameters to keep modules acyclic.

**Tech Stack:** TypeScript, Zustand, Vitest (jsdom), `nanoid`, Vite HMR.

**Spec:** [docs/superpowers/specs/2026-05-24-replay-tab-persistence-design.md](../specs/2026-05-24-replay-tab-persistence-design.md)

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `frontend/src/state/tabsPersistence.ts` | NEW | Pure serialize/deserialize/validate. No `nanoid`, no Zustand. Runtime deps injected. |
| `frontend/src/state/tabsPersistence.test.ts` | NEW | Unit tests for the pure module. |
| `frontend/src/state/tabs.ts` | MODIFY | Seed initial state from `loadPersisted()`. Add debounced `subscribe()` save. HMR dispose guard. |
| `frontend/src/state/tabs.test.ts` | MODIFY | Add integration tests for save/load wiring. |
| `frontend/src/pages/ReplayViewer.tsx` | MODIFY | `useUrlSync`: when URL is empty, skip the `reset()` + hydrate path (store is already seeded from localStorage at module load). |

**Files explicitly NOT touched:** `state/url.ts`, `state/toolbarDraft.ts`, `state/replayLayout.ts`.

---

## Task 1: Scaffold `tabsPersistence.ts` with types + `STORAGE_KEY`

**Files:**
- Create: `frontend/src/state/tabsPersistence.ts`
- Create: `frontend/src/state/tabsPersistence.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `frontend/src/state/tabsPersistence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { STORAGE_KEY } from './tabsPersistence';

describe('tabsPersistence — module scaffold', () => {
  it('exports STORAGE_KEY = "replay.tabs.v1"', () => {
    expect(STORAGE_KEY).toBe('replay.tabs.v1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module with types + constant**

Create `frontend/src/state/tabsPersistence.ts`:

```ts
import type { Tab, TabSelection, ChartViewPrefs } from './tabs';

/** Versioned storage key. Schema-breaking changes bump the suffix and let
 *  the previous key be garbage-collected naturally — no migration code. */
export const STORAGE_KEY = 'replay.tabs.v1';

/** Per-tab snapshot. `prefs` is `Partial` because forward-compat merge against
 *  `DEFAULT_PREFS` at load time tolerates schema additions. */
export type PersistedTab = {
  selection: TabSelection | null;
  prefs: Partial<ChartViewPrefs>;
};

export type ReplayTabsSnapshot = {
  version: 1;
  savedAt: number;
  activeIndex: number;
  tabs: PersistedTab[];
};

/** Runtime dependencies injected by `tabs.ts` so `tabsPersistence` stays
 *  acyclic with respect to value imports. */
export type SnapshotDeps = {
  defaultPrefs: ChartViewPrefs;
  freshTab: () => Tab;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(replay): scaffold tabsPersistence module + STORAGE_KEY"
```

---

## Task 2: TDD `toSnapshot` — Tab[] → ReplayTabsSnapshot

**Files:**
- Modify: `frontend/src/state/tabsPersistence.ts`
- Modify: `frontend/src/state/tabsPersistence.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `tabsPersistence.test.ts`:

```ts
import { toSnapshot } from './tabsPersistence';
import type { Tab, ChartViewPrefs } from './tabs';

const defaultPrefs: ChartViewPrefs = {
  volumeProfileMode: 'range',
  movingAverages: [
    { period: 5, enabled: true },
    { period: 10, enabled: true },
    { period: 20, enabled: true },
    { period: 60, enabled: true },
    { period: 120, enabled: true },
  ],
  auctionWindowMask: true,
};

describe('toSnapshot', () => {
  it('serializes selection + prefs, excludes bundles/cursorMs/status/id', () => {
    const tab1: Tab = {
      id: 'tab-id-1',
      selection: { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m' },
      cursorMs: 1_700_000_000_000,
      status: 'loaded',
      bundles: new Map([['20260512', {} as never]]),
    };
    const tab2: Tab = {
      id: 'tab-id-2',
      selection: null,
      cursorMs: null,
      status: 'empty',
      bundles: new Map(),
    };
    const prefs = new Map<string, ChartViewPrefs>([
      ['tab-id-1', { ...defaultPrefs, volumeProfileMode: 'per-day' }],
    ]);
    const snap = toSnapshot({
      tabs: [tab1, tab2],
      activeTabId: 'tab-id-2',
      prefs,
      defaultPrefs,
    });
    expect(snap.version).toBe(1);
    expect(typeof snap.savedAt).toBe('number');
    expect(snap.activeIndex).toBe(1);
    expect(snap.tabs).toHaveLength(2);
    expect(snap.tabs[0].selection).toEqual({
      code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m',
    });
    expect(snap.tabs[0].prefs.volumeProfileMode).toBe('per-day');
    expect(snap.tabs[1].selection).toBeNull();
    // Tabs without entries in `prefs` fall back to defaults.
    expect(snap.tabs[1].prefs.volumeProfileMode).toBe('range');
    // No bundles/cursorMs/status/id leakage.
    expect(JSON.stringify(snap)).not.toContain('cursorMs');
    expect(JSON.stringify(snap)).not.toContain('bundles');
    expect(JSON.stringify(snap)).not.toContain('tab-id-1');
  });

  it('clamps activeIndex to 0 when activeTabId not found', () => {
    const tab: Tab = { id: 'a', selection: null, cursorMs: null, status: 'empty', bundles: new Map() };
    const snap = toSnapshot({
      tabs: [tab],
      activeTabId: 'nonexistent',
      prefs: new Map(),
      defaultPrefs,
    });
    expect(snap.activeIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: FAIL — `toSnapshot` not exported.

- [ ] **Step 3: Implement `toSnapshot`**

Append to `tabsPersistence.ts`:

```ts
export type ToSnapshotInput = {
  tabs: readonly Tab[];
  activeTabId: string;
  prefs: ReadonlyMap<string, ChartViewPrefs>;
  defaultPrefs: ChartViewPrefs;
};

/** Pure projection: live store state → durable snapshot.
 *  Excludes bundles / cursorMs / status / id — see spec table. */
export function toSnapshot(input: ToSnapshotInput): ReplayTabsSnapshot {
  const { tabs, activeTabId, prefs, defaultPrefs } = input;
  const foundIdx = tabs.findIndex((t) => t.id === activeTabId);
  const activeIndex = foundIdx >= 0 ? foundIdx : 0;
  return {
    version: 1,
    savedAt: Date.now(),
    activeIndex,
    tabs: tabs.map((t) => ({
      selection: t.selection,
      prefs: prefs.get(t.id) ?? defaultPrefs,
    })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(replay): toSnapshot serializes tabs + prefs, drops volatile fields"
```

---

## Task 3: TDD selection + prefs validators

**Files:**
- Modify: `frontend/src/state/tabsPersistence.ts`
- Modify: `frontend/src/state/tabsPersistence.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tabsPersistence.test.ts`:

```ts
import { validateSelection, mergePrefs } from './tabsPersistence';

describe('validateSelection', () => {
  it('returns the value when all fields valid', () => {
    const sel = { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m' };
    expect(validateSelection(sel)).toEqual(sel);
  });
  it('returns null for null input', () => {
    expect(validateSelection(null)).toBeNull();
  });
  it('returns null when code is not 6 digits', () => {
    expect(validateSelection({ code: '5930', fromDate: '20260512', toDate: '20260512', timeframe: '1m' })).toBeNull();
  });
  it('returns null when date is not 8 digits', () => {
    expect(validateSelection({ code: '005930', fromDate: '2026-05-12', toDate: '20260512', timeframe: '1m' })).toBeNull();
  });
  it('returns null when timeframe is not in TIMEFRAME_LABELS', () => {
    expect(validateSelection({ code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '99m' })).toBeNull();
  });
  it('returns null for non-object input', () => {
    expect(validateSelection('whatever' as unknown)).toBeNull();
    expect(validateSelection(undefined as unknown)).toBeNull();
  });
});

describe('mergePrefs', () => {
  it('returns defaults when given an empty object', () => {
    expect(mergePrefs({}, defaultPrefs)).toEqual(defaultPrefs);
  });
  it('overrides known scalar keys', () => {
    const merged = mergePrefs({ volumeProfileMode: 'per-day', auctionWindowMask: false }, defaultPrefs);
    expect(merged.volumeProfileMode).toBe('per-day');
    expect(merged.auctionWindowMask).toBe(false);
  });
  it('ignores unknown volumeProfileMode value', () => {
    const merged = mergePrefs({ volumeProfileMode: 'galaxy' as never }, defaultPrefs);
    expect(merged.volumeProfileMode).toBe('range');
  });
  it('ignores non-boolean auctionWindowMask', () => {
    const merged = mergePrefs({ auctionWindowMask: 'yes' as never }, defaultPrefs);
    expect(merged.auctionWindowMask).toBe(true);
  });
  it('replaces movingAverages wholesale when length differs from default', () => {
    const merged = mergePrefs(
      { movingAverages: [{ period: 7, enabled: true }] as never },
      defaultPrefs,
    );
    expect(merged.movingAverages).toEqual(defaultPrefs.movingAverages);
  });
  it('replaces movingAverages wholesale when an element is malformed', () => {
    const broken = defaultPrefs.movingAverages.map((m, i) =>
      i === 0 ? ({ period: 'x', enabled: true } as never) : m,
    );
    const merged = mergePrefs({ movingAverages: broken }, defaultPrefs);
    expect(merged.movingAverages).toEqual(defaultPrefs.movingAverages);
  });
  it('accepts a fully-shaped movingAverages array', () => {
    const custom = defaultPrefs.movingAverages.map((m) => ({ ...m, enabled: false }));
    const merged = mergePrefs({ movingAverages: custom }, defaultPrefs);
    expect(merged.movingAverages).toEqual(custom);
  });
  it('drops unknown keys silently', () => {
    const merged = mergePrefs({ futureKey: 42 } as never, defaultPrefs);
    expect((merged as Record<string, unknown>).futureKey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: FAIL — `validateSelection`, `mergePrefs` not exported.

- [ ] **Step 3: Implement validators**

Append to `tabsPersistence.ts`:

```ts
import { TIMEFRAME_LABELS, type Timeframe } from '../api/types';

const TIMEFRAME_SET = new Set<string>(TIMEFRAME_LABELS);
const CODE_RE = /^\d{6}$/;
const DATE_RE = /^\d{8}$/;

/** Returns `value` iff every field is valid; otherwise `null`. Used at load
 *  time to defang malformed entries without dropping the whole tab. */
export function validateSelection(value: unknown): TabSelection | null {
  if (value === null) return null;
  if (typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || !CODE_RE.test(v.code)) return null;
  if (typeof v.fromDate !== 'string' || !DATE_RE.test(v.fromDate)) return null;
  if (typeof v.toDate !== 'string' || !DATE_RE.test(v.toDate)) return null;
  if (typeof v.timeframe !== 'string' || !TIMEFRAME_SET.has(v.timeframe)) return null;
  return {
    code: v.code,
    fromDate: v.fromDate,
    toDate: v.toDate,
    timeframe: v.timeframe as Timeframe,
  };
}

const VOLUME_PROFILE_MODES = new Set(['range', 'per-day'] as const);

function isValidMA(m: unknown): m is { period: number; enabled: boolean } {
  if (m === null || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return typeof o.period === 'number' && Number.isFinite(o.period) && typeof o.enabled === 'boolean';
}

/** Merge a `Partial<ChartViewPrefs>` over `defaults`. Unknown keys ignored;
 *  malformed values fall back to the default for that key. */
export function mergePrefs(
  partial: Partial<ChartViewPrefs> | undefined,
  defaults: ChartViewPrefs,
): ChartViewPrefs {
  const p = (partial ?? {}) as Record<string, unknown>;
  const out: ChartViewPrefs = {
    volumeProfileMode: defaults.volumeProfileMode,
    movingAverages: defaults.movingAverages.map((m) => ({ ...m })),
    auctionWindowMask: defaults.auctionWindowMask,
  };
  if (typeof p.volumeProfileMode === 'string'
      && VOLUME_PROFILE_MODES.has(p.volumeProfileMode as 'range' | 'per-day')) {
    out.volumeProfileMode = p.volumeProfileMode as 'range' | 'per-day';
  }
  if (typeof p.auctionWindowMask === 'boolean') {
    out.auctionWindowMask = p.auctionWindowMask;
  }
  if (
    Array.isArray(p.movingAverages)
    && p.movingAverages.length === defaults.movingAverages.length
    && p.movingAverages.every(isValidMA)
  ) {
    out.movingAverages = p.movingAverages.map((m) => ({ ...(m as { period: number; enabled: boolean }) }));
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS, all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(replay): selection/prefs validators with forward-compat merge"
```

---

## Task 4: TDD `loadPersisted` (JSON parse + version + tabs validation)

**Files:**
- Modify: `frontend/src/state/tabsPersistence.ts`
- Modify: `frontend/src/state/tabsPersistence.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tabsPersistence.test.ts`:

```ts
import { loadPersisted } from './tabsPersistence';

describe('loadPersisted', () => {
  beforeEach(() => localStorage.clear());

  it('returns null when the key is absent', () => {
    expect(loadPersisted()).toBeNull();
  });

  it('returns null when JSON is corrupt', () => {
    localStorage.setItem('replay.tabs.v1', '{not json');
    expect(loadPersisted()).toBeNull();
  });

  it('returns null when version is missing or wrong', () => {
    localStorage.setItem('replay.tabs.v1', JSON.stringify({ version: 2, tabs: [], activeIndex: 0 }));
    expect(loadPersisted()).toBeNull();
    localStorage.setItem('replay.tabs.v1', JSON.stringify({ tabs: [], activeIndex: 0 }));
    expect(loadPersisted()).toBeNull();
  });

  it('returns null when tabs is not an array', () => {
    localStorage.setItem('replay.tabs.v1', JSON.stringify({ version: 1, tabs: 'nope', activeIndex: 0 }));
    expect(loadPersisted()).toBeNull();
  });

  it('returns the snapshot on a valid payload, preserving tabs verbatim', () => {
    const payload: ReplayTabsSnapshot = {
      version: 1,
      savedAt: 1_700_000_000_000,
      activeIndex: 0,
      tabs: [
        {
          selection: { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '5m' },
          prefs: { volumeProfileMode: 'per-day' },
        },
      ],
    };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out).not.toBeNull();
    expect(out!.tabs).toHaveLength(1);
    expect(out!.tabs[0].selection?.code).toBe('005930');
    expect(out!.tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('coerces invalid selection to null (preserves tab + its prefs)', () => {
    const payload = {
      version: 1, savedAt: 0, activeIndex: 0,
      tabs: [
        {
          selection: { code: 'BAD', fromDate: '20260512', toDate: '20260512', timeframe: '1m' },
          prefs: { volumeProfileMode: 'per-day' },
        },
      ],
    };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out!.tabs[0].selection).toBeNull();
    expect(out!.tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('returns null when localStorage is unavailable', () => {
    const orig = globalThis.localStorage;
    // @ts-expect-error — simulating SSR/private mode
    delete (globalThis as Record<string, unknown>).localStorage;
    try {
      expect(loadPersisted()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
    }
  });

  it('clamps activeIndex into [0, tabs.length-1]', () => {
    const payload = {
      version: 1, savedAt: 0, activeIndex: 99,
      tabs: [{ selection: null, prefs: {} }, { selection: null, prefs: {} }],
    };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out!.activeIndex).toBe(0);
  });

  it('accepts an empty tabs array (caller seeds fallback)', () => {
    const payload = { version: 1, savedAt: 0, activeIndex: 0, tabs: [] };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out!.tabs).toHaveLength(0);
    expect(out!.activeIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: FAIL — `loadPersisted` not exported.

- [ ] **Step 3: Implement `loadPersisted`**

Append to `tabsPersistence.ts`:

```ts
/** Reads + validates the v1 payload. Returns `null` when absent, corrupt, or
 *  version-mismatched. Entry-level salvage (invalid selection → null,
 *  malformed prefs → default-merged) happens here; the caller is responsible
 *  for the "empty tabs → seed a fresh tab" fallback because it needs runtime
 *  deps (`nanoid`) that this pure module avoids. */
export function loadPersisted(): ReplayTabsSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1) return null;
  if (!Array.isArray(p.tabs)) return null;
  const tabs: PersistedTab[] = p.tabs.map((entry) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return {
      selection: validateSelection(e.selection),
      // mergePrefs runs at hydrate time; here we just keep the raw partial.
      prefs: (e.prefs && typeof e.prefs === 'object'
        ? (e.prefs as Partial<ChartViewPrefs>)
        : {}),
    };
  });
  const activeIndexRaw = typeof p.activeIndex === 'number' ? p.activeIndex : 0;
  const activeIndex = tabs.length === 0
    ? 0
    : Math.min(Math.max(0, Math.floor(activeIndexRaw)), tabs.length - 1);
  const savedAt = typeof p.savedAt === 'number' ? p.savedAt : 0;
  return { version: 1, savedAt, activeIndex, tabs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(replay): loadPersisted with version + entry-level validation"
```

---

## Task 5: TDD `savePersisted`

**Files:**
- Modify: `frontend/src/state/tabsPersistence.ts`
- Modify: `frontend/src/state/tabsPersistence.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tabsPersistence.test.ts`:

```ts
import { savePersisted } from './tabsPersistence';

describe('savePersisted', () => {
  beforeEach(() => localStorage.clear());

  it('writes a JSON payload under STORAGE_KEY', () => {
    const snap: ReplayTabsSnapshot = {
      version: 1, savedAt: 123, activeIndex: 0,
      tabs: [{ selection: null, prefs: { volumeProfileMode: 'per-day' } }],
    };
    savePersisted(snap);
    const raw = localStorage.getItem('replay.tabs.v1');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('silently no-ops when localStorage.setItem throws (quota / private mode)', () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    try {
      expect(() =>
        savePersisted({ version: 1, savedAt: 0, activeIndex: 0, tabs: [] }),
      ).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });

  it('silently no-ops when localStorage is undefined', () => {
    const orig = globalThis.localStorage;
    // @ts-expect-error — simulating SSR
    delete (globalThis as Record<string, unknown>).localStorage;
    try {
      expect(() =>
        savePersisted({ version: 1, savedAt: 0, activeIndex: 0, tabs: [] }),
      ).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: FAIL — `savePersisted` not exported.

- [ ] **Step 3: Implement `savePersisted`**

Append to `tabsPersistence.ts`:

```ts
export function savePersisted(snapshot: ReplayTabsSnapshot): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* privacy mode / quota — silently ignore (matches replayLayout pattern). */
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(replay): savePersisted with silent failure on quota/SSR"
```

---

## Task 6: TDD `fromSnapshot` — snapshot → `{ tabs, prefs, activeTabId }`

`fromSnapshot` is the runtime hydration step. It needs `nanoid` and the `fresh()` factory from `tabs.ts`, both injected via `SnapshotDeps`.

**Files:**
- Modify: `frontend/src/state/tabsPersistence.ts`
- Modify: `frontend/src/state/tabsPersistence.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tabsPersistence.test.ts`:

```ts
import { fromSnapshot } from './tabsPersistence';
import type { SnapshotDeps } from './tabsPersistence';

function makeDeps(seq: () => number): SnapshotDeps {
  let n = seq();
  return {
    defaultPrefs,
    freshTab: () => ({
      id: `fresh-${++n}`,
      selection: null,
      cursorMs: null,
      status: 'empty',
      bundles: new Map(),
    }),
  };
}

describe('fromSnapshot', () => {
  it('builds tabs + prefs Map + activeTabId, assigning new ids', () => {
    const deps = makeDeps(() => 0);
    const snap: ReplayTabsSnapshot = {
      version: 1, savedAt: 0, activeIndex: 1,
      tabs: [
        { selection: { code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '1m' }, prefs: { volumeProfileMode: 'per-day' } },
        { selection: null, prefs: {} },
      ],
    };
    const out = fromSnapshot(snap, deps);
    expect(out.tabs).toHaveLength(2);
    // New ids assigned (caller cannot rely on persisted id).
    expect(out.tabs[0].id).not.toBe('');
    expect(out.tabs[1].id).not.toBe('');
    expect(out.tabs[0].id).not.toBe(out.tabs[1].id);
    // Per-tab prefs threaded into the Map under each new id.
    expect(out.prefs.get(out.tabs[0].id)!.volumeProfileMode).toBe('per-day');
    expect(out.prefs.get(out.tabs[1].id)!.volumeProfileMode).toBe('range');
    // status is empty, bundles fresh, cursorMs null (not persisted).
    expect(out.tabs[0].status).toBe('empty');
    expect(out.tabs[0].cursorMs).toBeNull();
    expect(out.tabs[0].bundles.size).toBe(0);
    // activeTabId points at the snapshot's activeIndex.
    expect(out.activeTabId).toBe(out.tabs[1].id);
  });

  it('seeds a single fresh tab when snapshot.tabs is empty', () => {
    const deps = makeDeps(() => 99);
    const out = fromSnapshot(
      { version: 1, savedAt: 0, activeIndex: 0, tabs: [] },
      deps,
    );
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0].selection).toBeNull();
    expect(out.prefs.size).toBe(0);
    expect(out.activeTabId).toBe(out.tabs[0].id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: FAIL — `fromSnapshot` not exported.

- [ ] **Step 3: Implement `fromSnapshot`**

Append to `tabsPersistence.ts`:

```ts
/** Hydrate a stored snapshot into live store shape. Returns the three slots
 *  (`tabs`, `prefs`, `activeTabId`) the caller must atomically `set()` to
 *  keep them consistent — see spec §"prefs Map 시드".
 *
 *  Pure with respect to `deps`: this module never reaches for `nanoid` or
 *  `DEFAULT_PREFS` itself, which keeps `state/tabs.ts ↔ tabsPersistence.ts`
 *  acyclic for value imports (only the type imports remain). */
export function fromSnapshot(
  snapshot: ReplayTabsSnapshot,
  deps: SnapshotDeps,
): { tabs: Tab[]; prefs: Map<string, ChartViewPrefs>; activeTabId: string } {
  if (snapshot.tabs.length === 0) {
    const seed = deps.freshTab();
    return { tabs: [seed], prefs: new Map(), activeTabId: seed.id };
  }
  const tabs: Tab[] = [];
  const prefs = new Map<string, ChartViewPrefs>();
  for (const persisted of snapshot.tabs) {
    const t = deps.freshTab();
    // Carry the persisted selection (already validated by loadPersisted).
    t.selection = persisted.selection;
    tabs.push(t);
    prefs.set(t.id, mergePrefs(persisted.prefs, deps.defaultPrefs));
  }
  const idx = Math.min(Math.max(0, snapshot.activeIndex), tabs.length - 1);
  return { tabs, prefs, activeTabId: tabs[idx].id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/state/tabsPersistence.ts frontend/src/state/tabsPersistence.test.ts
git commit -m "feat(replay): fromSnapshot hydrates tabs+prefs+activeTabId atomically"
```

---

## Task 7: Wire persistence into `tabs.ts`

**Files:**
- Modify: `frontend/src/state/tabs.ts`

This task does two things:
1. Replace the hard-coded `tabs: [initial]` seed with one built from `loadPersisted() + fromSnapshot()` (falls back to `[fresh()]` when no payload).
2. Subscribe to the store at module load, debounced 250 ms, and persist with HMR-safe disposal.

- [ ] **Step 1: Read the current `tabs.ts` initialization**

Run: `grep -n "const initial\|export const useTabsStore" frontend/src/state/tabs.ts`
Expected: `const initial = fresh();` at line 140 (approx) and `export const useTabsStore = create<Store>(...)` at line 142.

- [ ] **Step 2a: Add the persistence imports near the top of `tabs.ts`**

Below the existing imports (`zustand`, `nanoid`, `RangeBundle`/`Timeframe` from `api/types`, `useToolbarDraftStore`), add:

```ts
import {
  loadPersisted,
  savePersisted,
  toSnapshot,
  fromSnapshot,
  type SnapshotDeps,
} from './tabsPersistence';
```

- [ ] **Step 2b: Replace the initial state block**

Find the block:

```ts
const initial = fresh();

export const useTabsStore = create<Store>((set, get) => ({
  tabs: [initial],
  activeTabId: initial.id,
  prefs: new Map(),
  newTab: (opts) => {
```

Replace with:

```ts
const snapshotDeps: SnapshotDeps = { defaultPrefs: DEFAULT_PREFS, freshTab: fresh };

function seedInitialState(): {
  tabs: Tab[];
  prefs: Map<string, ChartViewPrefs>;
  activeTabId: string;
} {
  const snap = loadPersisted();
  if (snap === null) {
    const t = fresh();
    return { tabs: [t], prefs: new Map(), activeTabId: t.id };
  }
  return fromSnapshot(snap, snapshotDeps);
}

const seeded = seedInitialState();

export const useTabsStore = create<Store>((set, get) => ({
  tabs: seeded.tabs,
  activeTabId: seeded.activeTabId,
  prefs: seeded.prefs,
  newTab: (opts) => {
```

- [ ] **Step 3: Append the debounced subscribe + HMR dispose at the bottom of `tabs.ts`**

After the closing `}));` of `useTabsStore`, append:

```ts
// Persistence subscriber: every store change → debounced localStorage write.
// Module-scoped; the HMR dispose guard prevents listener accumulation in dev.
const PERSIST_DEBOUNCE_MS = 250;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const unsubscribePersist = useTabsStore.subscribe((state) => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    savePersisted(
      toSnapshot({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        prefs: state.prefs,
        defaultPrefs: DEFAULT_PREFS,
      }),
    );
  }, PERSIST_DEBOUNCE_MS);
});

// Vite HMR: dispose the previous subscription + timer before the module is
// replaced, so listeners do not accumulate across hot updates.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (persistTimer) clearTimeout(persistTimer);
    unsubscribePersist();
  });
}
```

- [ ] **Step 4: Run the existing `tabs.test.ts` to confirm no regressions**

Run from `frontend/`: `npx vitest run src/state/tabs.test.ts`
Expected: PASS (the existing tests `reset()` the store between runs; the new subscribe just writes debounced).

- [ ] **Step 5: Run the persistence module tests again to confirm nothing broke**

Run: `npx vitest run src/state/tabsPersistence.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the frontend**

Run from `frontend/`: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/state/tabs.ts
git commit -m "feat(replay): seed tabs store from localStorage + debounced save"
```

---

## Task 8: Adjust `ReplayViewer.useUrlSync` for the localStorage-seeded path

The current `useUrlSync` returns early (no hydration) when the URL has no `?tabs=...`. That is already the correct behavior under the new model — the store is already seeded from localStorage at module load. The only thing to confirm + tighten is the comment / guard.

**Files:**
- Modify: `frontend/src/pages/ReplayViewer.tsx`

- [ ] **Step 1: Read the current `useUrlSync`**

Run: `grep -n "useUrlSync\|parseReplayUrl\|store.reset" frontend/src/pages/ReplayViewer.tsx`
Expected: matches around lines 10–43.

- [ ] **Step 2: Update the hydration comment + early-return clarity**

In `frontend/src/pages/ReplayViewer.tsx`, replace the body of `useUrlSync`'s first `useEffect` block:

```tsx
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const parsed = parseReplayUrl(window.location.search);
    if (parsed.tabs.length === 0) return;
    // Hydrate tabs from URL: replace the single default empty tab.
    const store = useTabsStore.getState();
    store.reset();
    const firstId = useTabsStore.getState().tabs[0].id;
    store.setSelection(firstId, parsed.tabs[0]);
    for (let i = 1; i < parsed.tabs.length; i++) {
      const id = store.newTab();
      useTabsStore.getState().setSelection(id, parsed.tabs[i]);
    }
    const ids = useTabsStore.getState().tabs.map((t) => t.id);
    useTabsStore.getState().setActive(ids[parsed.active] ?? ids[0]);
  }, []);
```

with:

```tsx
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const parsed = parseReplayUrl(window.location.search);
    if (parsed.tabs.length === 0) {
      // No URL params → keep the store as-is. The store was already seeded
      // at module-load time from localStorage (see state/tabs.ts), or with a
      // single fresh tab if no snapshot existed. The debounced persist
      // subscriber will keep localStorage in sync from here.
      return;
    }
    // URL hydration wins over localStorage. After reset() + setSelection(),
    // the persist subscriber will overwrite localStorage with the URL state
    // (intentional one-way URL → localStorage sync — see spec §"Hydration 방향").
    const store = useTabsStore.getState();
    store.reset();
    const firstId = useTabsStore.getState().tabs[0].id;
    store.setSelection(firstId, parsed.tabs[0]);
    for (let i = 1; i < parsed.tabs.length; i++) {
      const id = store.newTab();
      useTabsStore.getState().setSelection(id, parsed.tabs[i]);
    }
    const ids = useTabsStore.getState().tabs.map((t) => t.id);
    useTabsStore.getState().setActive(ids[parsed.active] ?? ids[0]);
  }, []);
```

- [ ] **Step 3: Typecheck**

Run from `frontend/`: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ReplayViewer.tsx
git commit -m "docs(replay): clarify useUrlSync interaction with localStorage seed"
```

---

## Task 9: Integration tests (load → store, save round-trip)

**Files:**
- Modify: `frontend/src/state/tabs.test.ts`

- [ ] **Step 1: Add integration tests**

Append the following describe block to `frontend/src/state/tabs.test.ts`:

```ts
import { STORAGE_KEY } from './tabsPersistence';
import { afterEach, vi } from 'vitest';

describe('useTabsStore — persistence integration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
    // reset() itself triggers a save tick; flush before each test.
    vi.runAllTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a snapshot 250ms after a selection change', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setSelection(id, {
      code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '1m',
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(250);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(1);
    expect(parsed.tabs[0].selection.code).toBe('005930');
  });

  it('writes a snapshot after newTab + close round-trip', () => {
    useTabsStore.getState().newTab();
    vi.advanceTimersByTime(250);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).tabs).toHaveLength(2);
    const toClose = useTabsStore.getState().tabs[1].id;
    useTabsStore.getState().closeTab(toClose);
    vi.advanceTimersByTime(250);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).tabs).toHaveLength(1);
  });

  it('persists prefs changes (volumeProfileMode)', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setVolumeProfileMode(id, 'per-day');
    vi.advanceTimersByTime(250);
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('coalesces rapid changes into a single write (debounce)', () => {
    const id = useTabsStore.getState().tabs[0].id;
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    vi.advanceTimersByTime(100);
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', true);
    vi.advanceTimersByTime(100);
    useTabsStore.getState().setToggle(id, 'auctionWindowMask', false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // not yet
    vi.advanceTimersByTime(250);
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.tabs[0].prefs.auctionWindowMask).toBe(false);
  });
});
```

- [ ] **Step 2: Run the integration tests**

Run: `npx vitest run src/state/tabs.test.ts`
Expected: PASS for both the existing and the new describe block.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/state/tabs.test.ts
git commit -m "test(replay): integration tests for tabs persistence wiring"
```

---

## Task 10: Full test + typecheck + lint sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the full vitest suite**

Run from `frontend/`: `npx vitest run`
Expected: all tests PASS. No regressions in `replayLayout.test.ts`, `url.test.ts`, `CaptureForm.test.tsx`, etc.

- [ ] **Step 2: Typecheck**

Run from `frontend/`: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Lint**

Run from `frontend/`: `npx eslint src/state/tabsPersistence.ts src/state/tabsPersistence.test.ts src/state/tabs.ts src/state/tabs.test.ts src/pages/ReplayViewer.tsx`
Expected: no errors.

- [ ] **Step 4: If anything fails, fix in place and re-run before continuing.**

(No commit on this task unless a fix was needed; if so, commit the fix with `fix(replay): <what>`.)

---

## Task 11: Manual verification

**Prerequisite:** Backend running (`uv run uvicorn …` per CLAUDE.md) + frontend dev server (`npm run dev`).

- [ ] **Step 1: Cold-load with no localStorage**

Open DevTools → Application → Local Storage → clear all. Navigate to `http://localhost:5173/replay`.
Expected: single empty tab, onboarding card visible. No `replay.tabs.v1` key.

- [ ] **Step 2: Configure two tabs with selections + prefs**

- Tab 1: 005930 / today−5 / today / 1m. Open Settings, change Volume Profile to `per-day`, disable Auction Mask.
- Tab 2 (`newTab`): 035720 / today−3 / today / 5m. Change MA[0] period to 7.

Expected: after each change, within 250 ms DevTools shows `replay.tabs.v1` updated.

- [ ] **Step 3: Hard reload (F5)**

Expected: URL preserves `?tabs=…`. Both tabs restore from URL. Open Settings — Volume Profile / Auction Mask / MA values match what was set.

- [ ] **Step 4: Clean re-entry**

Navigate to `/inventory`, then click "Replay" in the left nav.
Expected: URL is `/replay` (no query), both tabs restore from localStorage including prefs.

- [ ] **Step 5: Close all browser tabs, reopen browser, visit `/replay` cleanly**

Expected: both tabs restore (single-slot localStorage survives browser restart).

- [ ] **Step 6: Incognito sanity check**

Open `/replay` in a private window.
Expected: single empty tab. No reads from the regular profile's localStorage.

- [ ] **Step 7: Corrupted payload recovery**

In DevTools, edit `replay.tabs.v1` to `{garbage`. Reload.
Expected: single empty tab (fallback). No errors thrown that crash the page; a warning in the console is acceptable but not required.

- [ ] **Step 8: URL share overwrite**

In a clean window, set localStorage manually to a known snapshot. Then visit a `/replay?tabs=…` URL with a different code. After page settles (≥ 250 ms), inspect localStorage.
Expected: the URL's state has replaced the prior snapshot.

- [ ] **Step 9: Final commit (only if any fix was needed above)**

If steps 1-8 surfaced anything, fix and commit. Otherwise this task is verification-only and produces no commit.

---

## Out of scope (per spec)

- Storage migration utility (v1 → v2). Current model: bump key, let old key garbage-collect.
- Tabs export/import to a JSON file.
- Cross-browser-tab live sync via the `storage` event.

## Self-Review Notes

- **Spec coverage**: Goal table § Load 흐름 § Save 흐름 § Storage schema § Edge cases § Testing 1–24 → covered by Tasks 1–11.
- **Type names match across tasks**: `ReplayTabsSnapshot`, `PersistedTab`, `SnapshotDeps`, `STORAGE_KEY`, `loadPersisted` / `savePersisted` / `toSnapshot` / `fromSnapshot`, `validateSelection`, `mergePrefs`, `PERSIST_DEBOUNCE_MS`. No drift across tasks 1–9.
- **`fromSnapshot` runtime deps** (DEFAULT_PREFS, freshTab) flow through `SnapshotDeps` rather than direct imports — keeps `tabsPersistence` from value-importing `tabs.ts` (would be a runtime cycle).
- **HMR concern** documented in spec + implemented in Task 7 via `import.meta.hot?.dispose`.
- **Test 24 (corrupted payload)** mapped to Task 11 step 7 (manual).

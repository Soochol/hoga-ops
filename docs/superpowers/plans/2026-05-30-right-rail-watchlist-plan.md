# Global Right Rail (Watchlist) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

scope: frontend

> **Post-implementation correction (2026-05-30).** Rail-collapse was dropped per user feedback. The **rail is fixed** (always `--rail-w`); the chevron `»`/`«` and the 관심 item **both show/hide the Watchlist Panel**. The `railCollapsed` state, the `--rail-handle-w` token (Task 1), and the **Panel-open ⟹ rail-expanded** invariant (Tasks 2/6) are all removed — the `rightRail` store owns a single `panelOpen` boolean. Tasks below that mention collapse/handle/invariant are superseded by this note; everything else stands.

**Goal:** Add a global right-edge icon rail (single 관심 item) that toggles a read-only Watchlist Panel on every page, replacing the `/live`-only ★ drawer.

**Architecture:** App shell owns a `RightRail` (always mounted) + a `WatchlistDrawer` (mounted when open). A dedicated `rightRail` zustand store (ADR-0052) owns `panelOpen`/`railCollapsed` with a bidirectional *Panel-open ⟹ rail-expanded* invariant. The drawer is the promoted former `/live` drawer; clicking a row sets `activeCode` and jumps to `/live`.

**Tech Stack:** React 18, react-router v7 (`useNavigate`/`useLocation`), zustand v4, TanStack Query v5, Tailwind, Vitest + Testing Library. Design tokens via `design-tokens.ts` + `npm run gen:tokens` (ADR-0012).

**Spec:** `docs/superpowers/specs/2026-05-30-right-rail-watchlist-design.md`
**ADR:** `docs/adr/0052-global-right-rail-state-store.md`

---

## File Structure

| Path | Create/Modify | Responsibility |
|---|---|---|
| `frontend/src/styles/design-tokens.ts` | Modify | Register `watchlist-panel-w`, `h-live-header`, `rail-w`, `rail-handle-w` in `SIZE_TOKENS` |
| `frontend/src/styles/tokens.css` | Modify (generated + hand color section) | Move orphaned `--source-*` to color section; regenerated AUTO block |
| `frontend/src/styles/tokens.generated.ts` | Modify (generated) | Tailwind theme payload |
| `DESIGN.md` | Modify (generated tables + Decisions Log) | Layout token table; one-line rail note |
| `frontend/src/state/rightRail.ts` | Create | Global rail chrome store (panelOpen, railCollapsed) |
| `frontend/src/state/rightRail.test.ts` | Create | Store unit tests incl. invariant + persistence |
| `frontend/src/watchlist/WatchlistDrawer.tsx` | Create (moved from `live/WatchlistPanel.tsx`) | Read-only Watchlist Panel body |
| `frontend/src/watchlist/WatchlistDrawer.test.tsx` | Create (moved) | Drawer tests incl. navigate + highlight |
| `frontend/src/rightrail/RightRail.tsx` | Create | Right rail chrome: chevron + 관심 toggle |
| `frontend/src/rightrail/RightRail.test.tsx` | Create | Rail interaction tests |
| `frontend/src/App.tsx` | Modify | Extend shell grid; mount RightRail + WatchlistDrawer |
| `frontend/src/live/LiveHeader.tsx` | Modify | Remove ★ toggle button |
| `frontend/src/live/LiveWorkarea.tsx` | Modify | Remove WatchlistPanel mounts + `watchlistOpen` |
| `frontend/src/state/livePage.ts` | Modify | Remove `watchlistPanelOpen` + its toggle/set |
| `frontend/src/state/livePage.test.ts` | Modify | Drop migrated-state assertions |
| `frontend/src/live/useLiveKeyboard.ts` | Modify | Repoint `w`/`Esc` to rightRail store |
| `frontend/src/live/useLiveKeyboard.test.tsx` | Modify | Repoint assertions to rightRail store |
| `frontend/src/live/LivePage.test.tsx` | Modify | Drop `watchlistPanelOpen` from setState |
| `frontend/src/live/WatchlistPanel.tsx` | Delete (moved) | — |
| `frontend/src/live/WatchlistPanel.test.tsx` | Delete (moved) | — |

**Task dependency order:** Task 1 (tokens) → Task 2 (store) → Task 3 (/live decommission + state migration) → Task 4 (promote drawer) → Task 5 (RightRail) → Task 6 (App mount) → Task 7 (verify). Tasks 2–6 are logically independent of Task 1 except that App grid (Task 6) consumes `--rail-w`; keeping Task 1 first guarantees the token exists.

---

## ⚠️ Task 1: Design tokens — heal orphaned live tokens, then add rail tokens

**Why a heal is required (read before starting):** `tokens.css` currently has `--watchlist-panel-w`, `--source-hogaplay-bg/border`, `--source-kis-live-bg/border`, and `--h-live-header` *inside* the `BEGIN/END AUTO-GENERATED` markers, but they are **not** in `design-tokens.ts`. `scripts/gen-tokens.ts::rewriteCss()` replaces everything between the markers with output built only from `SIZE_TOKENS`/`FIXED_PX_TOKENS`. So running `npm run gen:tokens` **deletes those orphaned tokens** — silently, because `npm run build` does not validate CSS-var existence. This task reconciles them first, then adds the rail tokens.

> **GATE 2 decision — DECIDED: proper heal (option A).** Implement this task exactly as written (reconcile orphans → register in `design-tokens.ts` → `gen:tokens`). The relax-ADR-0012 alternative was rejected by the user.

**Files:**
- Modify: `frontend/src/styles/design-tokens.ts`
- Modify: `frontend/src/styles/tokens.css` (move `--source-*`)
- Generated: `frontend/src/styles/tokens.css`, `frontend/src/styles/tokens.generated.ts`, `DESIGN.md`

- [ ] **Step 1: Confirm no concurrent edits to shared token files**

Run: `git -C /home/dev/code/hoga-ops.worktrees/feat+frontend5 status --porcelain -- frontend/src/styles DESIGN.md`
Expected: empty (no other session mid-edit on tokens/DESIGN.md). If non-empty, stop and coordinate — `gen:tokens` rewrites whole files and cannot be path-guarded.

- [ ] **Step 2: Move the four `--source-*` tokens out of the AUTO block into the hand-edited color section**

In `frontend/src/styles/tokens.css`, delete these four lines from *inside* the `BEGIN/END AUTO-GENERATED` block (they currently sit just after `--watchlist-panel-w`):

```css
  --source-hogaplay-bg: var(--bg-card);
  --source-hogaplay-border: var(--fg-dimmer);
  --source-kis-live-bg: color-mix(in srgb, var(--accent) 12%, var(--bg-card));
  --source-kis-live-border: var(--accent);
```

Then add them to the hand-edited color section of `tokens.css` (locate the color block — the section with `--accent`, `--bg-card` etc., *outside* the AUTO markers — and append, with a comment):

```css
  /* Source-identity chips (ADR-0039) — provenance, not UI/status/price. Hand-edited (color refs, not size). */
  --source-hogaplay-bg: var(--bg-card);
  --source-hogaplay-border: var(--fg-dimmer);
  --source-kis-live-bg: color-mix(in srgb, var(--accent) 12%, var(--bg-card));
  --source-kis-live-border: var(--accent);
```

Rationale: these are color/`var()` tokens, not `{rem, baseIntentPx}` sizes — `classify()` in gen-tokens.ts would throw on them, so they cannot live in `SIZE_TOKENS`. Per ADR-0012 colors stay hand-edited.

- [ ] **Step 3: Register the orphaned size tokens + new rail tokens in `design-tokens.ts`**

In `frontend/src/styles/design-tokens.ts`, add to the `SIZE_TOKENS` **layout — heights** group:

```ts
  'h-live-header':      { rem: 2,       baseIntentPx: 32, usage: 'Live page header row' },
```

and to the **layout — widths** group (after `dropdown-min-w`):

```ts
  'watchlist-panel-w':  { rem: 17.5,    baseIntentPx: 280, usage: 'Global Watchlist Panel (Right Rail) width' },
  'rail-w':             { rem: 3,       baseIntentPx: 48,  usage: 'Right Rail icon column width' },
  'rail-handle-w':      { rem: 0.75,    baseIntentPx: 12,  usage: 'Collapsed Right Rail handle width' },
```

Drift check (must hold, else gen:tokens aborts): `h-live-header` 2×16=32 ✓; `watchlist-panel-w` 17.5×16=280 ✓; `rail-w` 3×16=48 ✓; `rail-handle-w` 0.75×16=12 ✓.

- [ ] **Step 4: Regenerate artifacts**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npm run gen:tokens`
Expected: `gen-tokens: validation passed.` then writes to `tokens.generated.ts`, `tokens.css`, `DESIGN.md`. No drift/classify error.

- [ ] **Step 5: Verify NO token was lost (build/pytest cannot catch this — verify here)**

Run:
```bash
cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && \
for t in --watchlist-panel-w --source-hogaplay-bg --source-hogaplay-border --source-kis-live-bg --source-kis-live-border --h-live-header --rail-w --rail-handle-w; do \
  grep -q -- "$t" src/styles/tokens.css && echo "OK $t" || echo "MISSING $t"; done
```
Expected: all eight print `OK`. If any `MISSING`, fix Step 2/3 before continuing.

- [ ] **Step 6: Type-check + token unit test**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx tsc -b && npx vitest run tests/unit/tokens.test.ts src/styles 2>/dev/null || npx vitest run --dir src 2>/dev/null; npx vitest run`
Expected: token registry tests pass; tsc clean. (If `tokens.test.ts` path differs, run `npx vitest run` and confirm green.)

- [ ] **Step 7: Commit**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" add frontend/src/styles/design-tokens.ts frontend/src/styles/tokens.css frontend/src/styles/tokens.generated.ts DESIGN.md
git -C "$R" commit -m "fix(tokens): reconcile orphaned live tokens + add rail-w/rail-handle-w (ADR-0012)" -- frontend/src/styles/design-tokens.ts frontend/src/styles/tokens.css frontend/src/styles/tokens.generated.ts DESIGN.md
```

---

## Task 2: `rightRail` store

**Files:**
- Create: `frontend/src/state/rightRail.ts`
- Test: `frontend/src/state/rightRail.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/state/rightRail.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useRightRailStore } from './rightRail';

describe('rightRail store', () => {
  beforeEach(() => {
    localStorage.clear();
    useRightRailStore.setState({ panelOpen: false, railCollapsed: false });
  });

  it('togglePanel flips panelOpen and persists', () => {
    useRightRailStore.getState().togglePanel();
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    expect(JSON.parse(localStorage.getItem('rightRail.layout')!).panelOpen).toBe(true);
  });

  it('opening the panel expands a collapsed rail (Panel-open ⟹ rail-expanded)', () => {
    useRightRailStore.setState({ panelOpen: false, railCollapsed: true });
    useRightRailStore.getState().setPanelOpen(true);
    expect(useRightRailStore.getState().panelOpen).toBe(true);
    expect(useRightRailStore.getState().railCollapsed).toBe(false);
  });

  it('collapsing the rail closes an open panel', () => {
    useRightRailStore.setState({ panelOpen: true, railCollapsed: false });
    useRightRailStore.getState().toggleRailCollapsed();
    expect(useRightRailStore.getState().railCollapsed).toBe(true);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });

  it('setRailCollapsed(true) closes the panel; (false) leaves panel intact', () => {
    useRightRailStore.setState({ panelOpen: true, railCollapsed: false });
    useRightRailStore.getState().setRailCollapsed(true);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
    useRightRailStore.getState().setRailCollapsed(false);
    expect(useRightRailStore.getState().panelOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx vitest run src/state/rightRail.test.ts`
Expected: FAIL — `Cannot find module './rightRail'`.

- [ ] **Step 3: Write the store**

`frontend/src/state/rightRail.ts`:
```ts
import { create } from 'zustand';

const STORAGE_KEY = 'rightRail.layout';

type Persisted = {
  panelOpen: boolean;
  railCollapsed: boolean;
};

type Store = Persisted & {
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  toggleRailCollapsed: () => void;
  setRailCollapsed: (collapsed: boolean) => void;
};

const DEFAULTS: Persisted = { panelOpen: false, railCollapsed: false };

function persist(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (SSR, privacy mode) — silent fallback.
  }
}

function readStorage(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return (JSON.parse(raw) as Partial<Persisted>) ?? {};
  } catch {
    return {};
  }
}

// Read at module load (synchronous) so the rail's persisted state is present
// before the first route paints — no flash of the default closed state.
export const useRightRailStore = create<Store>((set, get) => ({
  ...DEFAULTS,
  ...readStorage(),

  togglePanel: () => {
    const open = !get().panelOpen;
    const next: Persisted = { panelOpen: open, railCollapsed: open ? false : get().railCollapsed };
    set(next);
    persist(next);
  },

  setPanelOpen: (open) => {
    const next: Persisted = { panelOpen: open, railCollapsed: open ? false : get().railCollapsed };
    set(next);
    persist(next);
  },

  toggleRailCollapsed: () => {
    const collapsed = !get().railCollapsed;
    const next: Persisted = { railCollapsed: collapsed, panelOpen: collapsed ? false : get().panelOpen };
    set(next);
    persist(next);
  },

  setRailCollapsed: (collapsed) => {
    const next: Persisted = { railCollapsed: collapsed, panelOpen: collapsed ? false : get().panelOpen };
    set(next);
    persist(next);
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx vitest run src/state/rightRail.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" add frontend/src/state/rightRail.ts frontend/src/state/rightRail.test.ts
git -C "$R" commit -m "feat(rightrail): add global rail chrome store (ADR-0052)" -- frontend/src/state/rightRail.ts frontend/src/state/rightRail.test.ts
```

---

## Task 3: Decommission the `/live` watchlist drawer + migrate state

After this task nothing in the app renders the `/live`-only drawer; `live/WatchlistPanel.tsx` is referenced only by its own test (moved in Task 4). `/live` temporarily has no watchlist UI until Task 6 mounts the global one — acceptable interim (build stays green).

**Files:**
- Modify: `frontend/src/live/LiveHeader.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/livePage.test.ts`
- Modify: `frontend/src/live/useLiveKeyboard.ts`
- Modify: `frontend/src/live/useLiveKeyboard.test.tsx`
- Modify: `frontend/src/live/LivePage.test.tsx`

- [ ] **Step 1: Remove the ★ toggle from `LiveHeader.tsx`**

Replace the whole file body with title-only (drops the `watchlistPanelOpen`/`toggleWatchlistPanel` subscriptions and the button):
```tsx
export function LiveHeader() {
  return (
    <div
      data-testid="live-header"
      className="flex items-center border-b px-3"
      style={{ height: 'var(--h-live-header)', borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
    >
      <h1 className="font-semibold" style={{ fontSize: 'var(--text-md)', color: 'var(--fg)' }}>
        Live
      </h1>
    </div>
  );
}
```

- [ ] **Step 2: Remove the WatchlistPanel mounts from `LiveWorkarea.tsx`**

Delete the import line `import { WatchlistPanel } from './WatchlistPanel';` (line 5), the line `const watchlistOpen = useLivePageStore((s) => s.watchlistPanelOpen);` (line 31), and both `{watchlistOpen && <WatchlistPanel />}` lines (the `!activeCode` branch ~line 46 and the main return ~line 85). The `useLivePageStore` import stays (still used for `candleTimeframe`).

- [ ] **Step 3: Repoint `useLiveKeyboard.ts` to the rightRail store**

Add `import { useRightRailStore } from '../state/rightRail';` and change the `w`/`Escape` cases:
```ts
        case 'w':
          useRightRailStore.getState().togglePanel();
          e.preventDefault();
          break;
        case 'Escape':
          if (useRightRailStore.getState().panelOpen) {
            useRightRailStore.getState().setPanelOpen(false);
            e.preventDefault();
          }
          break;
```
(Keep the `useLivePageStore.getState()` line only if other cases still use it; `j`/`k` use `opts`, so the `const store = useLivePageStore.getState();` line can be removed.)

- [ ] **Step 4: Remove migrated members from `livePage.ts`**

Delete: `watchlistPanelOpen: boolean;` from `Persisted` (line 82); `toggleWatchlistPanel` + `setWatchlistPanelOpen` from `Store` (lines 101–102); `watchlistPanelOpen: false,` from `DEFAULTS` (line 115); and both mutator impls `toggleWatchlistPanel` (274–278) and `setWatchlistPanelOpen` (280–283).

- [ ] **Step 5: Fix tests that referenced migrated state**

- `frontend/src/state/livePage.test.ts`: remove `watchlistPanelOpen` from the setState/assert at lines 17/22/25, the localStorage JSON at line 51, the read-back at 57, and delete the whole `it('toggleWatchlistPanel flips and persists', ...)` case (42–46).
- `frontend/src/live/LivePage.test.tsx`: remove `watchlistPanelOpen: false,` from the `setState` at line 79.
- `frontend/src/live/useLiveKeyboard.test.tsx`: import `useRightRailStore`; in `beforeEach` reset `useRightRailStore.setState({ panelOpen: false, railCollapsed: false })`; change every `useLivePageStore.getState().watchlistPanelOpen` assertion to `useRightRailStore.getState().panelOpen`, and the `setState({ watchlistPanelOpen: true })` to `useRightRailStore.setState({ panelOpen: true })`.

- [ ] **Step 6: Run affected tests + type-check**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx tsc -b && npx vitest run src/state/livePage.test.ts src/live/useLiveKeyboard.test.tsx src/live/LivePage.test.tsx`
Expected: PASS, tsc clean. (`live/WatchlistPanel.test.tsx` still imports the not-yet-moved file and still passes — it's moved in Task 4.)

- [ ] **Step 7: Commit**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" add frontend/src/live/LiveHeader.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/useLiveKeyboard.ts frontend/src/live/useLiveKeyboard.test.tsx frontend/src/state/livePage.ts frontend/src/state/livePage.test.ts frontend/src/live/LivePage.test.tsx
git -C "$R" commit -m "refactor(live): migrate watchlist panel state to rightRail store; remove ★ drawer" -- frontend/src/live/LiveHeader.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/useLiveKeyboard.ts frontend/src/live/useLiveKeyboard.test.tsx frontend/src/state/livePage.ts frontend/src/state/livePage.test.ts frontend/src/live/LivePage.test.tsx
```

---

## Task 4: Promote the drawer → `watchlist/WatchlistDrawer.tsx`

**Files:**
- Create: `frontend/src/watchlist/WatchlistDrawer.tsx` (from `live/WatchlistPanel.tsx`)
- Create: `frontend/src/watchlist/WatchlistDrawer.test.tsx` (from `live/WatchlistPanel.test.tsx`)
- Delete: `frontend/src/live/WatchlistPanel.tsx`, `frontend/src/live/WatchlistPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/src/watchlist/WatchlistDrawer.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function wrap(qc: QueryClient, initial: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <LocationProbe />
        <Routes><Route path="*" element={null} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const ENTRIES = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null },
];

describe('WatchlistDrawer', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({ activeCode: null, candleTimeframe: '1m' } as any);
    vi.restoreAllMocks();
  });

  it('renders entries from the API', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('clicking a row sets activeCode and navigates to /live when elsewhere', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  });

  it('clicking a row on /live sets activeCode without changing route', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/live') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    fireEvent.click(screen.getByText('SK하이닉스'));
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    expect(screen.getByTestId('pathname').textContent).toBe('/live');
  });

  it('shows empty message when no entries', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: [], next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/inventory') });
    await waitFor(() => expect(screen.getByText(/관심종목이 없습니다/)).toBeInTheDocument());
  });

  it('highlights the active code regardless of route', async () => {
    useLivePageStore.setState({ activeCode: '000660' } as any);
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: ENTRIES, next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistDrawer />, { wrapper: wrap(qc, '/capture') });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.getByTestId('watchlist-row-000660').getAttribute('aria-current')).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: FAIL — `Cannot find module './WatchlistDrawer'`.

- [ ] **Step 3: Create `WatchlistDrawer.tsx` (promoted + generalized)**

`frontend/src/watchlist/WatchlistDrawer.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useLocation } from 'react-router';
import { getWatchlist, type WatchlistEntry } from '../api/watchlist';
import { useLivePageStore } from '../state/livePage';

/**
 * Read-only Watchlist Panel (CONTEXT.md), surfaced app-wide via the Right Rail
 * (ADR-0052). Promoted from the former /live-only drawer. Clicking a row sets
 * `activeCode` and jumps to /live (when not already there).
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data, isLoading, error } = useQuery({
    queryKey: ['watchlist'],
    queryFn: getWatchlist,
    staleTime: 60_000,
  });

  const onPick = (code: string) => {
    setActiveCode(code);
    if (pathname !== '/live') navigate('/live');
  };

  return (
    <div
      id="right-rail-watchlist-panel"
      data-testid="watchlist-panel"
      style={{
        width: 'var(--watchlist-panel-w)',
        height: '100%',
        background: 'var(--bg-card)',
        borderLeft: '1px solid var(--border)',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
          color: 'var(--fg-dim)',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        관심종목
      </div>
      {isLoading && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-sm)' }}>
          불러오는 중
        </div>
      )}
      {error && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--error)', fontSize: 'var(--text-sm)' }}>
          관심종목을 불러올 수 없습니다
        </div>
      )}
      {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (
        <div style={{ padding: 'var(--space-md)', color: 'var(--fg-dimmer)', fontSize: 'var(--text-sm)' }}>
          관심종목이 없습니다
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data?.entries.map((entry) => (
          <WatchlistRow
            key={entry.code}
            entry={entry}
            active={entry.code === activeCode}
            onClick={() => onPick(entry.code)}
          />
        ))}
      </ul>
    </div>
  );
}

function WatchlistRow({
  entry,
  active,
  onClick,
}: {
  entry: WatchlistEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li
      data-testid={`watchlist-row-${entry.code}`}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: 'var(--space-sm) var(--space-md)',
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2xs)',
      }}
    >
      <span style={{ fontFamily: 'monospace', color: 'var(--fg-dim)', fontSize: 'var(--text-xs)' }}>
        {entry.code}
      </span>
      <span style={{ color: 'var(--fg)', fontSize: 'var(--text-sm)' }}>
        {entry.name}
      </span>
    </li>
  );
}
```

- [ ] **Step 4: Delete the old files**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" rm frontend/src/live/WatchlistPanel.tsx frontend/src/live/WatchlistPanel.test.tsx
```

- [ ] **Step 5: Run test + type-check**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx tsc -b && npx vitest run src/watchlist/WatchlistDrawer.test.tsx`
Expected: PASS (5 tests), tsc clean (no dangling import of the deleted file).

- [ ] **Step 6: Commit**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" add frontend/src/watchlist/WatchlistDrawer.tsx frontend/src/watchlist/WatchlistDrawer.test.tsx
git -C "$R" commit -m "refactor(watchlist): promote /live drawer to global WatchlistDrawer (read-only, jump-to-live)"
```
(The `git rm` from Step 4 is already staged; this commit includes both adds and removals.)

---

## Task 5: `RightRail` component

**Files:**
- Create: `frontend/src/rightrail/RightRail.tsx`
- Test: `frontend/src/rightrail/RightRail.test.tsx`

- [ ] **Step 1: Write the failing test**

`frontend/src/rightrail/RightRail.test.tsx`:
```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RightRail from './RightRail';
import { useRightRailStore } from '../state/rightRail';

describe('RightRail', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useRightRailStore.setState({ panelOpen: false, railCollapsed: false });
  });

  it('관심 button toggles the panel', () => {
    render(<RightRail />);
    const btn = screen.getByLabelText('관심종목 패널 토글');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useRightRailStore.getState().panelOpen).toBe(true);
  });

  it('chevron collapses the rail and hides the 관심 button', () => {
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('레일 접기'));
    expect(useRightRailStore.getState().railCollapsed).toBe(true);
    expect(screen.queryByLabelText('관심종목 패널 토글')).toBeNull();
  });

  it('collapsed handle expands the rail', () => {
    useRightRailStore.setState({ panelOpen: false, railCollapsed: true });
    render(<RightRail />);
    fireEvent.click(screen.getByLabelText('레일 펼치기'));
    expect(useRightRailStore.getState().railCollapsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx vitest run src/rightrail/RightRail.test.tsx`
Expected: FAIL — `Cannot find module './RightRail'`.

- [ ] **Step 3: Write the component**

`frontend/src/rightrail/RightRail.tsx`:
```tsx
import { useRightRailStore } from '../state/rightRail';

/**
 * Global Right Rail (ADR-0052) — thin right-edge chrome on every route.
 * Top chevron toggles rail collapse; the single 관심 item toggles the
 * Watchlist Panel. Mounted by App; the panel itself is the WatchlistDrawer.
 */
export default function RightRail() {
  const panelOpen = useRightRailStore((s) => s.panelOpen);
  const railCollapsed = useRightRailStore((s) => s.railCollapsed);
  const togglePanel = useRightRailStore((s) => s.togglePanel);
  const toggleRailCollapsed = useRightRailStore((s) => s.toggleRailCollapsed);

  return (
    <nav
      aria-label="Right Rail"
      className="flex flex-col items-center h-full bg-bg-subtle border-l"
      style={{ width: railCollapsed ? 'var(--rail-handle-w)' : 'var(--rail-w)' }}
    >
      <button
        type="button"
        onClick={toggleRailCollapsed}
        aria-label={railCollapsed ? '레일 펼치기' : '레일 접기'}
        aria-expanded={!railCollapsed}
        className="w-full py-2 grid place-items-center text-fg-dim hover:text-fg hover:bg-bg-input-hover"
      >
        {railCollapsed ? '«' : '»'}
      </button>
      {!railCollapsed && (
        <button
          type="button"
          onClick={togglePanel}
          aria-pressed={panelOpen}
          aria-controls="right-rail-watchlist-panel"
          aria-label="관심종목 패널 토글"
          // Active = tint bg + neutral text, matching NavItem (no triple-teal).
          // The heart fill (currentColor=fg) is a shape signal, not a 2nd accent.
          className={`w-full py-3 flex flex-col items-center gap-1 ${
            panelOpen
              ? 'bg-tint-selection text-fg'
              : 'text-fg-dim hover:bg-bg-input-hover hover:text-fg'
          }`}
        >
          <HeartIcon filled={panelOpen} />
          <span className="text-xs">관심</span>
        </button>
      )}
    </nav>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx vitest run src/rightrail/RightRail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" add frontend/src/rightrail/RightRail.tsx frontend/src/rightrail/RightRail.test.tsx
git -C "$R" commit -m "feat(rightrail): add Right Rail chrome (chevron + 관심 toggle)" -- frontend/src/rightrail/RightRail.tsx frontend/src/rightrail/RightRail.test.tsx
```

---

## Task 6: App shell integration

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Rewrite `App.tsx` to mount the rail + drawer in a dynamic grid**

```tsx
import { Outlet } from 'react-router';
import LeftNav from './nav/LeftNav';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/sse';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';

export default function App() {
  useEventStream();
  useInventoryRecaptureOriginsCleanup();
  const panelOpen = useRightRailStore((s) => s.panelOpen);
  const railCollapsed = useRightRailStore((s) => s.railCollapsed);

  // Panel-open ⟹ rail-expanded (store invariant); guard defensively so the
  // rendered children always match the grid track count.
  const showPanel = panelOpen && !railCollapsed;
  const railTrack = railCollapsed ? 'var(--rail-handle-w)' : 'var(--rail-w)';
  const cols = `var(--nav-w) 1fr${showPanel ? ' var(--watchlist-panel-w)' : ''} ${railTrack}`;

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{ gridTemplateColumns: cols }}
    >
      <LeftNav />
      <main className="overflow-hidden min-w-0"><Outlet /></main>
      {showPanel && <WatchlistDrawer />}
      <RightRail />
    </div>
  );
}
```

- [ ] **Step 2: Type-check + full unit suite**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npx tsc -b && npx vitest run`
Expected: tsc clean; all tests PASS.

- [ ] **Step 3: Commit**

```bash
R=/home/dev/code/hoga-ops.worktrees/feat+frontend5
git -C "$R" add frontend/src/App.tsx
git -C "$R" commit -m "feat(app): mount global Right Rail + Watchlist Panel in shell grid" -- frontend/src/App.tsx
```

---

## Task 7: Full verification

- [ ] **Step 1: Backend tests (verification gate part 1)**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5 && uv run pytest`
Expected: all pass (this change is frontend-only; pytest should be unaffected).

- [ ] **Step 2: Frontend build (verification gate part 2)**

Run: `cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && npm run build`
Expected: `tsc -b && vite build` succeeds.

- [ ] **Step 3: Token-existence re-check (build cannot catch CSS-var loss)**

Run:
```bash
cd /home/dev/code/hoga-ops.worktrees/feat+frontend5/frontend && \
for t in --watchlist-panel-w --source-hogaplay-bg --source-kis-live-bg --h-live-header --rail-w --rail-handle-w; do \
  grep -q -- "$t" src/styles/tokens.css && echo "OK $t" || echo "MISSING $t"; done
```
Expected: all `OK`.

- [ ] **Step 4: Manual verification (dev servers)**

With backend + Vite running (see CLAUDE.md):
- On `/inventory` (or `/capture`, `/settings`): right rail visible; click 관심 → panel opens; click a row → navigates to `/live` with that code's chart.
- On `/live`: no ★ button in the header; the right-rail panel's row click switches the chart; only one watchlist panel exists.
- Chevron collapses/expands the rail; opening the panel while collapsed auto-expands the rail.
- Reload: panel-open + rail-collapsed state persists; `w` toggles the panel on `/live`.

---

## Self-Review (completed by plan author)

- **Spec coverage:** global rail (Task 5,6) ✓; single 관심 item (Task 5) ✓; read-only drawer reused (Task 4) ✓; replace /live drawer (Task 3) ✓; row-click jump-to-live with pathname guard (Task 4) ✓; rightRail store + invariant + persistence (Task 2, ADR-0052) ✓; tokens via design-tokens.ts/gen:tokens (Task 1, ADR-0012) ✓; CONTEXT.md terms already committed (grill).
- **Token landmine:** addressed in Task 1 (heal) with explicit grep guardrails in Task 1 Step 5 and Task 7 Step 3.
- **Type consistency:** store members `togglePanel`/`setPanelOpen`/`toggleRailCollapsed`/`setRailCollapsed` used identically in store (Task 2), keyboard (Task 3), rail (Task 5), App (Task 6). `WatchlistDrawer` named consistently across Tasks 4/6. Panel container id `right-rail-watchlist-panel` matches `aria-controls` in RightRail.
- **No placeholders:** every code step has full code; every command has expected output.

## Deferred review notes

From plan-design-review (2026-05-30). Suggestion/Nit — apply opportunistically during execution; not blocking. (The CRITICAL — active-state triple-teal — was applied inline to Tasks 4 & 5.)

- **[SUGGESTION] Focus-visible ring**: add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent` to both RightRail buttons (DESIGN.md reserves `--accent` for focus rings; keyboard-driven tool). Pre-existing gap in NavItem too.
- **[SUGGESTION] Collapsed-rail expand target**: when collapsed, make the chevron button `h-full` so the whole ~15px strip is the expand affordance, not just a top sliver.
- **[NIT] Spacing vocabulary**: `py-2`/`py-3`/`gap-1` render identically to `--space-sm`/`--space-md`/`--space-xs` (both rem, track the density dial — no pixel change); prefer the named `py-sm`/`py-md`/`gap-xs` classes for design-system vocabulary consistency.
- **[NIT] Icon sizing**: if the heart is kept, use `width="1.125em" height="1.125em"` (not hardcoded `18`) so it scales with future density modes.
- **[NIT] aria-label copy tone**: `<nav aria-label="Right Rail">` → Korean (`"우측 레일"`) to match the component's other Korean aria-labels and DESIGN.md copy tone.
- **[CONFIRMED — no change] Motion**: the panel slide + rail collapse are grid-track width changes (sidebar/pane-resize class) — DESIGN.md says do NOT animate these, so the plan's no-transition choice is correct. The `»`/`«` chevron glyph is sanctioned by CONTEXT.md's Right Rail entry.

### Deferred architecture note (step 7 — improve-codebase-architecture)
No deepening opportunity cleared the auto-apply bar for this churn-averse window. One real candidate deferred:
- **Shared persisted-store helper**: `state/rightRail.ts` and `state/livePage.ts` both reimplement the localStorage `persist()`/`readStorage()` try/catch boilerplate (livePage has a 4-function variant incl. indicators). Extracting a `state/persistedStore.ts` (`savePersisted`/`readPersisted`) would concentrate the localStorage-safety semantics in one place. **Deferred, not applied** — it would touch the large pre-existing `livePage.ts` (+ its indicators persist), which is concurrent-session-adjacent; the locality gain doesn't justify that blast radius mid-stream. Revisit as a standalone post-ship cleanup once the worktree is single-session.

### GATE 2 decision — icon: DECIDED → **heart icon + "관심"**
User chose the heart (matches the reference image). Task 5's `HeartIcon` is correct as written. Keep the restrained single line-weight SVG; fill toggles with `panelOpen` as a shape signal (color stays `currentColor` per the de-teal CRITICAL).

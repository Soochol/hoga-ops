# Minimal Top Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed left navigation column with a 40px minimal top menu, recover horizontal chart space, and clean up obsolete vertical-nav code.

**Architecture:** Move route metadata into a shared `nav/items.ts` module, render it through a new text-only `TopNav`, and change `App` into a two-row shell whose second row owns main content, optional right-rail drawer, and fixed right rail. Split capture queue status into a compact top-nav presentation, then remove left-nav-only components/tests after all imports move. Use focused regression tests at task boundaries rather than a heavy red/green loop for every small file move.

**Tech Stack:** React 18, React Router 7, TanStack Query, Zustand, Tailwind utility classes, Vitest, Testing Library, Vite.

## Global Constraints

- Top bar height is `--top-nav-h`: 2rem token, 32px base intent / 40px rendered at default density.
- Brand is logo plus `hoga-ops` only; `orderbook replay` must not render.
- Active nav state is text color and weight only: no underline, active bar, pill background, border, or icon placeholder.
- Right rail and right-side drawers remain unchanged.
- `/live` keeps document title ownership; non-`/live` static titles still derive from nav labels.
- Idle, unpaused capture queue renders no capture status in the top menu.
- Clean up vertical-nav-only files and tests; do not leave unused `LeftNav` shell code behind.
- Do not redesign `/live` toolbar, tabs, price strip, chart panes, chart logic, right rail, or right-rail drawers.
- Keep testing practical: add/update focused nav, shell, and capture-status tests, then verify each task with targeted Vitest runs and one final build/manual pass.

---

## File Structure

- Create `frontend/src/nav/items.ts`
  - Owns shared `WORKSPACE_NAV_ITEMS` and `SYSTEM_NAV_ITEMS`.
- Create `frontend/src/nav/TopNavItem.tsx`
  - Owns text-only top-menu link styling.
- Create `frontend/src/nav/CaptureInlineStatus.tsx`
  - Owns compact capture queue status for the top menu.
- Create `frontend/src/nav/TopNav.tsx`
  - Owns brand, workspace links, compact capture status, settings link, and `StatusDot`.
- Create or rename tests to `frontend/src/nav/TopNav.test.tsx` and `frontend/tests/component/TopNav.test.tsx`
  - Replaces left-nav assertions with top-nav behavior.
- Modify `frontend/src/App.tsx`
  - Converts app shell from left-column grid to top-row + content-grid shell.
- Modify `frontend/src/App.test.tsx`
  - Updates mocks and layout assertions for the two-row shell.
- Modify `frontend/src/styles/design-tokens.ts`
  - Adds `h-top-nav`; removes or retires `nav-w` after reference search.
- Regenerate `frontend/src/styles/tokens.css` and `frontend/src/styles/tokens.generated.ts`
  - Via `npm run gen:tokens`.
- Modify `DESIGN.md`
  - Updates app shell and page-title language.
- Delete after migration if unused:
  - `frontend/src/nav/LeftNav.tsx`
  - `frontend/src/nav/NavItem.tsx`
  - `frontend/src/nav/CaptureStatusPill.tsx`
  - `frontend/src/nav/LeftNav.test.tsx`
  - `frontend/tests/component/LeftNav.test.tsx`

---

### Task 1: Navigation Data And Text-Only TopNav

**Files:**
- Create: `frontend/src/nav/items.ts`
- Create: `frontend/src/nav/TopNavItem.tsx`
- Create: `frontend/src/nav/TopNav.tsx`
- Replace: `frontend/src/nav/LeftNav.test.tsx` -> `frontend/src/nav/TopNav.test.tsx`
- Replace: `frontend/tests/component/LeftNav.test.tsx` -> `frontend/tests/component/TopNav.test.tsx`

**Interfaces:**
- Produces: `WORKSPACE_NAV_ITEMS: readonly { to: string; label: string }[]`
- Produces: `SYSTEM_NAV_ITEMS: readonly { to: string; label: string }[]`
- Produces: `TopNavItem({ to, label }: { to: string; label: string }): JSX.Element`
- Produces: `TopNav(): JSX.Element`
- Consumes: existing `StatusDot` default export from `frontend/src/nav/StatusDot.tsx`

- [ ] **Step 1: Replace the local nav test with a focused TopNav test**

Move `frontend/src/nav/LeftNav.test.tsx` to `frontend/src/nav/TopNav.test.tsx` and replace its contents with:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TopNav from './TopNav';

vi.mock('./CaptureInlineStatus', () => ({
  CaptureInlineStatus: () => null,
}));

vi.mock('./StatusDot', () => ({
  default: () => <span>WS · :8000</span>,
}));

function W({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TopNav', () => {
  it('renders workspace links in the approved order and Settings at the end', () => {
    render(<TopNav />, { wrapper: W });

    const labels = screen.getAllByRole('link').map((link) => link.textContent);

    expect(labels).toEqual(['Live', 'Study', 'Heatmap', 'Screener', 'Inventory', 'Capture', 'Settings']);
    expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
  });

  it('renders only the hoga-ops brand text, without the old subtitle', () => {
    render(<TopNav />, { wrapper: W });

    expect(screen.getByText('hoga-ops')).toBeInTheDocument();
    expect(screen.queryByText(/orderbook replay/i)).not.toBeInTheDocument();
  });

  it('uses text-only active styling for the current route', () => {
    render(<TopNav />, { wrapper: W });

    const liveLink = screen.getByRole('link', { name: 'Live' });

    expect(liveLink).toHaveClass('text-fg', 'font-bold');
    expect(liveLink.className).not.toContain('before:');
    expect(liveLink).not.toHaveClass('border-border-strong', 'bg-tint-selection');
    expect(liveLink.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Replace the component-level nav smoke test**

Move `frontend/tests/component/LeftNav.test.tsx` to `frontend/tests/component/TopNav.test.tsx` and replace its contents with:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TopNav from '../../src/nav/TopNav';

vi.mock('../../src/api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
  lastHeartbeat: () => Date.now(),
  useEventStream: () => {},
}));

vi.mock('../../src/nav/StatusDot', () => ({
  default: () => <span>WS · :8000</span>,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }),
  } as Response);
});

function W({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/live']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

it('renders the approved minimal top menu items', () => {
  render(<TopNav />, { wrapper: W });

  expect(screen.getByText('hoga-ops')).toBeInTheDocument();
  expect(screen.getByText('Live')).toBeInTheDocument();
  expect(screen.getByText('Inventory')).toBeInTheDocument();
  expect(screen.getByText('Capture')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
  expect(screen.queryByText(/orderbook replay/i)).not.toBeInTheDocument();
  expect(screen.queryByText('Watchlist')).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Optional quick baseline check**

Run:

```bash
cd frontend
npx vitest run src/nav/TopNav.test.tsx tests/component/TopNav.test.tsx
```

Expected: The command fails until the new `TopNav` and `CaptureInlineStatus` files exist. This check is optional; for a simple execution, continue directly to the implementation steps and run the full task test at Step 8.

- [ ] **Step 4: Add shared nav item data**

Create `frontend/src/nav/items.ts`:

```ts
export const WORKSPACE_NAV_ITEMS = [
  { to: '/live', label: 'Live' },
  { to: '/study', label: 'Study' },
  { to: '/heatmap', label: 'Heatmap' },
  { to: '/screener', label: 'Screener' },
  { to: '/inventory', label: 'Inventory' },
  { to: '/capture', label: 'Capture' },
] as const;

export const SYSTEM_NAV_ITEMS = [
  { to: '/settings', label: 'Settings' },
] as const;
```

- [ ] **Step 5: Add a text-only TopNavItem**

Create `frontend/src/nav/TopNavItem.tsx`:

```tsx
import { NavLink } from 'react-router';

export default function TopNavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [
          'h-full inline-flex items-center whitespace-nowrap no-underline transition-colors',
          'text-sm',
          isActive ? 'text-fg font-bold' : 'text-fg-dim font-semibold hover:text-fg',
        ].join(' ')
      }
    >
      {label}
    </NavLink>
  );
}
```

- [ ] **Step 6: Add a temporary CaptureInlineStatus shim**

Create `frontend/src/nav/CaptureInlineStatus.tsx`:

```tsx
export function CaptureInlineStatus() {
  return null;
}
```

Task 2 replaces this shim with the real queue-backed implementation.

- [ ] **Step 7: Add TopNav**

Create `frontend/src/nav/TopNav.tsx`:

```tsx
import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './items';
import TopNavItem from './TopNavItem';
import { CaptureInlineStatus } from './CaptureInlineStatus';
import StatusDot from './StatusDot';

export default function TopNav() {
  return (
    <nav
      aria-label="주요 메뉴"
      className="h-top-nav min-w-0 border-b border-border bg-bg-subtle px-lg"
    >
      <div className="grid h-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-xl">
        <div className="inline-flex items-center gap-sm whitespace-nowrap">
          <span
            aria-hidden="true"
            className="grid h-[22px] w-[22px] place-items-center rounded bg-fg text-bg text-xs font-extrabold leading-none"
          >
            H
          </span>
          <span className="text-lg font-extrabold leading-none text-fg">hoga-ops</span>
        </div>

        <div className="flex h-full min-w-0 items-center gap-xl overflow-hidden">
          {WORKSPACE_NAV_ITEMS.map((item) => (
            <TopNavItem key={item.to} to={item.to} label={item.label} />
          ))}
        </div>

        <div className="flex min-w-max items-center gap-lg text-xs font-semibold text-fg-dim">
          <CaptureInlineStatus />
          {SYSTEM_NAV_ITEMS.map((item) => (
            <TopNavItem key={item.to} to={item.to} label={item.label} />
          ))}
          <StatusDot />
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 8: Run TopNav tests**

Run:

```bash
cd frontend
npx vitest run src/nav/TopNav.test.tsx tests/component/TopNav.test.tsx
```

Expected: PASS in Vitest. The later production build still needs Task 3 because `h-top-nav` is added to the generated Tailwind token map there.

- [ ] **Step 9: Commit Task 1**

```bash
git add frontend/src/nav/items.ts frontend/src/nav/TopNavItem.tsx frontend/src/nav/TopNav.tsx frontend/src/nav/CaptureInlineStatus.tsx frontend/src/nav/TopNav.test.tsx frontend/tests/component/TopNav.test.tsx
git rm frontend/src/nav/LeftNav.test.tsx frontend/tests/component/LeftNav.test.tsx
git commit -m "feat: add minimal top navigation"
```

---

### Task 2: Capture Inline Status

**Files:**
- Modify: `frontend/src/nav/CaptureInlineStatus.tsx`
- Replace: `frontend/src/nav/CaptureStatusPill.test.tsx` -> `frontend/src/nav/CaptureInlineStatus.test.tsx`
- Delete: `frontend/src/nav/CaptureStatusPill.tsx`

**Interfaces:**
- Consumes: `useCaptureQueue()` from `frontend/src/capture/useCaptureQueue.ts`
- Produces: `CaptureInlineStatus(): JSX.Element | null`

- [ ] **Step 1: Replace the capture status tests**

Move `frontend/src/nav/CaptureStatusPill.test.tsx` to `frontend/src/nav/CaptureInlineStatus.test.tsx` and replace its contents with:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { QueueSnapshot } from '../api/types';
import { CaptureInlineStatus } from './CaptureInlineStatus';

vi.mock('../api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function setup(snap: QueueSnapshot) {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => snap,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const empty: QueueSnapshot = { active: [], queued: [], done: [], paused: false, max_concurrent: 3 };
const item = (id: string, phase: 'queued' | 'capturing' = 'queued') => ({
  item_id: id,
  code: '005930',
  date: '20260518',
  phase,
  force_retry: false,
  pause_origin: false,
  enqueued_at_ms: 1,
  started_at_ms: null,
  progress: null,
  result: null,
  error: null,
  skip_reason: null,
  attempt: 1,
});

describe('CaptureInlineStatus', () => {
  it('renders null when no active and no queued and not paused', async () => {
    const qc = setup(empty);
    const { container } = render(<CaptureInlineStatus />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(container.firstChild).toBeNull();
  });

  it('renders compact capturing text when items are active or queued', async () => {
    const qc = setup({ ...empty, active: [item('a1', 'capturing')], queued: [item('q1'), item('q2')] });
    render(<CaptureInlineStatus />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('link', { name: /1 capturing · 2 queued/i })).toHaveAttribute('href', '/capture');
    expect(screen.queryByText(/CAPTURING/)).not.toBeInTheDocument();
  });

  it('renders compact paused text when snapshot.paused', async () => {
    const qc = setup({ ...empty, paused: true, active: [item('a1', 'capturing')] });
    render(<CaptureInlineStatus />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('link', { name: /paused/i })).toHaveAttribute('href', '/capture');
    expect(screen.queryByText(/click to resume/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Optional quick baseline check**

Run:

```bash
cd frontend
npx vitest run src/nav/CaptureInlineStatus.test.tsx
```

Expected: The command fails until `CaptureInlineStatus` is implemented. This check is optional; for a simple execution, continue directly to Step 3 and run the task test at Step 5.

- [ ] **Step 3: Implement CaptureInlineStatus**

Replace `frontend/src/nav/CaptureInlineStatus.tsx` with:

```tsx
import { Link } from 'react-router';
import { useCaptureQueue } from '../capture/useCaptureQueue';

export function CaptureInlineStatus() {
  const { queue } = useCaptureQueue();
  if (queue === undefined) return null;

  const activeCount = queue.active.length;
  const queuedCount = queue.queued.length;
  if (!queue.paused && activeCount === 0 && queuedCount === 0) return null;

  const paused = queue.paused;
  const label = paused ? 'paused' : `${activeCount} capturing · ${queuedCount} queued`;
  const dotColor = paused ? 'var(--warn)' : 'var(--accent)';
  const dotAnim = paused ? 'none' : 'capture-pulse 1.5s ease-in-out infinite';

  return (
    <Link
      to="/capture"
      className="inline-flex h-full items-center gap-xs whitespace-nowrap text-xs font-semibold text-fg-dim no-underline hover:text-fg"
    >
      <span
        aria-hidden="true"
        className="rounded-full"
        style={{ width: 6, height: 6, background: dotColor, animation: dotAnim }}
      />
      <span>{label}</span>
    </Link>
  );
}
```

- [ ] **Step 4: Delete the old vertical capture pill**

Run:

```bash
git rm frontend/src/nav/CaptureStatusPill.tsx frontend/src/nav/CaptureStatusPill.test.tsx
```

Expected: both files are removed from the index. If `git rm` reports that `CaptureStatusPill.test.tsx` no longer exists because it was moved in Step 1, run only:

```bash
git rm frontend/src/nav/CaptureStatusPill.tsx
```

- [ ] **Step 5: Run capture and TopNav tests**

Run:

```bash
cd frontend
npx vitest run src/nav/CaptureInlineStatus.test.tsx src/nav/TopNav.test.tsx tests/component/TopNav.test.tsx
```

Expected: PASS, except possible `h-top-nav` build/type concerns deferred to Task 3.

- [ ] **Step 6: Commit Task 2**

```bash
git add frontend/src/nav/CaptureInlineStatus.tsx frontend/src/nav/CaptureInlineStatus.test.tsx frontend/src/nav/TopNav.tsx
git add -u frontend/src/nav
git commit -m "feat: add inline capture status"
```

---

### Task 3: App Shell, Tokens, And Design Docs

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`
- Modify: `frontend/src/styles/design-tokens.ts`
- Regenerate: `frontend/src/styles/tokens.css`
- Regenerate: `frontend/src/styles/tokens.generated.ts`
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: `TopNav` default export from `frontend/src/nav/TopNav.tsx`
- Consumes: nav item arrays from `frontend/src/nav/items.ts`
- Produces: App shell grid with root rows `var(--top-nav-h) minmax(0, 1fr)`
- Produces: content grid columns `1fr var(--rail-w)` or `1fr var(--watchlist-panel-w) var(--rail-w)`

- [ ] **Step 1: Add focused App shell layout tests**

Modify `frontend/src/App.test.tsx`:

1. Replace the `CaptureStatusPill` mock with a `TopNav`-safe mock if needed:

```tsx
vi.mock('./nav/CaptureInlineStatus', () => ({
  CaptureInlineStatus: () => null,
}));
```

2. Add imports:

```tsx
import { screen } from '@testing-library/react';
import { useRightRailStore } from './state/rightRail';
```

3. Add these tests after the document-title `describe` block:

```tsx
describe('App shell layout', () => {
  it('renders a two-row shell with top nav and no left nav column', () => {
    const { container } = wrap(<div>Heatmap</div>, '/heatmap');
    const shell = container.firstElementChild as HTMLElement;
    const contentGrid = screen.getByTestId('app-content-grid');

    expect(screen.getByRole('navigation', { name: '주요 메뉴' })).toBeInTheDocument();
    expect(shell.style.gridTemplateRows).toBe('var(--top-nav-h) minmax(0, 1fr)');
    expect(shell.style.gridTemplateColumns).toBe('');
    expect(contentGrid).toHaveStyle({ gridTemplateColumns: '1fr var(--rail-w)' });
  });

  it('adds exactly one right panel column before the fixed rail when a panel is open', () => {
    useRightRailStore.setState({ activePanel: 'watchlist', lastPanel: 'watchlist' });

    wrap(<div>Heatmap</div>, '/heatmap');

    expect(screen.getByTestId('app-content-grid')).toHaveStyle({
      gridTemplateColumns: '1fr var(--watchlist-panel-w) var(--rail-w)',
    });
  });
});
```

4. In `beforeEach`, reset right rail state:

```tsx
beforeEach(() => {
  document.title = 'before-test';
  useRightRailStore.setState({ activePanel: null, lastPanel: 'watchlist' });
});
```

- [ ] **Step 2: Optional quick baseline check**

Run:

```bash
cd frontend
npx vitest run src/App.test.tsx
```

Expected: The command fails until `App` is converted to the new shell. This check is optional; for a simple execution, continue directly to Step 3 and run the task test at Step 7.

- [ ] **Step 3: Update App shell**

Modify `frontend/src/App.tsx` to import `TopNav` and nav items:

```tsx
import { Outlet, useLocation } from 'react-router';
import TopNav from './nav/TopNav';
import { SYSTEM_NAV_ITEMS, WORKSPACE_NAV_ITEMS } from './nav/items';
import RightRail from './rightrail/RightRail';
import { WatchlistDrawer } from './watchlist/WatchlistDrawer';
import { ScreenerDrawer } from './screener/ScreenerDrawer';
import { StudyViewsDrawer } from './studyViews/StudyViewsDrawer';
import { useRightRailStore } from './state/rightRail';
import { useEventStream } from './api/eventStream';
import { useInventoryRecaptureOriginsCleanup } from './inventory/useInventoryRecaptureOrigins';
import { useCaptureQueueSync } from './capture/useCaptureQueue';
import { useStaticDocumentTitle } from './util/useDocumentTitle';
```

Then replace the shell return with:

```tsx
  const contentCols = `1fr${activePanel ? ' var(--watchlist-panel-w)' : ''} var(--rail-w)`;
  const { pathname } = useLocation();
  const staticTitle = pathname === '/live' ? null : STATIC_ROUTE_TITLES.get(pathname) ?? 'hoga-ops';

  return (
    <div
      className="grid h-screen w-screen overflow-hidden"
      style={{
        gridTemplateRows: 'var(--top-nav-h) minmax(0, 1fr)',
      }}
    >
      {staticTitle !== null && <StaticDocumentTitle title={staticTitle} />}
      <TopNav />
      <div
        data-testid="app-content-grid"
        className="grid min-h-0 min-w-0 overflow-hidden"
        style={{ gridTemplateColumns: contentCols }}
      >
        <main className="min-w-0 overflow-hidden"><Outlet /></main>
        {activePanel === 'watchlist' && <WatchlistDrawer />}
        {activePanel === 'screener' && <ScreenerDrawer />}
        {activePanel === 'savedViews' && <StudyViewsDrawer />}
        <RightRail />
      </div>
    </div>
  );
```

Remove the old `LeftNav` import and the old `cols` variable.

- [ ] **Step 4: Add the top-nav height token**

Modify `frontend/src/styles/design-tokens.ts` in the layout heights block:

```ts
  'h-top-nav':          { rem: 2,       baseIntentPx: 32, usage: 'Global top navigation row' },
```

Do not leave `nav-w` in use. Before removing `nav-w`, run:

```bash
rg -n "nav-w|--nav-w|width\\.nav|LeftNav fixed column" frontend/src DESIGN.md docs
```

If only token/docs references remain, remove this line from `SIZE_TOKENS`:

```ts
  'nav-w':              { rem: 13.125,  baseIntentPx: 210, usage: 'LeftNav fixed column width' },
```

- [ ] **Step 5: Regenerate token artifacts**

Run:

```bash
cd frontend
npm run gen:tokens
```

Expected: `frontend/src/styles/tokens.css`, `frontend/src/styles/tokens.generated.ts`, and `DESIGN.md` update. Confirm `--top-nav-h` exists and `--nav-w` is gone if no longer referenced:

```bash
rg -n "top-nav-h|nav-w|--nav-w" src/styles ../DESIGN.md
```

- [ ] **Step 6: Update DESIGN.md prose**

Edit `DESIGN.md` so the layout section says:

```md
- **App shell:**
  - Top-level: rows `var(--top-nav-h) minmax(0, 1fr)` (minimal top menu + content); content columns are `1fr var(--rail-w)` plus an optional `var(--watchlist-panel-w)` before the rail when a right-rail panel is open.
```

Replace the page-title sentence with:

```md
- **No redundant page title:** the active top menu item is the page label, so a page never repeats its own name. Pages expose a *title-less* control bar (search / counts / actions) at the top of their card. (See the `/live` header: search only, with the active symbol shown in the status bar below.)
```

If the decisions log still says right-rail active state "matches LeftNav", change that phrase to:

```md
matches the app-shell active state
```

- [ ] **Step 7: Run shell and nav tests**

Run:

```bash
cd frontend
npx vitest run src/App.test.tsx src/nav/TopNav.test.tsx tests/component/TopNav.test.tsx src/nav/CaptureInlineStatus.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/styles/design-tokens.ts frontend/src/styles/tokens.css frontend/src/styles/tokens.generated.ts DESIGN.md
git commit -m "feat: move app navigation to top menu"
```

---

### Task 4: Retire Vertical Nav Code And Verify End-To-End

**Files:**
- Delete if still present: `frontend/src/nav/LeftNav.tsx`
- Delete if still present and unused: `frontend/src/nav/NavItem.tsx`
- Modify comments: `frontend/src/styles/tokens.css`, `frontend/src/styles/design-tokens.ts`, `frontend/src/rightrail/RightRail.tsx`, `frontend/src/capture/useCaptureQueue.ts`
- Verify no stale tests: `frontend/src/nav/LeftNav.test.tsx`, `frontend/tests/component/LeftNav.test.tsx`

**Interfaces:**
- Consumes: completed `TopNav`, `CaptureInlineStatus`, `items.ts`, and app shell from Tasks 1-3.
- Produces: no production imports of `LeftNav`, `NavItem`, or `CaptureStatusPill`.

- [ ] **Step 1: Search for stale vertical nav references**

Run:

```bash
rg -n "LeftNav|NavItem|CaptureStatusPill|left nav|left-nav|--nav-w|nav-w" frontend/src frontend/tests DESIGN.md docs/superpowers/specs/2026-06-30-minimal-top-menu-design.md
```

Expected remaining references before cleanup: spec references are allowed; production references should be comments or files scheduled for deletion.

- [ ] **Step 2: Delete obsolete vertical nav files**

Run:

```bash
test ! -f frontend/src/nav/LeftNav.tsx || git rm frontend/src/nav/LeftNav.tsx
test ! -f frontend/src/nav/NavItem.tsx || git rm frontend/src/nav/NavItem.tsx
```

Expected: files are removed if still present. If `NavItem.tsx` has a remaining production import outside `LeftNav`, stop and convert that import to `TopNavItem` or keep `NavItem.tsx` only after documenting why in the commit message.

- [ ] **Step 3: Update stale comments**

Apply these comment-level changes where matching text still exists:

In `frontend/src/rightrail/RightRail.tsx`, replace:

```ts
// Active = tint bg + neutral text, matching NavItem (no triple-teal). The icon
// fill (currentColor=fg) is a shape signal, not a 2nd accent.
```

with:

```ts
// Active = tint bg + neutral text. The icon fill (currentColor=fg) is a shape
// signal, not a 2nd accent.
```

In `frontend/src/capture/useCaptureQueue.ts`, replace any comment phrase like:

```ts
CaptureStatusPill in the always-on nav
```

with:

```ts
CaptureInlineStatus in the always-on top nav
```

In token comments or docs, replace `LeftNav fixed column width` with no reference because `nav-w` should be gone. If `nav-w` is still intentionally retained, change the usage to:

```ts
Retired left navigation width (do not use for app shell)
```

- [ ] **Step 4: Verify stale references are gone**

Run:

```bash
rg -n "LeftNav|NavItem|CaptureStatusPill|--nav-w|nav-w" frontend/src frontend/tests DESIGN.md
```

Expected: no output for `frontend/src` and `frontend/tests`. `DESIGN.md` may contain historical decision-log text only if it clearly says retired; prefer no `nav-w` references.

- [ ] **Step 5: Run targeted frontend tests**

Run:

```bash
cd frontend
npx vitest run src/nav/TopNav.test.tsx tests/component/TopNav.test.tsx src/nav/CaptureInlineStatus.test.tsx src/App.test.tsx src/rightrail/RightRail.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run build**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS. If TypeScript reports stale imports, remove the import and rerun build before continuing.

- [ ] **Step 7: Manual browser verification**

Start the dev server:

```bash
cd frontend
npm run dev -- --host 0.0.0.0
```

Open `/live` in the browser and verify:

- The top menu is 40px tall.
- The brand shows `hoga-ops` and does not show `orderbook replay`.
- The active route is emphasized only by brighter/bolder text.
- There is no left gutter where the old 262.5px nav column used to be.
- Right rail still appears on the right.
- Opening 관심, 스크리너, and 저장뷰 panels adds a panel on the right, not the left.

- [ ] **Step 8: Commit Task 4**

```bash
git add -u frontend/src frontend/tests DESIGN.md
git commit -m "refactor: remove retired left navigation"
```

---

## Self-Review

**Spec coverage:** The plan covers top menu height, text-only active state, subtitle removal, route order, capture inline behavior, right rail preservation, document-title preservation, token/doc updates, and vertical-nav cleanup.

**Placeholder scan:** No `TBD`, `TODO`, "implement later", or empty test instructions remain. Each task has concrete files, commands, expected results, and code snippets.

**Practicality check:** The plan does not require a strict red/green loop for every small move. Optional baseline checks are included for safety, but the required verification is task-level targeted tests, final build, and manual `/live` QA.

**Type consistency:** `TopNav`, `TopNavItem`, `CaptureInlineStatus`, `WORKSPACE_NAV_ITEMS`, and `SYSTEM_NAV_ITEMS` are consistently named across tasks. The App shell consumes `TopNav` and `items.ts`; tests import the same names.

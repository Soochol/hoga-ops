# Live/Study Drawing Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top-toolbar drawing popover with a shared 44px left drawing rail in both `/live` and `/study`.

**Architecture:** Add a focused `LiveDrawingRail` component that only talks to `useDrawingsStore` and the existing `TOOLS` registry. Add a small `ChartDrawingShell` wrapper so `/live` and `/study` share the same rail-plus-chart layout. Remove the old `LiveDrawingMenu` path after the rail is wired.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind token classes, Vitest, Testing Library.

## Global Constraints

- Scope is `/live` and `/study` chart workspaces.
- The rail exposes only the drawing capabilities that already exist today: select, horizontal line, trendline, pencil, eraser, and clear all.
- Fixed rail width is 44px.
- Tool labels, glyphs, and ordering stay sourced from `TOOLS` / `DRAWABLE_TOOLS_ORDER`.
- Do not add a new icon dependency.
- Do not add new drawing primitives, style controls, persistence rules, or keyboard shortcuts.
- Do not refactor `DrawingOverlay`, drawing persistence, coordinate conversion, or tool behavior unless a test failure shows the rail integration exposed a real coupling issue.
- Remove `LiveDrawingMenu`, its menu-specific tests, dead imports, unused portal/popover helpers, and duplicate drawing tool lists.
- Run targeted Vitest files touched by the change and run the frontend build before declaring implementation complete.

---

## File Structure

- Create `frontend/src/live/LiveDrawingRail.tsx`: icon-only drawing rail. Owns drawing UI only; reads `activeTool`, writes `setActiveTool`, and calls `clearAll`.
- Create `frontend/src/live/LiveDrawingRail.test.tsx`: focused rail behavior tests.
- Create `frontend/src/live/ChartDrawingShell.tsx`: shared `44px + chart` layout wrapper.
- Create `frontend/src/live/ChartDrawingShell.test.tsx`: verifies shared layout renders the rail and chart body.
- Modify `frontend/src/live/LiveToolbar.tsx`: remove the drawing menu import and render site.
- Modify `frontend/src/live/LiveToolbar.test.tsx`: assert the top drawing button is gone and save control still renders after existing action buttons.
- Modify `frontend/src/live/LiveWorkarea.tsx`: wrap the chart root with `ChartDrawingShell`.
- Modify `frontend/src/live/LiveWorkarea.test.tsx`: assert the rail appears inside the live chart panel.
- Modify `frontend/src/studyViews/StudyPage.tsx`: wrap the ready-state study chart with `ChartDrawingShell`.
- Modify `frontend/src/studyViews/StudyPage.test.tsx`: assert the rail appears beside a ready study chart.
- Delete `frontend/src/live/LiveDrawingMenu.tsx`.
- Delete `frontend/src/live/LiveDrawingMenu.test.tsx`.

---

### Task 1: Add `LiveDrawingRail`

**Files:**
- Create: `frontend/src/live/LiveDrawingRail.tsx`
- Create: `frontend/src/live/LiveDrawingRail.test.tsx`

**Interfaces:**
- Consumes: `useDrawingsStore`, `TOOLS`, `DRAWABLE_TOOLS_ORDER`, `DrawingTool`
- Produces: `LiveDrawingRail(): JSX.Element`

- [ ] **Step 1: Write the failing rail tests**

Create `frontend/src/live/LiveDrawingRail.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import LiveDrawingRail from './LiveDrawingRail';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import { useDrawingsStore } from '../state/drawings';
import type { Drawing } from '../chart/drawing/types';

describe('LiveDrawingRail', () => {
  beforeEach(() => {
    localStorage.clear();
    useDrawingsStore.getState().__resetForTests();
  });

  it('renders the existing drawing tools from the central registry', () => {
    render(<LiveDrawingRail />);

    expect(screen.getByRole('toolbar', { name: '그리기 도구' })).toBeInTheDocument();
    const expected = ['select', ...DRAWABLE_TOOLS_ORDER].map((tool) => TOOLS[tool].label);
    for (const label of expected) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '모두 지우기' })).toBeInTheDocument();
  });

  it('switches the active drawing tool and exposes pressed state', () => {
    render(<LiveDrawingRail />);

    fireEvent.click(screen.getByRole('button', { name: TOOLS.trendline.label }));

    expect(useDrawingsStore.getState().activeTool).toBe('trendline');
    expect(screen.getByRole('button', { name: TOOLS.trendline.label })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: TOOLS.select.label })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears drawings through the drawing store', () => {
    const drawing: Drawing = {
      id: 'h1',
      kind: 'hline',
      price: 100,
      color: '#14B8A6',
      width: 2,
      lineStyle: 'solid',
      paneId: 'candle',
    };
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().add(drawing);
    expect(useDrawingsStore.getState().drawingsFor('005930')).toHaveLength(1);

    render(<LiveDrawingRail />);
    fireEvent.click(screen.getByRole('button', { name: '모두 지우기' }));

    expect(useDrawingsStore.getState().drawingsFor('005930')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/live/LiveDrawingRail.test.tsx
```

Expected: FAIL because `./LiveDrawingRail` does not exist.

- [ ] **Step 3: Implement `LiveDrawingRail`**

Create `frontend/src/live/LiveDrawingRail.tsx`:

```tsx
import type { DrawingTool } from '../chart/drawing/types';
import { DRAWABLE_TOOLS_ORDER, TOOLS } from '../chart/drawing/tools';
import { useDrawingsStore } from '../state/drawings';

const TOOL_ORDER: readonly DrawingTool[] = ['select', ...DRAWABLE_TOOLS_ORDER];

function buttonClass(active: boolean): string {
  return [
    'flex h-8 w-8 items-center justify-center rounded-md border text-sm font-mono transition-colors',
    active
      ? 'border-accent bg-accent text-accent-fg'
      : 'border-transparent bg-transparent text-fg-dim hover:border-border-strong hover:bg-bg-input-hover hover:text-fg',
  ].join(' ');
}

export default function LiveDrawingRail() {
  const activeTool = useDrawingsStore((state) => state.activeTool);
  const setActiveTool = useDrawingsStore((state) => state.setActiveTool);
  const clearAll = useDrawingsStore((state) => state.clearAll);

  return (
    <aside
      aria-label="그리기 도구"
      role="toolbar"
      data-testid="live-drawing-rail"
      className="flex h-full w-[44px] shrink-0 flex-col items-center border-r border-border bg-bg-card/80 py-2"
    >
      <div className="flex flex-col items-center gap-1">
        {TOOL_ORDER.map((tool) => {
          const spec = TOOLS[tool];
          const active = activeTool === tool;
          return (
            <button
              key={tool}
              type="button"
              aria-label={spec.label}
              aria-pressed={active}
              title={spec.label}
              className={buttonClass(active)}
              onClick={() => setActiveTool(tool)}
            >
              <span aria-hidden="true">{spec.glyph}</span>
            </button>
          );
        })}
      </div>
      <div className="my-2 h-px w-8 bg-border" />
      <button
        type="button"
        aria-label="모두 지우기"
        title="모두 지우기"
        className={buttonClass(false)}
        onClick={clearAll}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd frontend && npx vitest run src/live/LiveDrawingRail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/LiveDrawingRail.tsx frontend/src/live/LiveDrawingRail.test.tsx
git commit -m "feat: add live drawing rail"
```

---

### Task 2: Add Shared `ChartDrawingShell`

**Files:**
- Create: `frontend/src/live/ChartDrawingShell.tsx`
- Create: `frontend/src/live/ChartDrawingShell.test.tsx`

**Interfaces:**
- Consumes: `LiveDrawingRail`
- Produces: `ChartDrawingShell({ children }: { children: ReactNode }): JSX.Element`

- [ ] **Step 1: Write the failing shell test**

Create `frontend/src/live/ChartDrawingShell.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartDrawingShell } from './ChartDrawingShell';

describe('ChartDrawingShell', () => {
  it('renders the drawing rail beside the chart body in the shared 44px layout', () => {
    render(
      <ChartDrawingShell>
        <div data-testid="chart-body">chart</div>
      </ChartDrawingShell>,
    );

    expect(screen.getByTestId('chart-drawing-shell')).toHaveClass('grid-cols-[44px_minmax(0,1fr)]');
    expect(screen.getByTestId('live-drawing-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chart-body')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/live/ChartDrawingShell.test.tsx
```

Expected: FAIL because `./ChartDrawingShell` does not exist.

- [ ] **Step 3: Implement `ChartDrawingShell`**

Create `frontend/src/live/ChartDrawingShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import LiveDrawingRail from './LiveDrawingRail';

export function ChartDrawingShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="chart-drawing-shell"
      className="grid h-full min-h-0 min-w-0 grid-cols-[44px_minmax(0,1fr)] overflow-hidden"
    >
      <LiveDrawingRail />
      <div className="min-h-0 min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd frontend && npx vitest run src/live/ChartDrawingShell.test.tsx src/live/LiveDrawingRail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/ChartDrawingShell.tsx frontend/src/live/ChartDrawingShell.test.tsx
git commit -m "feat: add chart drawing shell"
```

---

### Task 3: Remove Drawing Menu From Top Toolbar

**Files:**
- Modify: `frontend/src/live/LiveToolbar.tsx:1-52`
- Modify: `frontend/src/live/LiveToolbar.test.tsx:178-186`
- Delete: `frontend/src/live/LiveDrawingMenu.tsx`
- Delete: `frontend/src/live/LiveDrawingMenu.test.tsx`

**Interfaces:**
- Consumes: `LiveChartActionButtons({ onOpenIndicators, onOpenSettings, studySaveControl })`
- Produces: Top toolbar action buttons without the old drawing menu

- [ ] **Step 1: Write the failing toolbar test update**

Replace the final test in `frontend/src/live/LiveToolbar.test.tsx` with:

```tsx
  it('renders current-view save after chart action buttons without the old drawing menu', () => {
    const studySaveControl = <button type="button">현재 뷰 저장</button>;
    render(<LiveToolbar onOpenIndicators={() => {}} onOpenSettings={() => {}} studySaveControl={studySaveControl} />);

    expect(screen.queryByRole('button', { name: '그리기' })).toBeNull();
    const settings = screen.getByTestId('live-settings-button');
    const save = screen.getByRole('button', { name: '현재 뷰 저장' });

    expect(settings.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx
```

Expected: FAIL because the "그리기" button still renders.

- [ ] **Step 3: Remove `LiveDrawingMenu` from `LiveToolbar`**

Edit `frontend/src/live/LiveToolbar.tsx`.

Remove this import:

```tsx
import LiveDrawingMenu from './LiveDrawingMenu';
```

Remove this render line from `LiveChartActionButtons`:

```tsx
      <LiveDrawingMenu />
```

The resulting `LiveChartActionButtons` body should be:

```tsx
export function LiveChartActionButtons({ onOpenIndicators, onOpenSettings, studySaveControl }: ActionButtonsProps) {
  return (
    <>
      <IconToolbarButton
        data-testid="live-indicators-button"
        onClick={onOpenIndicators}
        aria-label="보조지표"
        className="ml-1"
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
      >
        <span>보조지표</span>
      </IconToolbarButton>
      <IconToolbarButton
        data-testid="live-settings-button"
        onClick={onOpenSettings}
        aria-label="설정"
        icon={(
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        )}
      >
        <span>설정</span>
      </IconToolbarButton>
      {studySaveControl}
    </>
  );
}
```

- [ ] **Step 4: Delete the retired menu files**

Run:

```bash
git rm frontend/src/live/LiveDrawingMenu.tsx frontend/src/live/LiveDrawingMenu.test.tsx
```

- [ ] **Step 5: Verify no references remain**

Run:

```bash
rg -n "LiveDrawingMenu|data-drawing-menu|data-drawing-menu-button|data-drawing-clear-all" frontend/src
```

Expected: no output.

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
cd frontend && npx vitest run src/live/LiveToolbar.test.tsx src/live/LiveDrawingRail.test.tsx src/live/ChartDrawingShell.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/live/LiveToolbar.tsx frontend/src/live/LiveToolbar.test.tsx
git add -u frontend/src/live/LiveDrawingMenu.tsx frontend/src/live/LiveDrawingMenu.test.tsx
git commit -m "refactor: remove top drawing menu"
```

---

### Task 4: Wire Drawing Rail Into `/live` and `/study`

**Files:**
- Modify: `frontend/src/live/LiveWorkarea.tsx:1-20,363-386`
- Modify: `frontend/src/live/LiveWorkarea.test.tsx`
- Modify: `frontend/src/studyViews/StudyPage.tsx:1-30,505-530`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Interfaces:**
- Consumes: `ChartDrawingShell({ children })`
- Produces: `LiveChartRoot` mounted inside the shared rail layout in both workspaces

- [ ] **Step 1: Write failing `/live` wiring assertion**

In `frontend/src/live/LiveWorkarea.test.tsx`, extend the existing test named `renders the toolbar inside the chart panel and sidebar beside it` by adding this assertion after the toolbar assertion:

```tsx
    expect(chartPanel).toContainElement(screen.getByTestId('live-drawing-rail'));
```

The full assertion block should be:

```tsx
    const chartPanel = screen.getByTestId('live-chart-panel');
    expect(chartPanel).toContainElement(screen.getByTestId('live-toolbar'));
    expect(chartPanel).toContainElement(screen.getByTestId('live-drawing-rail'));
    expect(screen.getByTestId('live-workarea-splitter')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByTestId('sidebar-stub')).toBeInTheDocument();
```

- [ ] **Step 2: Write failing `/study` wiring assertion**

In `frontend/src/studyViews/StudyPage.test.tsx`, extend the test named `renders a v2 reference view from raw range data without snapshot overrides` by adding this assertion after the `live-chart-root-stub` assertion:

```tsx
    expect(screen.getByTestId('live-drawing-rail')).toBeInTheDocument();
```

The beginning of the assertion block should be:

```tsx
    expect(screen.getByTestId('study-page-primary')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('study-page-primary')).toHaveClass('border');
    expect(screen.getByTestId('live-chart-root-stub')).toBeTruthy();
    expect(screen.getByTestId('live-drawing-rail')).toBeInTheDocument();
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx src/studyViews/StudyPage.test.tsx
```

Expected: FAIL because `live-drawing-rail` is not mounted in either workspace.

- [ ] **Step 4: Wire `/live`**

In `frontend/src/live/LiveWorkarea.tsx`, add this import near the other local live imports:

```tsx
import { ChartDrawingShell } from './ChartDrawingShell';
```

Replace the chart body wrapper at `frontend/src/live/LiveWorkarea.tsx:363`:

```tsx
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <LiveChartRoot
```

with:

```tsx
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <ChartDrawingShell>
                <LiveChartRoot
```

Then close the shell after the `LiveChartRoot` closing tag:

```tsx
                onCandleBasisHover={rankingAllowed ? handleCandleBasisHover : undefined}
                onCandleBasisClick={rankingAllowed ? handleCandleBasisClick : undefined}
              />
            </ChartDrawingShell>
          </div>
```

- [ ] **Step 5: Wire `/study`**

In `frontend/src/studyViews/StudyPage.tsx`, add this import with the live imports:

```tsx
import { ChartDrawingShell } from '../live/ChartDrawingShell';
```

Replace the ready-state chart branch at `frontend/src/studyViews/StudyPage.tsx:510`:

```tsx
              ) : activeViewModel.status === 'ready' ? (
                <LiveChartRoot
```

with:

```tsx
              ) : activeViewModel.status === 'ready' ? (
                <ChartDrawingShell>
                  <LiveChartRoot
```

Then close the shell after the `LiveChartRoot` closing tag:

```tsx
                  onViewportCaptureReady={handleViewportCaptureReady}
                  onCursorActiveChange={setIsCursorActive}
                />
              </ChartDrawingShell>
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
cd frontend && npx vitest run src/live/LiveWorkarea.test.tsx src/studyViews/StudyPage.test.tsx src/live/ChartDrawingShell.test.tsx src/live/LiveDrawingRail.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveWorkarea.test.tsx
git add frontend/src/studyViews/StudyPage.tsx frontend/src/studyViews/StudyPage.test.tsx
git commit -m "feat: show drawing rail in live and study"
```

---

### Task 5: Final Cleanup and Verification

**Files:**
- Inspect: `frontend/src/live`
- Inspect: `frontend/src/studyViews`
- Inspect: `frontend/src/chart/drawing/tools.ts`

**Interfaces:**
- Consumes: all previous task outputs
- Produces: verified implementation with no retired menu references

- [ ] **Step 1: Check for retired menu references**

Run:

```bash
rg -n "LiveDrawingMenu|data-drawing-menu|data-drawing-tool|data-drawing-clear-all|useDismissablePopover|useClampedFixedPosition" frontend/src
```

Expected: no output for `LiveDrawingMenu`, `data-drawing-menu`, `data-drawing-tool`, or `data-drawing-clear-all`. Output for `useDismissablePopover` or `useClampedFixedPosition` is acceptable only when another non-drawing component imports those helpers.

- [ ] **Step 2: Check for duplicate drawing tool lists**

Run:

```bash
rg -n "hline|trendline|pencil|eraser|DRAWABLE_TOOLS_ORDER|TOOL_ORDER" frontend/src/live frontend/src/chart/drawing
```

Expected: the only live UI tool ordering is `TOOL_ORDER` in `frontend/src/live/LiveDrawingRail.tsx`, sourced from `DRAWABLE_TOOLS_ORDER`. The drawing behavior registry remains in `frontend/src/chart/drawing/tools.ts`.

- [ ] **Step 3: Run targeted frontend tests**

Run:

```bash
cd frontend && npx vitest run \
  src/live/LiveDrawingRail.test.tsx \
  src/live/ChartDrawingShell.test.tsx \
  src/live/LiveToolbar.test.tsx \
  src/live/LiveWorkarea.test.tsx \
  src/studyViews/StudyPage.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS with TypeScript and Vite build completing successfully.

- [ ] **Step 5: Commit final cleanup if any files changed**

Run:

```bash
git status --short
```

If files changed during cleanup, commit them:

```bash
git add frontend/src
git commit -m "chore: verify drawing rail cleanup"
```

Expected: no uncommitted source changes after the commit.

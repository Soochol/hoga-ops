# Screener Panel Chart Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag a Screener Panel result row onto the `/live` chart workarea to replace the active live tab's stock code.

**Architecture:** Reuse the existing `entryDrag` chart-drop seam owned by `LiveWorkarea`. `ScreenerDrawer` adds a `DndContext` around the result list and renders rows through a `useDraggable` wrapper; chart drops call the existing `useJumpToLive` path, while non-chart drops are ignored.

**Tech Stack:** React + TypeScript, `@dnd-kit/core`, Zustand `useEntryDragStore`, React Router, Vitest + Testing Library jsdom.

**Spec:** `docs/superpowers/specs/2026-06-16-screener-chart-drag-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `frontend/src/screener/ScreenerDrawer.tsx` | Right Rail Screener Panel UI, scan controls, result row rendering, click navigation | Add dnd-kit drag context, `dropPoint`, `DraggableScreenerRow`, and chart-drop handlers |
| `frontend/src/screener/ScreenerDrawer.test.tsx` | Screener Panel behavior tests | Mock dnd-kit wiring and add chart-drop/no-op/cleanup tests |
| `docs/superpowers/specs/2026-06-16-screener-chart-drag-design.md` | Approved design | Already committed; no implementation change |

Do not modify `QuoteRow` unless TypeScript proves the existing drag props are insufficient. It already accepts `dragListeners`, `dragAttributes`, `sortableRef`, `sortableStyle`, and `dragging`.

---

## Task 1: Add Screener Drag Wiring Tests

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.test.tsx`
- Test: `frontend/src/screener/ScreenerDrawer.test.tsx`

- [ ] **Step 1: Add dnd-kit mock state and imports**

Change the imports at the top of `frontend/src/screener/ScreenerDrawer.test.tsx`.

Replace:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
```

with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
```

Add this import beside the existing store imports:

```tsx
import { useEntryDragStore } from '../state/entryDrag';
```

Then add this mock block before importing `ScreenerDrawer`:

```tsx
type DndHandlers = {
  onDragStart: null | ((e: unknown) => void);
  onDragMove: null | ((e: unknown) => void);
  onDragEnd: null | ((e: unknown) => void);
  onDragCancel: null | (() => void);
};

const dnd = vi.hoisted<DndHandlers>(() => ({
  onDragStart: null,
  onDragMove: null,
  onDragEnd: null,
  onDragCancel: null,
}));

vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragStart,
      onDragMove,
      onDragEnd,
      onDragCancel,
    }: {
      children: React.ReactNode;
      onDragStart?: (e: unknown) => void;
      onDragMove?: (e: unknown) => void;
      onDragEnd?: (e: unknown) => void;
      onDragCancel?: () => void;
    }) => {
      dnd.onDragStart = onDragStart ?? null;
      dnd.onDragMove = onDragMove ?? null;
      dnd.onDragEnd = onDragEnd ?? null;
      dnd.onDragCancel = onDragCancel ?? null;
      return <>{children}</>;
    },
    useDraggable: () => ({
      setNodeRef: () => {},
      listeners: {} as DraggableSyntheticListeners,
      attributes: {} as DraggableAttributes,
      transform: null,
      isDragging: false,
    }),
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});
```

Keep `import { ScreenerDrawer } from './ScreenerDrawer';` after the `vi.mock` block so the component receives the mocked dnd-kit module.

- [ ] **Step 2: Reset dnd and entry drag state in `beforeEach`**

Inside the existing `beforeEach`, after `localStorage.clear();`, add:

```tsx
dnd.onDragStart = null;
dnd.onDragMove = null;
dnd.onDragEnd = null;
dnd.onDragCancel = null;
useEntryDragStore.setState({ draggingCode: null, overChart: false, hitTestChart: null });
```

- [ ] **Step 3: Add failing chart-drop tests**

Append these tests inside the existing `describe('ScreenerDrawer', () => { ... })` block:

```tsx
it('dragging a screener row over the chart changes the active code', async () => {
  vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
  useScreenerPanelStore.setState({
    selectedSavedId: 's1',
    lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
  });
  const hitTest = (clientX: number) => clientX < 800;
  useEntryDragStore.getState().registerChartTarget(hitTest);
  try {
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/inventory') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    dnd.onDragStart!({
      active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
    });
    expect(useEntryDragStore.getState().draggingCode).toBe('005930');

    dnd.onDragMove!({
      active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: -500, y: 0 },
    });
    expect(useEntryDragStore.getState().overChart).toBe(true);

    dnd.onDragEnd!({
      active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: -500, y: 0 },
    });

    expect(useLivePageStore.getState().activeCode).toBe('005930');
    expect(useEntryDragStore.getState().draggingCode).toBeNull();
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/live'));
  } finally {
    useEntryDragStore.getState().clearChartTarget(hitTest);
  }
});

it('dropping a screener row outside the chart is a no-op', async () => {
  vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
  useScreenerPanelStore.setState({
    selectedSavedId: 's1',
    lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
  });
  const hitTest = (clientX: number) => clientX < 800;
  useEntryDragStore.getState().registerChartTarget(hitTest);
  try {
    render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

    dnd.onDragStart!({
      active: { id: 'screener-entry:000660', data: { current: { type: 'screener-entry', code: '000660', name: 'SK하이닉스' } } },
    });
    dnd.onDragEnd!({
      active: { id: 'screener-entry:000660', data: { current: { type: 'screener-entry', code: '000660', name: 'SK하이닉스' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    expect(useLivePageStore.getState().activeCode).toBeNull();
    expect(useEntryDragStore.getState().draggingCode).toBeNull();
    expect(screen.getByTestId('pathname').textContent).toBe('/live');
  } finally {
    useEntryDragStore.getState().clearChartTarget(hitTest);
  }
});

it('cancelling a screener row drag clears the chart-drop state', async () => {
  vi.spyOn(savesApi, 'listSaves').mockResolvedValue({ schema_version: 1, saves: [SAVE] });
  useScreenerPanelStore.setState({
    selectedSavedId: 's1',
    lastScan: { savedId: 's1', savedName: '돌파+거래대금', rows: ROWS, scanStatus: 'ok', warnings: [] },
  });
  render(<ScreenerDrawer />, { wrapper: wrap(qc(), '/live') });
  await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());

  dnd.onDragStart!({
    active: { id: 'screener-entry:005930', data: { current: { type: 'screener-entry', code: '005930', name: '삼성전자' } } },
  });
  useEntryDragStore.getState().setOverChart(true);
  dnd.onDragCancel!();

  expect(useEntryDragStore.getState().draggingCode).toBeNull();
  expect(useEntryDragStore.getState().overChart).toBe(false);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx
```

Expected: FAIL. The new tests should fail because `ScreenerDrawer` does not yet render `DndContext`; `dnd.onDragStart` and related handlers remain `null`.

- [ ] **Step 5: Commit the failing tests**

Do not commit failing tests unless the project convention allows red commits. In this repository, keep the red test uncommitted and proceed to Task 2.

---

## Task 2: Implement Screener Chart Drag

**Files:**
- Modify: `frontend/src/screener/ScreenerDrawer.tsx`
- Test: `frontend/src/screener/ScreenerDrawer.test.tsx`

- [ ] **Step 1: Add imports**

In `frontend/src/screener/ScreenerDrawer.tsx`, replace:

```tsx
import { useEffect, useMemo } from 'react';
```

with:

```tsx
import { useEffect, useMemo } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
```

Add these imports beside the existing local imports:

```tsx
import { useEntryDragStore, isPointOnChart } from '../state/entryDrag';
import type { ScreenerRowLive } from './useScreenerRowsLive';
```

- [ ] **Step 2: Add drag helper and row component**

Add this code above the `ScreenerDrawer` component:

```tsx
const SCREENER_ENTRY_TYPE = 'screener-entry';

function screenerDraggableId(code: string): string {
  return `${SCREENER_ENTRY_TYPE}:${code}`;
}

function dropPoint(ev: { activatorEvent: Event | null; delta: { x: number; y: number } }): { x: number; y: number } | null {
  const a = ev.activatorEvent as (MouseEvent | PointerEvent) | null;
  if (!a || typeof a.clientX !== 'number' || typeof a.clientY !== 'number') return null;
  return { x: a.clientX + ev.delta.x, y: a.clientY + ev.delta.y };
}

function DraggableScreenerRow({
  row,
  active,
  onActivate,
}: {
  row: ScreenerRowLive;
  active: boolean;
  onActivate: () => void;
}) {
  const { setNodeRef, listeners, attributes, transform, isDragging } = useDraggable({
    id: screenerDraggableId(row.code),
    data: { type: SCREENER_ENTRY_TYPE, code: row.code, name: row.name },
  });
  return (
    <QuoteRow
      name={row.name}
      price={row.price}
      pct={row.change_pct}
      changeWon={row.change_won}
      active={active}
      ariaLabel={`${row.name} ${row.code} 차트 열기`}
      testId={`screener-row-${row.code}`}
      onClick={onActivate}
      trailingAction={<WatchlistHeartButton code={row.code} name={row.name} variant="row" />}
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition: undefined }}
      dragListeners={listeners}
      dragAttributes={attributes}
      dragging={isDragging}
    />
  );
}
```

- [ ] **Step 3: Add sensors and entry-drag store actions in `ScreenerDrawer`**

Inside `ScreenerDrawer`, after:

```tsx
const liveRows = useScreenerRowsLive(scanRows);
```

add:

```tsx
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
const startEntryDrag = useEntryDragStore((s) => s.startDrag);
const setOverChart = useEntryDragStore((s) => s.setOverChart);
const endEntryDrag = useEntryDragStore((s) => s.endDrag);
```

- [ ] **Step 4: Add drag event handlers in `ScreenerDrawer`**

Still inside `ScreenerDrawer`, after the store action constants from Step 3, add:

```tsx
const onDragStart = (ev: DragStartEvent) => {
  if (ev.active.data.current?.type !== SCREENER_ENTRY_TYPE) return;
  const d = ev.active.data.current as { code?: string };
  if (d.code) startEntryDrag(d.code);
};

const onDragMove = (ev: DragMoveEvent) => {
  if (ev.active.data.current?.type !== SCREENER_ENTRY_TYPE) return;
  setOverChart(isPointOnChart(dropPoint(ev)));
};

const onDragCancel = (_ev: DragCancelEvent) => {
  endEntryDrag();
};

const onDragEnd = (ev: DragEndEvent) => {
  const wasScreenerEntry = ev.active.data.current?.type === SCREENER_ENTRY_TYPE;
  endEntryDrag();
  if (!wasScreenerEntry || !isPointOnChart(dropPoint(ev))) return;
  const d = ev.active.data.current as { code?: string; name?: string } | undefined;
  if (d?.code) openLive(d.code, d.name);
};
```

- [ ] **Step 5: Wrap the rendered result rows in `DndContext`**

Find the non-empty result list rendering:

```tsx
<ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
  {liveRows.map((r) => (
    <QuoteRow
      key={r.code}
      name={r.name}
      price={r.price}
      pct={r.change_pct}
      changeWon={r.change_won}
      active={r.code === activeCode}
      ariaLabel={`${r.name} ${r.code} 차트 열기`}
      testId={`screener-row-${r.code}`}
      onClick={() => openLive(r.code, r.name)}
      trailingAction={<WatchlistHeartButton code={r.code} name={r.name} variant="row" />}
    />
  ))}
</ul>
```

Replace it with:

```tsx
<DndContext
  sensors={sensors}
  onDragStart={onDragStart}
  onDragMove={onDragMove}
  onDragEnd={onDragEnd}
  onDragCancel={onDragCancel}
>
  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
    {liveRows.map((r) => (
      <DraggableScreenerRow
        key={r.code}
        row={r}
        active={r.code === activeCode}
        onActivate={() => openLive(r.code, r.name)}
      />
    ))}
  </ul>
</DndContext>
```

- [ ] **Step 6: Run the focused test**

Run:

```bash
cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx
```

Expected: PASS. The file should include the original 18 tests plus the 3 new drag tests.

- [ ] **Step 7: Commit implementation and tests**

Run:

```bash
git add frontend/src/screener/ScreenerDrawer.tsx frontend/src/screener/ScreenerDrawer.test.tsx
git commit -m "feat(screener): drag result rows onto live chart"
```

---

## Task 3: Final Verification

**Files:**
- Verify: `frontend/src/screener/ScreenerDrawer.tsx`
- Verify: `frontend/src/screener/ScreenerDrawer.test.tsx`
- Verify: `frontend/src/watchlist/WatchlistDrawer.drag.test.tsx`

- [ ] **Step 1: Run focused screener tests**

Run:

```bash
cd frontend && npx vitest run src/screener/ScreenerDrawer.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run adjacent drag seam regression tests**

Run:

```bash
cd frontend && npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx src/rightrail/QuoteRow.test.tsx
```

Expected: PASS. This verifies the existing watchlist chart-drop seam and shared `QuoteRow` drag props still behave.

- [ ] **Step 3: Run type/build check**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS. TypeScript should accept the dnd-kit handler types and `DraggableScreenerRow` props.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: no uncommitted implementation changes. If `frontend/package-lock.json` changes only by root package version after `npm install`, revert that incidental change:

```bash
git restore frontend/package-lock.json
```

- [ ] **Step 5: Report result**

Report:

```text
Implemented in worktree /home/dev/.config/superpowers/worktrees/hoga-ops/screener-chart-drag.
Verified:
- npx vitest run src/screener/ScreenerDrawer.test.tsx
- npx vitest run src/watchlist/WatchlistDrawer.drag.test.tsx src/rightrail/QuoteRow.test.tsx
- npm run build
```

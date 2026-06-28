# UI Design System Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Absorb repeated frontend table, list, empty-state, inline-state, and form-field styling into focused UI primitives without changing visible workflows.

**Architecture:** Add one scoped `frontend/src/ui/DataSurface.tsx` module that matches the existing `PageShell` / `WorkspaceShell` / `RailShell` tone: token-backed classes, caller escape hatches, and no domain behavior. Apply it first where repeated patterns are clearest: Screener result rows and saved-list rows, Inventory list rows, Capture form/queue states, and the Indicator category list.

**Tech Stack:** React, TypeScript, Tailwind token classes, Vitest, React Testing Library, Vite.

## Global Constraints

- Preserve the current user-visible layout and workflows.
- Follow `DESIGN.md`: dark-only, industrial/utilitarian, restrained teal UI accent, mono numeric data, 6px default radii.
- Do not change backend/API/store contracts.
- Do not change chart canvas behavior or table/grid/drag/drop layout math.
- Do not chase zero `className`; only absorb repeated design-system patterns.
- Use TDD: write primitive tests first, verify RED, implement, verify GREEN.
- Keep changes small and bisectable.

---

### Task 1: Add Data Surface Primitives

**Files:**
- Create: `frontend/src/ui/DataSurface.test.tsx`
- Create: `frontend/src/ui/DataSurface.tsx`

**Interfaces:**
- Produces: `DataTableShell`, `DataTableHeader`, `DataTableRow`, `ListRow`, `EmptyState`, `FormField`, `InlineState`.

- [x] **Step 1: Write the failing primitive tests**

```tsx
render(<DataTableShell minWidth="640px"><DataTableHeader columns="grid-cols-[1fr]">Header</DataTableHeader></DataTableShell>);
expect(screen.getByText('Header')).toHaveClass('border-b');
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- --run src/ui/DataSurface.test.tsx`
Expected: FAIL because `DataSurface.tsx` does not exist.

- [x] **Step 3: Implement minimal primitives**

Use the same class-merge style as `PageShell.tsx`: token classes first, optional `className` appended.

- [x] **Step 4: Run primitive tests to verify GREEN**

Run: `cd frontend && npm run test -- --run src/ui/DataSurface.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-06-28-ui-design-system-phase2.md frontend/src/ui/DataSurface.test.tsx frontend/src/ui/DataSurface.tsx
git commit -m "refactor: add data surface ui primitives"
```

### Task 2: Apply Primitives to Screener

**Files:**
- Modify: `frontend/src/screener/ResultTable.tsx`
- Modify: `frontend/src/screener/SavedScreenerList.tsx`
- Test: `frontend/src/screener/ResultTable.test.tsx`
- Test: `frontend/src/screener/SavedScreenerList.test.tsx`

**Interfaces:**
- Consumes: Task 1 primitives.
- Produces: Same screener sort, activate, save-list edit/menu behavior.

- [x] **Step 1: Add or preserve tests around row activation, sorting, empty states, and saved-list empty search states**

Run targeted screener tests after each file change.

- [x] **Step 2: Replace repeated card/table/list row classes**

Use `DataTableShell`, `DataTableHeader`, `DataTableRow`, `ListRow`, and `EmptyState`; leave domain-specific column grids and menu positioning intact.

- [x] **Step 3: Verify**

Run: `cd frontend && npm run test -- --run src/screener/ResultTable.test.tsx src/screener/SavedScreenerList.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screener/ResultTable.tsx frontend/src/screener/SavedScreenerList.tsx frontend/src/screener/ResultTable.test.tsx frontend/src/screener/SavedScreenerList.test.tsx
git commit -m "refactor: reuse data surfaces in screener"
```

### Task 3: Apply Primitives to Inventory and Capture

**Files:**
- Modify: `frontend/src/inventory/StockDateGroupListItem.tsx`
- Modify: `frontend/src/capture/CaptureForm.tsx`
- Modify: `frontend/src/capture/CaptureQueue.tsx`
- Test: existing inventory/capture tests.

**Interfaces:**
- Consumes: Task 1 primitives.
- Produces: Same inventory selection, capture enqueue, queue empty/loading/banner behavior.

- [x] **Step 1: Preserve tests**

Run targeted tests before and after each area.

- [x] **Step 2: Replace repeated list/form/state classes**

Use `ListRow` for selectable inventory rows, `FormField` for capture labels, `EmptyState` for queue-empty, and `InlineState` for capture/queue alerts.

- [x] **Step 3: Verify**

Run: `cd frontend && npm run test -- --run src/inventory/StockDateGroupListItem.test.tsx src/capture/Capture.test.tsx src/capture/CaptureQueue.test.tsx`
Expected: PASS, adjusting command if file names differ.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/inventory/StockDateGroupListItem.tsx frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureQueue.tsx
git commit -m "refactor: reuse data surfaces in inventory and capture"
```

### Task 4: Apply Primitives to Indicator Category Rows

**Files:**
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Test: `frontend/src/live/indicators/IndicatorPanel.test.tsx` if present, otherwise targeted live settings tests.

**Interfaces:**
- Consumes: Task 1 `ListRow`.
- Produces: Same category selection and checkbox toggles.

- [ ] **Step 1: Replace category row class assembly**

Keep group headers and detail pane rendering unchanged.

- [ ] **Step 2: Verify**

Run relevant indicator/live tests.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/live/indicators/IndicatorPanel.tsx
git commit -m "refactor: reuse list rows in indicator panel"
```

### Task 5: Final Verification and Bundle Warning Note

**Files:**
- Modify only if a small, low-risk bundle improvement is obvious from build output.

- [ ] **Step 1: Measure remaining className distribution**

Run: `rg "className=" frontend/src -g "*.tsx" --count`

- [ ] **Step 2: Run full frontend tests**

Run: `cd frontend && npm run test -- --run`

- [ ] **Step 3: Run frontend build**

Run: `cd frontend && npm run build`

- [ ] **Step 4: Summarize remaining direct className areas and next steps**

Include bundle warning status from build output.

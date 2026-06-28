# UI Design System Phase 2 Rail Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Absorb repeated right-rail tree/list chrome into focused `RailShell` primitives without changing saved-view or watchlist workflows.

**Architecture:** Extend `frontend/src/ui/RailShell.tsx` with drawer-tree primitives that are narrower than the generic `DataSurface` module: a small icon toolbar button, a sticky group header row, and an indented tree item row. Apply them first to `StudyViewsDrawer`; leave `WatchlistDrawer` for a later pass because its group header has rename/delete/sort/drag menu behavior.

**Tech Stack:** React, TypeScript, Tailwind token classes, Vitest, React Testing Library.

## Global Constraints

- Preserve the current user-visible layout and workflows.
- Follow `DESIGN.md`: dark-only, restrained token-backed UI, mono/data classes only where domain-specific.
- Do not change backend/API/store contracts.
- Do not change drag/drop behavior or route/navigation behavior.
- Do not chase zero `className`; only absorb repeated right-rail patterns.
- Use TDD: add primitive tests first, verify RED, implement, verify GREEN.

---

### Task 1: Add Rail Tree Primitives

**Files:**
- Modify: `frontend/src/ui/RailShell.test.tsx`
- Modify: `frontend/src/ui/RailShell.tsx`

**Interfaces:**
- Produces: `RailToolbarIconButton`, `RailGroupHeader`, `RailTreeRow`.

- [x] **Step 1: Write failing primitive tests**

Run: `cd frontend && npm run test -- --run src/ui/RailShell.test.tsx`
Expected: FAIL because new exports are missing.

- [x] **Step 2: Implement minimal primitives**

Keep caller escape hatches: `className`, `children`, and passthrough button/div props.

- [x] **Step 3: Verify primitive tests**

Run: `cd frontend && npm run test -- --run src/ui/RailShell.test.tsx`
Expected: PASS.

### Task 2: Apply to StudyViewsDrawer

**Files:**
- Modify: `frontend/src/studyViews/StudyViewsDrawer.tsx`
- Test: `frontend/src/studyViews/StudyViewsDrawer.test.tsx`

**Interfaces:**
- Consumes: Task 1 primitives.
- Produces: Same saved-view grouping, collapse, search, rename, context menu, drag, and navigation behavior.

- [x] **Step 1: Replace toolbar icon button class helper**
- [x] **Step 2: Replace stock group header class assembly**
- [x] **Step 3: Replace saved-view row wrapper class assembly**
- [x] **Step 4: Verify targeted tests**

Run: `cd frontend && npm run test -- --run src/ui/RailShell.test.tsx src/studyViews/StudyViewsDrawer.test.tsx`
Expected: PASS.

### Task 3: Final Verification

### Task 3: Add Settings Row Primitives

**Files:**
- Create: `frontend/src/live/settings/SettingsRow.test.tsx`
- Create: `frontend/src/live/settings/SettingsRow.tsx`
- Modify: `frontend/src/live/settings/ToggleRow.tsx`
- Modify: `frontend/src/live/settings/NumericPrefRow.tsx`
- Modify: `frontend/src/live/LiveSettingsSections.tsx`

**Interfaces:**
- Produces: `SettingsRow`, `ToggleSwitch`.
- Preserves: existing `role="switch"` behavior and `data-testid` contracts.

- [x] **Step 1: Write failing SettingsRow tests**
- [x] **Step 2: Implement SettingsRow and ToggleSwitch**
- [x] **Step 3: Apply to toggle, numeric, and live settings rows**
- [x] **Step 4: Verify targeted settings tests**

### Task 4: Final Verification

- [x] **Step 1: Re-measure className distribution**
- [x] **Step 2: Run full frontend tests**
- [x] **Step 3: Run frontend build**

# Workspace Shell Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared full-bleed workspace UI primitives and apply them to Live/Study chrome without changing chart behavior.

**Architecture:** Keep route page primitives in `PageShell.tsx` and add workspace-specific primitives in `WorkspaceShell.tsx`. Adopt them only in Live/Study header, toolbar, state, and drop-overlay surfaces where the replacement is mechanical.

**Tech Stack:** React 18, TypeScript, Tailwind CSS token classes, Vitest, React Testing Library, Vite.

## Global Constraints

- Follow `DESIGN.md`; do not introduce a new visual direction.
- No chart canvas, tab model, data flow, backend, API, or store changes.
- No RightRail/Drawer redesign in this phase.
- No broad UX redesign in this phase.
- Use TDD: write failing tests before production code.

---

### Task 1: Workspace Primitives

**Files:**
- Create: `frontend/src/ui/WorkspaceShell.tsx`
- Create: `frontend/src/ui/WorkspaceShell.test.tsx`

**Interfaces:**
- `WorkspaceRoot({ children, className?, testId? })`
- `WorkspaceHeader({ children, className?, testId? })`
- `WorkspaceToolbar({ children, className?, testId? })`
- `IconToolbarButton({ children, icon?, className?, ...buttonProps })`
- `WorkspaceState({ children, tone?, testId?, dropTargetRef?, showDropOverlay? })`
- `DropOverlay({ children })`

**Steps:**
- [ ] Add `WorkspaceShell.test.tsx` expecting these exports and token-backed classes.
- [ ] Run `npx vitest run src/ui/WorkspaceShell.test.tsx` and verify it fails because the module is missing.
- [ ] Add `WorkspaceShell.tsx`.
- [ ] Re-run the test and verify it passes.
- [ ] Commit with `feat: add workspace shell primitives`.

### Task 2: Live Workspace Chrome

**Files:**
- Modify: `frontend/src/live/LiveHeader.tsx`
- Modify: `frontend/src/live/LiveToolbar.tsx`
- Modify: `frontend/src/live/LiveHeader.tsx` tests if present
- Modify: `frontend/src/live/LiveToolbar.test.tsx`

**Steps:**
- [ ] Add/adjust tests asserting `LiveHeader` uses `data-testid="live-header"` and `LiveToolbar` action buttons retain labels/test ids while using shared button classes.
- [ ] Run `npx vitest run src/live/LiveToolbar.test.tsx src/live/LivePage.test.tsx`.
- [ ] Refactor `LiveHeader`, `LiveToolbar`, and `LiveChartActionButtons` to use `WorkspaceHeader`, `WorkspaceToolbar`, and `IconToolbarButton`.
- [ ] Re-run targeted tests.
- [ ] Commit with `refactor: share live workspace chrome`.

### Task 3: Study Workspace States and Header

**Files:**
- Modify: `frontend/src/studyViews/StudyPage.tsx`
- Modify: `frontend/src/studyViews/StudyPage.test.tsx`

**Steps:**
- [ ] Add tests for empty/loading/error state test ids and drop overlay text.
- [ ] Run `npx vitest run src/studyViews/StudyPage.test.tsx` and verify the new class/primitive expectations fail.
- [ ] Refactor `StudyPage` empty/loading/error states to use `WorkspaceState`.
- [ ] Refactor `StudyDropOverlay` to use `DropOverlay`.
- [ ] Refactor the Study header wrapper and memo button to use `WorkspaceHeader` and `IconToolbarButton`.
- [ ] Re-run StudyPage tests.
- [ ] Commit with `refactor: share study workspace shell`.

### Final Verification

- [ ] Run:

```bash
cd frontend
npx vitest run src/ui/WorkspaceShell.test.tsx src/live/LiveToolbar.test.tsx src/live/LivePage.test.tsx src/studyViews/StudyPage.test.tsx
npm run build
```

- [ ] Report completed commits and any remaining follow-up scope.

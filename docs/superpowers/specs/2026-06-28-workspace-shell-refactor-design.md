# Workspace Shell Refactor Design

**Date:** 2026-06-28
**Scope:** Phase 2-A/B
**Status:** Approved for implementation

## Goal

Extend the Phase 1 UI shell cleanup into full-bleed chart workspaces by adding shared workspace primitives and applying them to Live and Study without changing chart behavior, data flow, or major user-facing layout.

## Scope

- Add workspace-oriented primitives for full-bleed surfaces:
  - `WorkspaceRoot`
  - `WorkspaceHeader`
  - `WorkspaceToolbar`
  - `IconToolbarButton`
  - `WorkspaceState`
  - `DropOverlay`
- Apply the primitives to:
  - `LiveHeader`
  - `LiveToolbar` / `LiveChartActionButtons`
  - `StudyPage` empty/loading/error surfaces
  - `StudyPage` header controls
  - `StudyDropOverlay`
- Keep `PageShell` for feature routes and add workspace primitives alongside it, not inside it.

## Non-Goals

- No chart canvas or pane behavior changes.
- No Live/Study tab model changes.
- No RightRail/Drawer redesign in this phase.
- No broad UX redesign yet.
- No attempt to eliminate every local `className`; layout math and chart-adjacent values remain local.

## Acceptance Criteria

- Live and Study continue to render the same workflows.
- Shared workspace primitives have focused tests.
- Live action buttons use the shared toolbar button primitive.
- Study empty/loading/error states use a shared workspace state primitive.
- Study drop overlay uses a shared drop overlay primitive.
- Existing Live/Study targeted tests pass.
- `npm run build` passes.

# UI Code Shell Refactor Design

**Date:** 2026-06-28
**Scope:** Phase 1 only
**Status:** Draft for review

## Goal

Refactor the frontend UI code so feature routes share one consistent page grammar without changing the product's visual direction or core user workflows.

This is a code-structure and consistency pass. It applies the existing `DESIGN.md` more strictly, but it is not a new visual redesign.

## Non-Goals

- No new color palette, typography scale, theme, or light mode.
- No large UX redesign of Screener, Heatmap, Capture, Inventory, Settings, Live, or Study.
- No chart canvas policy changes.
- No backend, API, store, or data model changes except where a frontend test needs a small fixture adjustment.
- No new landing, hero, or marketing-style screens.

## Design Principles

The refactor follows the approved "Modern Trading Lab" design system:

- Pages should feel like parts of the same analyst workstation.
- UI chrome should use token-backed surfaces, spacing, borders, and text styles.
- Repeated page patterns should be named once and reused.
- Extracted components should stay thin. They may own structure and styling, but not feature behavior.
- Full-bleed chart workspaces remain special; feature routes use the shared page shell.

## Phase 1 Scope

### 1. Shared Page Primitives

Add a small set of reusable UI primitives under `frontend/src/layout` or `frontend/src/ui`:

- `PanelCard`: token-backed card wrapper for feature-route panes.
- `ControlBar`: title-less top action row inside a card or route.
- `ToolbarButton`: standard secondary/primary/destructive button styling for route controls.
- `SegmentedControl`: compact segmented toggle styling used by Heatmap/Screener-style controls.
- `PageState`: shared loading, empty, and error surfaces.
- `DefinitionRow`: label/value rows for Settings-like detail panels.

These primitives should accept `className` and `children` so feature pages can compose them without losing local flexibility.

### 2. Feature Route Alignment

Apply the primitives to low-risk pages first:

- `Settings`: move from custom `p-8 max-w-2xl` layout to `PageContainer` + `PanelCard`; remove redundant page title.
- `Capture`: replace direct `bg-bg-card border rounded-lg` sections with `PanelCard`; preserve splitter behavior and local storage.
- `Inventory`: keep its current `PageContainer` contract, but normalize loading/empty states.
- `Heatmap`: normalize header/control row and page states only. Do not redesign the board.

Screener is included only where it can adopt primitives without changing behavior:

- Reuse shared button/control primitives in the top action row.
- Do not restructure the three-column workflow in phase 1.

### 3. Styling Cleanup

Replace repeated hardcoded shell styles with shared primitives where the replacement is mechanical:

- `bg-bg-card border rounded-lg`
- route-level `p-4`, `p-8`, or custom root padding
- repeated button classes for secondary/primary actions
- repeated loading, empty, and error blocks

Do not chase every arbitrary value in the app. Chart, table column, drag/drop, and canvas-adjacent values may remain local when they encode behavior or layout math.

## Acceptance Criteria

- Feature routes still render and behave the same at a workflow level.
- `Settings` follows the same feature-route page shell as other non-chart pages.
- `Capture` splitter sizing and keyboard nudge behavior remain unchanged.
- `Heatmap` board layout and sorting behavior remain unchanged.
- Screener's query, save, run, sort, and result interactions remain unchanged.
- New primitives are covered by focused component tests where behavior or class contracts matter.
- Existing relevant tests continue to pass.

## Suggested Verification

Run targeted frontend tests after implementation:

```bash
cd frontend
npx vitest run src/layout/PageContainer.test.tsx src/pages/Settings.test.tsx src/pages/Capture.test.tsx src/pages/Heatmap.test.tsx src/pages/Screener.test.tsx
npm run build
```

If broad primitive changes touch shared UI, also run:

```bash
cd frontend
npx vitest run src/nav/LeftNav.test.tsx tests/component/LeftNav.test.tsx
```

## Risks

- Shared primitives can become too abstract. Keep them small and token-oriented.
- Route-specific layout constraints can be hidden accidentally. Preserve local grid/splitter/table sizing where it carries behavior.
- Visual regressions can slip in despite behavior tests. Use the existing `/browse` workflow for any page that looks suspect during implementation.

## Implementation Boundary

Phase 1 ends when common page primitives exist and the low-risk feature routes use them. User-facing UI/UX redesign comes later as a separate phase.

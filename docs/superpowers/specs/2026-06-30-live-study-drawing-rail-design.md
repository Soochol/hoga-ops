# Live/Study Drawing Rail Design

**Date:** 2026-06-30
**Scope:** `/live` and `/study` chart workspaces

## Goal

Move drawing tool selection out of the top toolbar and into a left-side vertical rail beside the chart. The rail should expose only the drawing capabilities that already exist today: select, horizontal line, trendline, pencil, eraser, and clear all.

## Current State

Drawing behavior is already centralized in `frontend/src/chart/drawing/tools.ts` and state is owned by `frontend/src/state/drawings.ts`. The existing `LiveDrawingMenu` renders a top-toolbar "그리기" popover from the same tool registry. `/live` uses it through `LiveToolbar`; `/study` uses the shared `LiveChartActionButtons`, so both pages currently inherit the same top-toolbar drawing button.

## Chosen Approach

Create a shared `LiveDrawingRail` component and mount it inside the chart area on both pages:

- `/live`: in `LiveWorkarea`, below `LiveToolbar`, wrap the chart body in a two-column layout: drawing rail on the left, chart root on the right.
- `/study`: in `StudyPage`, wrap the ready-state `LiveChartRoot` in the same two-column layout.
- Remove `LiveDrawingMenu` from `LiveChartActionButtons`, so the old top-toolbar drawing button disappears on both pages.
- Delete the old menu component and its menu-specific tests after the rail is wired. The replacement should leave no dead imports, no unused portal/popover helpers, and no duplicate drawing tool list.

This keeps the rail local to the chart interaction surface, avoids overlaying controls on top of candles, and lets `/live` and `/study` share one implementation.

## UI Behavior

The rail is a narrow vertical control strip using existing design tokens:

- Fixed width of 44px, full height of the chart body.
- Icon-only buttons with `aria-label` and `title` text for the Korean tool labels.
- Active tool uses the accent treatment; inactive tools use quiet input/button styling.
- Tools are ordered: select, horizontal line, trendline, pencil, eraser.
- A divider separates tool selection from the clear-all action.
- Clear-all calls the existing drawing store `clearAll()`.

The rail does not introduce new drawing primitives, style controls, persistence rules, or keyboard shortcuts.

## Code Cleanup

The implementation should clean the existing drawing UI path while preserving drawing behavior:

- Replace `LiveDrawingMenu` with `LiveDrawingRail` instead of keeping both UIs in parallel.
- Keep tool labels, glyphs, and ordering sourced from `TOOLS` / `DRAWABLE_TOOLS_ORDER`.
- Extract a small shared chart-body wrapper if it prevents `/live` and `/study` from carrying near-identical `grid-cols-[44px_minmax(0,1fr)]` layout code.
- Remove menu-only code paths, tests, imports, and comments after the rail is wired.
- Do not refactor `DrawingOverlay`, drawing persistence, coordinate conversion, or tool behavior unless a test failure shows the rail integration exposed a real coupling issue.

## Data Flow

`LiveDrawingRail` reads `activeTool` from `useDrawingsStore` and writes tool choices through `setActiveTool`. It reads labels/glyphs from the existing `TOOLS` registry, so tool metadata remains single-sourced with drawing behavior. Existing `DrawingOverlay`, `DrawingPropertyPanel`, persistence, selection, and per-code drawing loading remain unchanged.

## Error Handling

There is no new async or backend path. If there is no active drawing code, existing store actions are already no-ops where needed. Clear-all keeps the current no-op behavior when no code is active.

## Testing

Add focused frontend tests:

- `LiveDrawingRail` renders current tools, switches `activeTool`, highlights the active tool, and clears drawings through the store.
- `LiveToolbar` no longer renders the "그리기" button and still renders indicators, settings, timeframe controls, and study save controls.
- Removed menu tests should be replaced by rail tests rather than disabled.
- Existing `/live` and `/study` shell tests should continue to pass after the chart-body wrapper changes.

Run the targeted Vitest files touched by the change. Run the frontend build before declaring implementation complete.

## Out Of Scope

- Adding the extra tools shown in the visual reference that do not exist in the current registry.
- Replacing glyphs with a new icon dependency.
- Changing drawing persistence or chart overlay hit-testing.
- Adding mobile-specific behavior.

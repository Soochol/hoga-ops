# Screener Panel Chart Drag Design

## Goal

Apply the existing Watchlist Panel "drag a stock row onto the `/live` chart to change the current tab's code" behavior to the Screener Panel result list.

The scope is intentionally narrow: Screener rows become draggable only for chart drop. They do not reorder within the screener result list, and no screener result data is mutated.

## Current Context

The Watchlist Panel already supports chart drop through a shared `entryDrag` seam:

- `LiveWorkarea` registers a chart hit-test predicate in `useEntryDragStore`.
- The panel drag handler reconstructs the pointer position from `activatorEvent + delta`.
- `isPointOnChart(point)` decides whether the drop landed on the chart workarea.
- If true, the panel calls `useJumpToLive(code, name)`.
- `LiveWorkarea` shows the existing "여기에 놓아 종목 변경" overlay while `entryDrag.draggingCode` is non-null.

`ScreenerDrawer` already renders result rows with the shared `QuoteRow` component and uses `useJumpToLive` on click. This means the feature can reuse the existing navigation and chart-drop affordance without introducing a second drop target contract.

## Design

Wrap the Screener Panel result list in a `DndContext` and render each result row through a small `DraggableScreenerRow` component.

`DraggableScreenerRow` uses `useDraggable`, not `useSortable`, because screener results are read-only output from the latest scan. There is no in-list reorder behavior and no backend mutation.

The drag lifecycle mirrors the chart-drop half of `WatchlistDrawer`:

- `onDragStart`: if the active draggable is a screener row, call `startDrag(code)`.
- `onDragMove`: calculate `dropPoint(ev)` and call `setOverChart(isPointOnChart(point))`.
- `onDragEnd`: call `endDrag()` first, then if `isPointOnChart(dropPoint(ev))` is true, call `openLive(code, name)`.
- `onDragCancel`: call `endDrag()`.

If the row is dropped outside the chart, nothing happens. This differs from the Watchlist Panel, where a non-chart drop may reorder rows.

## Components And Data Flow

`ScreenerDrawer` remains the owner of the selected saved screener, scan result state, and `openLive` callback.

`DraggableScreenerRow` receives:

- `row`: the live-merged screener row.
- `active`: whether the row's code equals `livePage.activeCode`.
- `onActivate`: callback that calls `openLive(row.code, row.name)`.
- `trailingAction`: existing `WatchlistHeartButton`.

The draggable `data.current` should include `{ type: 'screener-entry', code, name }`. The explicit type prevents future drag systems from accidentally treating screener rows as watchlist sortable entries.

`QuoteRow` keeps its existing visual and keyboard contract. The draggable listeners and attributes are passed through its existing drag props. The heart button remains a trailing action and continues to stop propagation through its own implementation.

## Error Handling And Edge Cases

If `/live` is not mounted or no chart target is registered, `isPointOnChart` returns false and drops are ignored.

If `activatorEvent` lacks client coordinates, `dropPoint` returns null and drops are ignored.

Drag cancel and drag end both clear the global drag state so the chart overlay cannot remain stuck.

Click and keyboard activation remain unchanged: Enter, Space, and click still open the row's chart through `QuoteRow`.

## Testing

Add Screener Panel drag wiring coverage beside the existing `ScreenerDrawer` tests:

- A screener row dropped over a registered chart hit-test calls the same `useJumpToLive` path as click and sets `activeCode`.
- A screener row dropped outside the chart leaves `activeCode` unchanged.
- Drag cancel or end clears `useEntryDragStore.draggingCode`.

Keep the test at the wiring seam, matching the existing Watchlist drag tests. Full pointer collision behavior remains covered by dnd-kit and browser-level interaction surfaces rather than duplicated in jsdom.

## Out Of Scope

- Screener result row reorder.
- Saving screener result order.
- Opening a new tab on drop. The behavior matches existing row click and Watchlist Panel chart drop: replace the active live tab's code through `useJumpToLive`.
- Changing the chart drop overlay copy or styling.

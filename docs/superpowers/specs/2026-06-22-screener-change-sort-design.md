# Screener Change-Percent Result Sort — Design

**Date**: 2026-06-22
**Status**: Approved for implementation planning
**Scope**: `frontend/src/screener/ResultTable.tsx`, `frontend/src/screener/ScreenerDrawer.tsx`, `frontend/src/screener/useScreenerRowsLive.ts`, existing change-percent sort utilities/icons, screener component tests

## Problem

The user wants screener result lists to be sortable by 등락률 after a scan returns results. The feature must apply to both surfaces that show screener results:

- the right-rail screener drawer
- the full `/screener` page result table

The current drawer renders results in scan order with live quote overlay values, and the full page renders a table in the same order. There is no way to quickly bring the strongest 상승/하락 names to the top without changing the screener conditions or leaving the current workflow.

## Invariants

- **Server result order remains the default order**: `default` sort shows rows in the order returned by `/api/screener/scan`, after the existing live quote overlay. 근거: [Screener.tsx](../../../frontend/src/pages/Screener.tsx), [ScreenerDrawer.tsx](../../../frontend/src/screener/ScreenerDrawer.tsx).
- **Live quote overlay is display-only**: current price, change percent, and change won are merged on the client by `useScreenerRowsLive`; the scan payload and saved screener conditions are not mutated by display changes. 근거: [useScreenerRowsLive.ts](../../../frontend/src/screener/useScreenerRowsLive.ts).
- **Drawer and full page share result semantics**: both surfaces display the same scan rows with the same live quote overlay behavior. 근거: shared use of `useScreenerRowsLive`.
- **Missing change percent displays and sorts consistently**: when live quote `change_pct` is `null`, the UI shows `—`; sorted modes must not reintroduce stale EOD fallback values. 근거: [useScreenerRowsLive.ts](../../../frontend/src/screener/useScreenerRowsLive.ts), [ChangeCell.tsx](../../../frontend/src/screener/ChangeCell.tsx), [QuoteChange.tsx](../../../frontend/src/rightrail/QuoteChange.tsx).
- **Design-system color discipline**: sort controls use UI-state accent/tint only for active or focus state, and market direction colors remain reserved for market values. 근거: [DESIGN.md](../../../DESIGN.md).
- **Right-rail row composition remains panel-owned**: `QuoteRow` stays a static shared row; each panel owns its list wiring, DnD behavior, and trailing actions. 근거: [ADR-0058](../../adr/0058-right-rail-row-composition.md), [QuoteRow.tsx](../../../frontend/src/rightrail/QuoteRow.tsx).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| Server result order remains the default order | preserves | `default` mode returns rows by original scan index. |
| Live quote overlay is display-only | preserves | sort is derived in render state from already-merged `liveRows`; no API or save mutation. |
| Drawer and full page share result semantics | preserves | both surfaces consume the same sort helper and mode type. |
| Missing change percent displays and sorts consistently | preserves | `null`/non-finite values sort last in asc and desc, and remain displayed as `—`. |
| Design-system color discipline | preserves | active sort button uses selection tint/accent border; price up/down colors stay only in cells. |
| Right-rail row composition remains panel-owned | preserves | sorting changes list order only; `QuoteRow` props and drag payload stay unchanged. |

## Goals

- Add three explicit sort states for screener results: default, 등락률 오름차순, 등락률 내림차순.
- Make the control available in both the right-rail screener drawer and the `/screener` page result table.
- Keep default mode as the API scan order, not a hidden change-percent sort.
- Sort using the currently displayed `change_pct`, including live quote overlay values.
- Keep missing `change_pct` rows at the bottom for both ascending and descending modes.
- Preserve original scan order as a tie-breaker.
- Provide three clear icon affordances, with accessible labels/tooltips.

## Non-Goals

- No backend sort parameter or API contract change.
- No persistence of sort mode across reloads, tabs, saved screeners, or browser sessions.
- No multi-column sort.
- No sorting by price, 거래대금, market, code, or name.
- No change to screener condition definitions or saved screener data.
- No change to watchlist sorting behavior, beyond reusing or extracting existing sort/icon code when that reduces duplication without changing its UI.

## Design

### Existing Assets To Reuse

The Watchlist Panel already has the same three logical modes and icon vocabulary:

- `QuoteSortMode = 'default' | 'change_pct_asc' | 'change_pct_desc'`
- `sortEntriesByChangePct(...)`
- an inline `SortIcon` with default/asc/desc shapes and tests asserting distinct icons

Implementation should avoid a second independent sorting algorithm. Either move the generic mode/helper/icon pieces to a neutral shared module, or keep the existing helper in place and add a screener wrapper that delegates to it. The important boundary is semantic reuse, not the exact file name.

Do not introduce an icon dependency. `frontend/package.json` has no icon package, and this app already uses small local SVG components.

### Sort Model

Use the existing three-state mode vocabulary:

```ts
export type ScreenerResultSortMode = 'default' | 'change_pct_asc' | 'change_pct_desc';
```

The implementation may alias `ScreenerResultSortMode` to the shared `QuoteSortMode` if the helper is promoted to a neutral module. If a screener-specific wrapper is kept, it must delegate to the existing comparison contract so null handling and tie-breaking cannot drift.

The helper accepts rows that include `code` and `change_pct`, plus the original index from the scan result order:

- `default`: return rows in original index order.
- `change_pct_asc`: lower `change_pct` first; `null`, `undefined`, and non-finite values last.
- `change_pct_desc`: higher `change_pct` first; missing/non-finite values last.
- ties: preserve original scan order.

Rows must be copied before sorting so render code never mutates `liveRows`.

### Shared Control Component

Create a compact reusable control at `frontend/src/screener/ScreenerResultSortControl.tsx`, used by both result surfaces.

Props:

```ts
interface ScreenerResultSortControlProps {
  mode: ScreenerResultSortMode;
  onChange: (mode: ScreenerResultSortMode) => void;
  disabled?: boolean;
}
```

The control renders three icon buttons in a tight segmented group:

- default: `기본 순서`
- ascending: `등락률 낮은 순`
- descending: `등락률 높은 순`

Use accessible labels and `title` text. Visible text is not required because the drawer is narrow. Active state uses `aria-pressed`, selection tint, and accent border/text. Disabled state is only needed if the parent chooses to show the control before rows exist; the preferred layout shows it only when `lastScan` or table rows exist.

### Icons

Use the existing Watchlist sort icon shapes as the visual baseline. Either extract them into a reusable local component or recreate the same glyphs in the shared screener control:

- `SortDefaultIcon`: list/order reset shape.
- `SortAscIcon`: upward direction with narrow-to-wide or low-to-high bars.
- `SortDescIcon`: downward direction with wide-to-narrow or high-to-low bars.

All icons:

- use `currentColor`
- set `aria-hidden="true"`
- size through `className`
- avoid market red/blue
- match existing stroke weight around `1.8` to `2`

### Right-Rail Drawer Placement

In `ScreenerDrawer`, place the sort control in the result summary row that currently reads:

```text
결과 N · savedName
```

The row becomes a flex header:

- left: count/name/stale-selection warning
- right: three-button sort control

This keeps sorting visually attached to the list it affects and avoids making it look like a scan condition. On narrow drawer width, the left label truncates before the control. The control remains available whenever `lastScan` exists, including zero-result scans, but it may be disabled or visually inert when there are no rows.

Do not move sort mode into `screenerPanel` persisted state. `lastScan` is intentionally in-memory because a screener row is a stale-prone price snapshot; sort mode should have the same transient lifetime.

### Full `/screener` Page Placement

In the full result table, place the same sort control in the table header near the `등락률` column.

Implementation:

- keep `ResultTable` responsible for displaying rows and the table-scoped control
- extend `ResultTable` props with `sortMode` and `onSortModeChange`
- sort rows before passing them to `ResultTable`; `ResultTable` renders the provided order unchanged
- render a compact icon group in the `등락률` header cell, aligned right

This makes the relationship between the control and `등락률` explicit while preserving the existing table layout. Update `COLS` so the `등락률` header cell can hold the label and three icon buttons without overlap.

### State Ownership

Each surface owns its own transient sort mode:

- `ScreenerDrawer`: `useState<ScreenerResultSortMode>('default')`
- `/screener` page: `useState<ScreenerResultSortMode>('default')`

The two surfaces do not sync sort mode. They can show the same scan concept with different local viewing preferences.

When a new scan succeeds, reset sort mode to `default` in that surface. This matches the meaning of "기본" as fresh server result order and prevents a previous sort from hiding the new scan's original ranking. Live quote polling may update `change_pct`; sorted modes should reactively reorder because they sort the current `liveRows`.

### Data Flow

Right drawer:

```text
lastScan.rows
  -> useScreenerRowsLive
  -> sortScreenerRows(liveRows, sortMode)
  -> DraggableScreenerRow list
```

Full page:

```text
screener.data.rows
  -> useScreenerRowsLive
  -> sortScreenerRows(liveRows, sortMode)
  -> ResultTable
```

Sorting should happen after live quote overlay, because the user asked to sort the visible result list by the displayed 등락률.

### Drag Behavior

The right drawer supports dragging screener rows onto the chart. Sorting changes only the display order of rows; the dragged payload remains `{ type: 'screener-entry', code, name }`. No reorder persistence is introduced.

Keep `DraggableScreenerRow` as the drawer-only adapter. Do not add sort, drag, or table concerns to the shared `QuoteRow`.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| default keeps original order | rows with mixed `change_pct`, mode `default` | codes equal input order |
| asc sorts low to high | `-2.0`, `0.5`, `3.0` | `-2.0`, `0.5`, `3.0` |
| desc sorts high to low | `-2.0`, `0.5`, `3.0` | `3.0`, `0.5`, `-2.0` |
| missing values last in asc | rows include `null` | null row at bottom |
| missing values last in desc | rows include `null` | null row at bottom |
| equal values keep scan order | several same `change_pct` values | input relative order preserved |
| helper does not mutate input | freeze or compare input before/after | input array unchanged |

**Invariant 회귀 테스트**:

- `default` mode preserves API order.
- sorted modes use displayed/live `change_pct`, with `null` values last.
- tie-breakers preserve original scan order.

### Component tests

| Surface | Case | Expected |
|---------|------|----------|
| `ResultTable` | clicking desc icon | rows reorder by highest 등락률 first |
| `ResultTable` | clicking default icon after desc | rows return to scan order |
| `ScreenerDrawer` | clicking asc icon | drawer rows reorder by lowest 등락률 first |
| `ScreenerDrawer` | new successful scan after sorted mode | mode resets to default |
| `ScreenerDrawer` | sorted rows dragged onto chart | dragged code still becomes the active chart code |
| `ScreenerDrawer` | live quote update while sorted | row order recomputes from the displayed live `change_pct` |
| both controls | active icon | button has `aria-pressed="true"` and accessible label |

### Manual verification

- Open `/screener`, run a scan with at least three results, and verify default/asc/desc order.
- Confirm the `등락률` cells remain colored by `ChangeCell` and buttons use only UI accent/tint.
- Open the right screener drawer, select a saved screener, run 조회, and verify the same sort behavior.
- Verify rows with unavailable live change percent show `—` and sit at the bottom in asc/desc modes.
- Confirm clicking a sorted row still opens the correct chart symbol.
- Confirm dragging a sorted drawer row onto the chart still opens the dragged symbol.

## Risks / Open questions

- The full table currently uses a fixed grid column template. Adding three icons inside the `등락률` header may require modest width tuning to avoid cramped header text.
- Live quote polling can reorder rows while sorted mode is active. This is expected because the sort is based on displayed live values, but it may make row positions move during active market hours.
- If the user later wants sort mode persistence, that should be a separate preference decision rather than hidden localStorage in this feature.
- Watchlist already has a one-button cycle control while this spec calls for three explicit buttons. Reuse the underlying icon/sort contract, not necessarily the exact Watchlist control shape.

## Out of Scope (Backlog)

- Persist sort mode per surface.
- Add keyboard shortcuts for sort cycling.
- Add column sorting for price, 거래대금, market, code, and name.
- Replace local SVG icons with a package-wide icon library.

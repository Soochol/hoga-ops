# /live Resizable Workarea Layout — Design

**Date**: 2026-06-25
**Status**: Pending user review
**Scope**: `/live` workarea layout only. Backend data, chart indicator pane heights, and indicator calculations stay unchanged.

## Problem

On `/live`, `LiveToolbar` currently occupies a full-width grid row above `LiveWorkarea`. The toolbar controls only the chart, but its row also covers the Live Detail Panel column. That leaves an empty horizontal area above the 10호가 card and pushes the detail cards downward.

The desired layout is:

```text
Status / tab area

[ Chart Panel                         ] | [ Live Detail Panel ]
[ LiveToolbar                         ] | [ 10호가                 ]
[ Candle chart, including all panes   ] | [ 프로그램 순매수        ]
[                                      ] | [ 거래원                 ]
[                                      ] | [ Live Investor Estimate ]
```

The chart and toolbar should behave as one left-side panel. The Live Detail Panel should start at the top of the workarea, beside the toolbar, so the current empty area disappears and 10호가 moves upward.

Users also want layout control:

- Drag the vertical boundary between the chart panel and Live Detail Panel to resize their widths.
- Drag horizontal boundaries inside the Live Detail Panel to resize 10호가, 프로그램 순매수, 거래원, and Live Investor Estimate Card heights.
- Do not resize the internal chart panes individually. The candle chart, volume pane, and indicator panes remain one chart surface for this feature.

## Goals

- Move `LiveToolbar` into the left chart panel so it no longer reserves space above the Live Detail Panel.
- Treat `LiveToolbar + LiveChartRoot` as one resizable chart panel.
- Add a vertical splitter between the chart panel and Live Detail Panel.
- Add horizontal splitters between the Live Detail Panel cards.
- Keep the four Live Detail Panel card slots mounted in a stable order, even when a card has no data.
- Persist user layout preferences locally so refreshes keep the chosen widths and heights.
- Preserve the existing live data flow, cursor behavior, chart viewport restore, and toolbar actions.

## Non-Goals

- No per-chart-pane height resizing inside `lightweight-charts`.
- No backend API changes.
- No per-symbol or per-tab layout persistence in the first version.
- No card reordering in the first version.
- No change to which indicators are visible or how they compute values.
- No redesign of the top tab/status/header rows outside the workarea.
- No `/study` layout change. Study View restore keeps its current page-specific detail layout.

## Proposed Architecture

### 1. Workarea Ownership

`LivePage` should stop rendering `LiveToolbar` as its own top-level grid row. Instead, it passes toolbar callbacks and controls into `LiveWorkarea`.

`LiveWorkarea` becomes the owner of the workarea-level layout:

```text
LiveWorkarea
├─ ChartPanel
│  ├─ LiveToolbar
│  └─ LiveChartRoot
├─ VerticalResizeHandle
└─ LiveDetailPanel
   ├─ 10호가
   ├─ ProgramTradeSummary
   ├─ Brokers
   └─ LiveInvestorEstimateCard
```

`ChartPanel` owns the toolbar and chart as a single unit. Resizing the left/right boundary changes the chart panel width and the Live Detail Panel width together.

`LiveToolbar` keeps its existing single-row behavior inside the Chart Panel: no wrapping, horizontal overflow allowed when the chart panel is very narrow. This prevents toolbar wrapping from changing chart height during width resize.

### 2. Left / Right Width Resizing

The current right column uses fixed `--sidebar-w`. Replace that with a persisted width value for the Live Detail Panel.

Suggested defaults:

- Default right width: current `--sidebar-w` equivalent, 400px at the current token scale.
- Minimum right width: 320px, so 10호가 and broker rows remain readable.
- Maximum right width: 45% of the workarea, so the chart cannot collapse.
- Minimum chart width: 640px where viewport allows.

The vertical resize handle sits between the chart panel and the Live Detail Panel. Pointer drag updates the Live Detail Panel width. During drag, selection should be disabled and the layout should update immediately.

Live Detail Panel width is persisted in pixels. This matches the reading-width nature of orderbook and broker tables better than a percentage. On render, clamp the persisted width against the current workarea: at least 320px for the detail panel, at most 45% of workarea width, while keeping the chart panel at or above its minimum where possible.

If the viewport is too narrow to satisfy both the 320px Live Detail Panel minimum and the 640px chart preference, keep the Live Detail Panel at 320px and give the remaining width to the chart. Do not introduce a mobile drawer/collapse mode in v1.

### 3. Live Detail Panel Height Resizing

`CursorSidebar` currently hard-codes grid rows for 10호가, 프로그램 순매수, and 거래원, while `InvestorTrendEstimateCard` is rendered outside that grid in the sidebar scroll container. For resizing, the Live Detail Panel should render all four cards in one resizable vertical stack:

1. 10호가
2. 프로그램 순매수
3. 거래원
4. Live Investor Estimate Card

Each adjacent pair gets a horizontal resize handle. Dragging a handle transfers height between the card above and the card below while respecting minimum heights.

Suggested initial heights:

- 10호가: 48% of the Live Detail Panel height
- 프로그램 순매수: 13% of the Live Detail Panel height
- 거래원: 24% of the Live Detail Panel height
- Live Investor Estimate Card: 15% of the Live Detail Panel height

Suggested minimum heights:

- 10호가: 260px
- 프로그램 순매수: 96px
- 거래원: 160px
- Live Investor Estimate Card: 120px

If the viewport is too short to satisfy all minimums, the Live Detail Panel may scroll, but the resize model should still preserve the user's preferred proportions.

### 4. Persistence

Use a dedicated `/live` layout preference store, independent of market data:

```ts
type LiveLayoutPrefs = {
  rightPanelWidthPx: number;
  rightCardWeights: {
    orderbook: number;
    program: number;
    brokers: number;
    investor: number;
  };
};
```

The store should live at `frontend/src/state/liveLayout.ts` and persist to `localStorage` under `live.layout.v1`. It owns only workarea layout preferences: Live Detail Panel width and Live Detail Panel card height weights.

The layout is global for `/live`, not per stock, timeframe, or tab. Switching Live Tabs must not change the Live Detail Panel width or card heights. That keeps behavior predictable and avoids saving many near-identical layouts.

Storage reads must validate shape and number ranges. Missing, corrupt, non-numeric, negative, or non-finite values fall back to defaults before render. Persisted values are still clamped against the current viewport at render time.

Dragging updates in-memory layout immediately for responsive feedback. Writes to `localStorage` should happen on pointerup or through a short trailing debounce, not on every pointermove.

Card order is fixed in v1: 10호가, 프로그램 순매수, 거래원, Live Investor Estimate Card. The horizontal drag handles resize adjacent cards only; they do not reorder cards.

All four slots remain mounted in v1. Indicator toggles or missing data may change a card's internal content or empty state, but must not remove the slot from the Live Detail Panel layout.

Card heights are persisted as relative weights, not absolute pixels. The default weights are `48 / 13 / 24 / 15`, matching the initial percentages above. Rendering applies the pixel minimums as clamps, so the panel adapts when the browser height changes while still preserving the user's preferred proportions.

Representative Index charts are the exception: because they have no orderbook-derived detail data, the Live Detail Panel is hidden and the chart panel uses the full workarea width. The saved `liveLayout` dimensions are preserved while hidden and restored when the user returns to a stock **Code**.

### 5. Component Boundaries

- `LivePage`: still owns data, modals, tabs, and status rows. It passes toolbar actions into `LiveWorkarea`.
- `LiveWorkarea`: owns the left/right split and drag target registration for watchlist drops.
- `ChartPanel`: new or local component that renders `LiveToolbar` above `LiveChartRoot`.
- `LiveSidebar` / `CursorSidebar`: evolve into a Live Detail Panel that can render all four cards in one vertical resizable stack.
- `liveLayout` store: owns persisted `/live` workarea dimensions only. It does not own active instrument, timeframe, indicator toggles, Right Rail state, or chart behavior prefs.
- A small reusable resize hook may be introduced if it keeps pointer handling and clamping out of layout JSX.

## Interaction Details

- The vertical handle should be a thin, visible boundary between chart and Live Detail Panel.
- The horizontal handles should appear between cards and use a row-resize cursor.
- Splitters should have a larger invisible hit area than their visible line: approximately 6px for the vertical splitter and 8px for horizontal splitters, with a 1px visual rule. Use pointer capture during drag.
- Dragging should not trigger chart panning or text selection.
- Watchlist/Screener row drops should target the whole Chart Panel, including the toolbar. The vertical splitter and Live Detail Panel are not drop targets.
- Reset layout controls, including double-click reset, are out of scope for the first version.
- Keyboard resizing is not required in the first version. Handles should still use separator semantics (`role="separator"`, orientation, and an accessible label) so assistive technology can identify the layout boundary.

## Risks

- `LiveWorkarea` currently registers the whole workarea as a chart drop target. After introducing a vertical splitter and Live Detail Panel, drop hit testing must narrow to the Chart Panel rect so detail-card interactions are not treated as chart drops.
- `LiveChartRoot` uses `autoSize`; width changes from the vertical splitter must propagate cleanly through container resize.
- The Live Detail Panel currently has nested scroll behavior. Consolidating the cards into one resizable stack must avoid double scrollbars where possible.
- Tests that assume `LiveToolbar` is a direct child of `LivePage` will need updates.

## Testing Plan

- Unit/render test: `/live` renders `LiveToolbar` inside the left chart panel, not as a full-width row above the sidebar.
- Unit/render test: Live Detail Panel starts at the top of the workarea and includes 10호가, 프로그램 순매수, 거래원, and Live Investor Estimate Card in one stack.
- Unit test: vertical drag updates and clamps Live Detail Panel width.
- Unit test: horizontal drag updates and clamps adjacent right-card heights.
- Unit test: `liveLayout` rejects corrupt persisted values and falls back to defaults.
- Unit/render test: Representative Index charts hide the Live Detail Panel and restore saved dimensions when returning to a stock Code.
- Regression test: toolbar buttons still open indicator/settings modals and preserve study-save wiring.
- Browser QA: verify the red empty area is gone, 10호가 is higher, chart remains nonblank after width resize, and right cards resize smoothly.

## Deferred Decisions

- A reset-layout command can be designed later if persisted custom layouts need an explicit escape hatch.

# /live Resizable Workarea Layout — Design

**Date**: 2026-06-25
**Status**: Pending user review
**Scope**: `/live` workarea layout only. Backend data, chart indicator pane heights, and indicator calculations stay unchanged.

## Problem

On `/live`, `LiveToolbar` currently occupies a full-width grid row above `LiveWorkarea`. The toolbar controls only the chart, but its row also covers the right sidebar column. That leaves an empty horizontal area above the 10호가 card and pushes the right-side indicators downward.

The desired layout is:

```text
Status / tab area

[ Chart Panel                         ] | [ Right Indicator Panel ]
[ LiveToolbar                         ] | [ 10호가                 ]
[ Candle chart, including all panes   ] | [ 프로그램               ]
[                                      ] | [ 거래원                 ]
[                                      ] | [ 잠정투자자             ]
```

The chart and toolbar should behave as one left-side panel. The right-side indicator panel should start at the top of the workarea, beside the toolbar, so the current empty area disappears and 10호가 moves upward.

Users also want layout control:

- Drag the vertical boundary between the chart panel and right indicator panel to resize their widths.
- Drag horizontal boundaries inside the right panel to resize 10호가, 프로그램, 거래원, and 잠정투자자 heights.
- Do not resize the internal chart panes individually. The candle chart, volume pane, and indicator panes remain one chart surface for this feature.

## Goals

- Move `LiveToolbar` into the left chart panel so it no longer reserves space above the right sidebar.
- Treat `LiveToolbar + LiveChartRoot` as one resizable chart panel.
- Add a vertical splitter between the chart panel and right indicator panel.
- Add horizontal splitters between the right indicator cards.
- Persist user layout preferences locally so refreshes keep the chosen widths and heights.
- Preserve the existing live data flow, cursor behavior, chart viewport restore, and toolbar actions.

## Non-Goals

- No per-chart-pane height resizing inside `lightweight-charts`.
- No backend API changes.
- No per-symbol or per-tab layout persistence in the first version.
- No change to which indicators are visible or how they compute values.
- No redesign of the top tab/status/header rows outside the workarea.

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
└─ RightIndicatorPanel
   ├─ 10호가
   ├─ Program
   ├─ Brokers
   └─ InvestorEstimate
```

`ChartPanel` owns the toolbar and chart as a single unit. Resizing the left/right boundary changes the chart panel width and the right indicator panel width together.

### 2. Left / Right Width Resizing

The current right column uses fixed `--sidebar-w`. Replace that with a persisted width value for the right indicator panel.

Suggested defaults:

- Default right width: current `--sidebar-w` equivalent, 400px at the current token scale.
- Minimum right width: 320px, so 10호가 and broker rows remain readable.
- Maximum right width: 45% of the workarea, so the chart cannot collapse.
- Minimum chart width: 640px where viewport allows.

The vertical resize handle sits between the chart panel and the right panel. Pointer drag updates the right panel width. During drag, selection should be disabled and the layout should update immediately.

### 3. Right Indicator Height Resizing

`CursorSidebar` currently hard-codes grid rows for 10호가, 프로그램, and 거래원, while `InvestorTrendEstimateCard` is rendered outside that grid in the sidebar scroll container. For resizing, the right sidebar should render all four cards in one resizable vertical stack:

1. 10호가
2. 프로그램
3. 거래원
4. 잠정투자자

Each adjacent pair gets a horizontal resize handle. Dragging a handle transfers height between the card above and the card below while respecting minimum heights.

Suggested initial heights:

- 10호가: 48% of the right panel height
- 프로그램: 13% of the right panel height
- 거래원: 24% of the right panel height
- 잠정투자자: 15% of the right panel height

Suggested minimum heights:

- 10호가: 260px
- 프로그램: 96px
- 거래원: 160px
- 잠정투자자: 120px

If the viewport is too short to satisfy all minimums, the right panel may scroll, but the resize model should still preserve the user's preferred proportions.

### 4. Persistence

Use a small local UI preference store, independent of market data:

```ts
type LiveLayoutPrefs = {
  rightPanelWidthPx: number;
  rightCardHeights: {
    orderbook: number;
    program: number;
    brokers: number;
    investor: number;
  };
};
```

Persist to `localStorage`. The layout is global for `/live`, not per stock, timeframe, or tab. That keeps behavior predictable and avoids saving many near-identical layouts.

### 5. Component Boundaries

- `LivePage`: still owns data, modals, tabs, and status rows. It passes toolbar actions into `LiveWorkarea`.
- `LiveWorkarea`: owns the left/right split and drag target registration for watchlist drops.
- `ChartPanel`: new or local component that renders `LiveToolbar` above `LiveChartRoot`.
- `LiveSidebar` / `CursorSidebar`: evolve into a right indicator panel that can render all four cards in one vertical resizable stack.
- A small reusable resize hook may be introduced if it keeps pointer handling and clamping out of layout JSX.

## Interaction Details

- The vertical handle should be a thin, visible boundary between chart and right panel.
- The horizontal handles should appear between cards and use a row-resize cursor.
- Dragging should not trigger chart panning or text selection.
- Reset layout controls, including double-click reset, are out of scope for the first version.
- Keyboard resizing is not required in the first version, but handles should have accessible labels where practical.

## Risks

- `LiveWorkarea` currently registers the whole workarea as a chart drop target. After introducing a vertical splitter and toolbar inside the left panel, drop hit testing must still treat the intended chart area as valid.
- `LiveChartRoot` uses `autoSize`; width changes from the vertical splitter must propagate cleanly through container resize.
- The right indicator panel currently has nested scroll behavior. Consolidating the cards into one resizable stack must avoid double scrollbars where possible.
- Tests that assume `LiveToolbar` is a direct child of `LivePage` will need updates.

## Testing Plan

- Unit/render test: `/live` renders `LiveToolbar` inside the left chart panel, not as a full-width row above the sidebar.
- Unit/render test: right indicator panel starts at the top of the workarea and includes 10호가, 프로그램, 거래원, and 잠정투자자 in one stack.
- Unit test: vertical drag updates and clamps right panel width.
- Unit test: horizontal drag updates and clamps adjacent right-card heights.
- Regression test: toolbar buttons still open indicator/settings modals and preserve study-save wiring.
- Browser QA: verify the red empty area is gone, 10호가 is higher, chart remains nonblank after width resize, and right cards resize smoothly.

## Deferred Decisions

- A reset-layout command can be designed later if persisted custom layouts need an explicit escape hatch.

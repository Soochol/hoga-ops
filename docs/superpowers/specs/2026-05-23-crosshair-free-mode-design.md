# Crosshair — Free Mode (Disable Close-Price Snap)

**Date**: 2026-05-23
**Status**: Approved
**Scope**: `frontend/src/util/chartScale.ts`, `frontend/src/chart/ChartStage.tsx`

## Problem

`lightweight-charts` v5.2's default `crosshair.mode` is `CrosshairMode.Magnet` (1) — the crosshair's horizontal line snaps to the closing price of the candle under the cursor's X position, rather than tracking the mouse Y position freely. The user reports this is unintuitive: when reading off-candle price levels (e.g., hovering between two candles to compare against a horizontal grid line or volume profile bar), the price-axis label shows the snapped close, not the mouse-pointed price. They want the crosshair to follow the cursor exactly.

The codebase does not currently override `crosshair.mode`, so the library default applies. The existing `chartScale.ts` module already owns `CHART_CROSSHAIR_LINE_WIDTH` and is the natural home for any additional crosshair configuration.

## Goals

- Crosshair horizontal AND vertical lines track the actual mouse position with no snapping.
- The right price-axis crosshair label reflects the mouse Y position's price (not a snapped candle value).
- Configuration lives in `chartScale.ts` alongside the existing crosshair line-width constant — consistent with the module's role as the chart-options center.
- No behavioral change to tooltip text, click handlers, volume-profile overlay sync, or any other crosshair-adjacent feature.

## Non-Goals

- Customizing crosshair color, dash pattern, or line width (already 1px per `CHART_CROSSHAIR_LINE_WIDTH`).
- Adding a user-facing toggle to switch between Normal and Magnet at runtime.
- Hiding the crosshair entirely (`CrosshairMode.Hidden`).
- Touching the per-pane sync logic (lightweight-charts handles cross-pane sync internally when multiple panes share a chart instance).

## Design

### Mode selection: `CrosshairMode.Normal`

`lightweight-charts` exposes four modes:

| Mode | Numeric | Behavior |
|---|---|---|
| `Normal` | 0 | Crosshair moves freely with the mouse. **Chosen.** |
| `Magnet` | 1 | Horizontal line snaps to the close (OHLC series). Library default — current bad behavior. |
| `Hidden` | 2 | No crosshair. |
| `MagnetOHLC` | 3 | Snaps to any of O/H/L/C. |

`Normal` is what the user describes ("그냥 마우스 커서에 십자선만 있도록").

### Module placement

Extend `frontend/src/util/chartScale.ts` with a new export:

```ts
import { CrosshairMode } from 'lightweight-charts';
import type { DeepPartial, CrosshairOptions, LayoutOptions, TimeScaleOptions } from 'lightweight-charts';

export const CHART_CROSSHAIR_OPTIONS: DeepPartial<CrosshairOptions> = {
  mode: CrosshairMode.Normal,
};
```

The existing `CHART_CROSSHAIR_LINE_WIDTH = 1` constant stays as a separate export — it is not part of `CrosshairOptions` (line width sits under `crosshair.vertLine` and `crosshair.horzLine` subfields). Folding line-width into the new options object is an optional minor cleanup, but is out of scope for this change — keep the new constant focused on the mode setting.

### Wiring in `ChartStage.tsx`

The chart is constructed in `ChartStage.tsx::useEffect` at the `createChart(...)` call. Add `crosshair: CHART_CROSSHAIR_OPTIONS` alongside the existing `layout`, `grid`, `timeScale`, `rightPriceScale` options, and add `CHART_CROSSHAIR_OPTIONS` to the existing `chartScale` import.

No new state, no new effect, no prop changes.

## Testing

- **Unit**: none. `crosshair.mode` is a `lightweight-charts` internal rendering knob; we hand the library an options object and trust it. An assertion of the form "the options object contains `mode: 0`" would be a tautology of the source.
- **Visual (`browse` skill)**: load a populated `/replay` view, move the cursor with `browser_mouse_move` (or read the `getComputedStyle` of the crosshair line element if exposed) to a position clearly above/below a candle close, screenshot. Verify the horizontal line sits at the cursor's Y, not at the candle close. Then confirm the right-axis label reflects the cursor's price.

## Risks

- **Tooltip plugins or downstream consumers may have assumed Magnet snapping.** Mitigation: a grep of the codebase shows the only references to crosshair are (a) `CHART_CROSSHAIR_LINE_WIDTH` (unaffected), (b) `useCursor` hook in `frontend/src/api/useCursor.ts` (uses time-axis values, not price), and (c) `subscribeCrosshairMove` handlers, if any, that read `MouseEventParams.point` — those receive the actual mouse coordinates regardless of mode. No code paths are affected.
- **Visual regression in screenshot-based tests.** None exist for the chart's crosshair state; the chart suites are structural (pane count, setData calls).

## Out of Scope (Backlog)

- A user toggle between Normal and Magnet modes (e.g., a Settings switch).
- Custom crosshair colors, dashed/dotted styling.
- Snap-to-OHLC mode (`MagnetOHLC`) — different feature; revisit only if a user requests "snap to O/H/L too".

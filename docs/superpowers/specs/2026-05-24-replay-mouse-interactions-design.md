# Replay Chart — Mouse Wheel Interactions (Modifier-Aware Zoom & Pan)

**Date**: 2026-05-24
**Status**: Approved
**Scope**: `frontend/src/chart/ChartStage.tsx`, `frontend/src/util/wheelInteractions.ts` (new), `frontend/src/util/wheelInteractions.test.ts` (new)

## Problem

On `/replay`, the chart's mouse-wheel behavior comes straight from `lightweight-charts`: wheel always zooms anchored at the mouse position. That is the only interaction available — there is no way to pan via the wheel, and zoom is always mouse-anchored even when the user wants to keep the rightmost (latest) candle in view.

The user wants three distinct wheel behaviors selected by modifier keys, matching the TradingView convention they are accustomed to:

| Input | Behavior |
|---|---|
| `wheel` (no modifier) | Zoom anchored at the **rightmost visible candle** (latest on screen) |
| `Shift + wheel` | Pan the time axis left/right (no zoom) |
| `Ctrl + wheel` (or `Cmd` on Mac) | Zoom anchored at the **mouse position** (current default behavior) |

The plain-wheel anchor is the headline change: when zooming out, the right edge stays fixed and more candles appear on the left; when zooming in, the right edge stays fixed and the chart magnifies the recent candles. This matches the user's mental model that "the latest candle is what I'm watching."

## Goals

- All three wheel behaviors above implemented on the `/replay` chart.
- The plain-wheel zoom keeps the rightmost visible logical index pinned across the wheel tick.
- `Shift + wheel` pans without changing the visible span (same number of bars visible before and after).
- `Ctrl/Cmd + wheel` keeps the candle under the cursor pinned at the cursor's x-coordinate across the wheel tick.
- Existing zoom guards continue to apply: the `barSpacing > 50` zoom-in cap and the resize-aware `minBarSpacing` zoom-out floor in [ChartStage.tsx:266-305](frontend/src/chart/ChartStage.tsx#L266-L305) must still bound the result.
- Pan and zoom never cause the page itself to scroll (we own the wheel event).
- The branching logic is a pure function that can be unit-tested without mounting a chart.

## Non-Goals

- Touch / pinch-zoom gestures. Wheel only.
- Drag-to-pan changes. The library's existing pressed-mouse-move pan behavior stays as-is.
- Vertical (price) scrolling via wheel. Wheel never moves the price axis.
- Adding a user-facing setting to change the modifier mapping. Mapping is fixed.
- Smooth/momentum-animated zoom. Each wheel tick applies once and settles.
- Changing wheel behavior on other charts (capture inventory views, etc.) — `/replay` only.

## Design

A note on coordinate systems: this spec works in `lightweight-charts`' **logical range** — a bar-index coordinate exposed by `timeScale.getVisibleLogicalRange()` / `setVisibleLogicalRange()`. This is distinct from the project's **Virtual Axis** (which maps real Unix-ms to virtual-ms for the stitched multi-day timeline). The Virtual Axis already underlies the chart's time mapping; bar-index manipulation composes correctly on top of it because the library handles the index → virtual-ms → render pixel conversion internally.

### Disable the library's built-in wheel handler

`lightweight-charts` exposes `handleScale.mouseWheel` in the chart options. Setting it to `false` removes the library's mouse-anchored zoom. We then own the `wheel` event on the chart container and route all three behaviors through a single custom handler.

This is preferable to letting the library handle `Ctrl + wheel` while we intercept the other two cases: dual ownership creates timing races (both handlers run on the same event and may fight over the visible range), and `stopImmediatePropagation` does not reliably block the library's internal listener. Single ownership is simpler and easier to test.

In the `createChart` call inside [ChartStage.tsx:107](frontend/src/chart/ChartStage.tsx#L107), add:

```ts
handleScale: { mouseWheel: false }
```

Other `handleScale` sub-options (`pinch`, `axisPressedMouseMove`, `axisDoubleClickReset`) remain at their defaults — we are not touching those interactions.

### Wheel handler placement

A new `useEffect` in `ChartStage` attaches a `wheel` listener to `containerRef.current` once the chart is ready. The effect's cleanup removes the listener. The listener uses `{ passive: false }` so we can call `preventDefault()` (required to stop page scroll, especially for `Shift + wheel` which the browser would otherwise treat as horizontal page scroll).

The listener delegates the math to a pure helper exported from the same file (or a new `frontend/src/util/wheelInteractions.ts` — see "File layout" below). The helper takes the current visible logical range, the wheel event's `deltaY`, the modifier flags, the mouse coordinate, and a `coordinateToLogical` callback; it returns the new `{ from, to }` logical range. Returning `null` means "no change" (e.g., visible range unavailable).

### Branch logic — pure function

```ts
type WheelOutcome = { from: number; to: number } | null;

interface WheelInput {
  range: { from: number; to: number };
  deltaY: number;
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
  mouseX: number; // px, relative to chart container left
  coordinateToLogical: (x: number) => number | null;
}

function computeWheelOutcome(i: WheelInput): WheelOutcome {
  const { from, to } = i.range;
  const span = to - from;
  if (span <= 0) return null;

  if (i.shiftKey) {
    // Pan: translate range, keep span. deltaY > 0 → pan forward in time (right).
    const dir = Math.sign(i.deltaY);
    if (dir === 0) return null;
    const step = span * 0.1 * dir;
    return { from: from + step, to: to + step };
  }

  // Zoom factor: smooth exponential curve. deltaY > 0 (wheel down) → factor > 1 → zoom OUT.
  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    // Mouse-anchored zoom.
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    return {
      from: anchor - (anchor - from) * factor,
      to: anchor + (to - anchor) * factor,
    };
  }

  // Default: right-edge-anchored zoom. `to` stays fixed.
  return { from: to - span * factor, to };
}
```

The function never clamps. The library will clamp `barSpacing` through the existing
`subscribeVisibleLogicalRangeChange` handler at [ChartStage.tsx:293-300](frontend/src/chart/ChartStage.tsx#L293-L300) and the `minBarSpacing` floor at [ChartStage.tsx:278](frontend/src/chart/ChartStage.tsx#L278), so any extreme range we hand it is automatically corrected.

### Wheel listener wiring

```ts
useEffect(() => {
  if (!chart || !containerRef.current) return;
  const container = containerRef.current;
  const ts = chart.timeScale();

  const onWheel = (e: WheelEvent) => {
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const outcome = computeWheelOutcome({
      range,
      deltaY: e.deltaY,
      shiftKey: e.shiftKey,
      ctrlOrMetaKey: e.ctrlKey || e.metaKey,
      mouseX: e.clientX - rect.left,
      coordinateToLogical: (x) => ts.coordinateToLogical(x),
    });
    if (outcome) ts.setVisibleLogicalRange(outcome);
  };

  container.addEventListener('wheel', onWheel, { passive: false });
  return () => container.removeEventListener('wheel', onWheel);
}, [chart]);
```

Effect depends only on `chart` (the IChartApi instance); the listener closure reads the latest `containerRef` synchronously each time it fires, and `ts` is stable for the chart's lifetime.

### Modifier-key choices

- `e.ctrlKey || e.metaKey` covers both Linux/Windows `Ctrl` and macOS `Cmd`. Treating them equivalently matches platform expectations (Mac users rarely have a working `Ctrl` for this purpose; `Cmd` is the standard modifier).
- `e.shiftKey` alone, never combined. If a user presses `Ctrl + Shift + wheel`, the `Shift` branch wins (pan), because the conditional order checks shift first. We accept this as the most predictable rule and not worth disambiguating.
- `altKey` is ignored. No fourth behavior.

### Pan direction

`Shift + wheel-down` (`deltaY > 0`) pans to the right (forward in time). This matches the macOS trackpad convention where `Shift + vertical scroll` becomes rightward horizontal scroll, and the TradingView pan convention.

Some browsers convert `Shift + wheel` into a `deltaX` event with `deltaY = 0`. The helper uses `deltaY` only; if both `deltaX` and `deltaY` arrive zero, `Math.sign(0) === 0` and the helper returns `null` (no change). We could read `deltaX` as a fallback, but the dominant case in Chromium and Electron is `Shift` already swapping the delta onto `deltaY`, and we want one source of truth. If field testing reveals dead `Shift + wheel` on a specific platform, we add `deltaX` then — not preemptively.

### Zoom factor curve

`Math.exp(deltaY * 0.001)` is the same curve a continuous pinch would produce: a typical wheel notch of `deltaY = 100` yields a factor of ~1.105 (zoom out by ~10.5%) and `-100` yields ~0.905 (zoom in by ~9.5%). Larger trackpad gestures with `deltaY = 250` yield ~1.28, which still feels controlled.

Linear ±10% per notch was considered and rejected: it ignores `deltaY` magnitude, which matters for trackpads where one gesture emits a stream of small `deltaY` values that should compose into a smooth zoom rather than a single hard step.

### Anchor semantics — "latest candle"

The user phrased the default anchor as "the latest candle on screen." We interpret that as the rightmost visible logical index — i.e., `range.to` from `getVisibleLogicalRange()`. Alternatives considered:

- **Last logical index in the data** (`bundle.candles.length - 1`): rejected. When the user has panned away from the right edge to study earlier data, anchoring at the absolute last bar would jerk the view toward "now" on every wheel tick. That breaks the "I'm looking at this region, just give me more or less of it" expectation.
- **Right edge of visible range including `rightOffset` padding**: this is what `range.to` already represents. Acceptable — when zooming out, the padding bar count stays proportional to the visible span, which is the standard behavior.

Multi-day **Stock-Date Range** case: bar-index is continuous across **Day Boundaries** (the 1-second virtual-axis gap is invisible at the index layer). If `range.to` happens to land in a Day Boundary gap, the anchor still works correctly — no special handling needed.

### Interaction with existing subscribers

`setVisibleLogicalRange` triggers `subscribeVisibleLogicalRangeChange` and `subscribeVisibleTimeRangeChange`. Both already exist in `ChartStage`:

1. The zoom-in cap at [ChartStage.tsx:293-300](frontend/src/chart/ChartStage.tsx#L293-L300) — checks `barSpacing > 50` and snaps it back. Still applies; we don't need to duplicate the cap in the helper.
2. The viewport publisher at [ChartStage.tsx:178-192](frontend/src/chart/ChartStage.tsx#L178-L192) — publishes `(fromMs, toMs)` to `useViewportStore`. Pan and zoom will both correctly republish viewport; downstream consumers (PriceStrip, hover cards) see the change as if the library had handled it.

The crosshair handler at [ChartStage.tsx:203-212](frontend/src/chart/ChartStage.tsx#L203-L212) is unaffected — it subscribes to mouse-move, not wheel. **Cursor** (the per-`Replay Tab` `cursorMs`) updates via the existing PriceStrip fallback path: wheel → `setVisibleLogicalRange` → `visibleTimeRange` change → `useViewportStore` republish → PriceStrip writes the new right edge as the Cursor when no hover is active. No extra wiring needed.

## File Layout

Two files change:

1. **`frontend/src/chart/ChartStage.tsx`** — add `handleScale: { mouseWheel: false }` to `createChart`, add the new `useEffect` for the wheel listener.
2. **`frontend/src/util/wheelInteractions.ts`** (new) — exports `computeWheelOutcome` and its types. Keeping the helper out of `ChartStage.tsx` lets the unit test import the pure function without mocking the entire chart component.

One new test file:

3. **`frontend/src/util/wheelInteractions.test.ts`** (new) — Vitest cases covering all three branches plus edge cases (zero deltaY, span ≤ 0, `coordinateToLogical` returning null).

## Testing

### Unit tests — `wheelInteractions.test.ts`

| Case | Input | Expected |
|---|---|---|
| Plain wheel zoom out | `deltaY=100, range={0,100}`, no modifiers | `to` stays at 100, `from` decreases (~ -10.5) |
| Plain wheel zoom in | `deltaY=-100, range={0,100}`, no modifiers | `to` stays at 100, `from` increases (~ 9.5) |
| Ctrl wheel zoom out | `deltaY=100, range={0,100}`, ctrl, anchor logical=50 | both `from` and `to` expand outward from 50 |
| Cmd wheel zoom (Mac) | same as Ctrl but `metaKey` instead | identical result |
| Shift wheel pan right | `deltaY=100, range={0,100}`, shift | `from=10, to=110` (span unchanged) |
| Shift wheel pan left | `deltaY=-100, range={0,100}`, shift | `from=-10, to=90` |
| Shift+Ctrl wheel | both modifiers, `deltaY=100` | pan branch wins (shift checked first) |
| Zero deltaY | `deltaY=0` any modifier | `null` |
| Degenerate span | `range={5,5}` | `null` |
| Anchor returns null | Ctrl wheel, `coordinateToLogical` → null | falls back to `to` as anchor (no crash) |

### Manual verification

Open `/replay` with any stock-date selected. Verify:

1. Plain wheel zoom out — the right edge stays pinned, more candles appear on the left.
2. Plain wheel zoom in — the right edge stays pinned, the chart magnifies toward the latest bar.
3. `Shift + wheel` — the visible span stays constant; time axis slides left/right. Page does not scroll.
4. `Ctrl + wheel` (or `Cmd + wheel` on Mac) — the candle directly under the cursor stays under the cursor.
5. Existing zoom-in cap still active: spam wheel-up; `barSpacing` should plateau (the cap at 50 still fires).
6. Existing zoom-out floor still active: spam wheel-down; the chart settles when all bars fit (the resize-aware `minBarSpacing` floor still applies).
7. Crosshair, hover cards, and PriceStrip all keep tracking correctly during and after each interaction.

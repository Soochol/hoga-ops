# Replay Chart — Wheel Right Wall (Last-Candle Clamp)

**Date**: 2026-05-24
**Status**: Approved
**Scope**: `frontend/src/util/wheelInteractions.ts`, `frontend/src/util/wheelInteractions.test.ts`, `frontend/src/chart/ChartStage.tsx`

## Problem

The just-shipped modifier-aware wheel interactions ([2026-05-24-replay-mouse-interactions-design.md](2026-05-24-replay-mouse-interactions-design.md)) leave the right edge of the visible range unbounded for two of the three branches:

- **Ctrl/Cmd + wheel** (mouse-anchored zoom) expands both edges outward from the anchor. With zoom-out, the computed `to` can grow well past the last candle's logical index, producing a chart where the rightmost portion of the viewport is empty space and the data is squashed into the left side.
- **Shift + wheel** (pan) translates the range; panning right unbounded pushes `to` past the last candle so the user can scroll into a region with no data.

Plain wheel (right-edge-anchored zoom) keeps `to` fixed so it never violates this rule on its own.

The user wants both ctrl/shift paths to stop pushing `to` to the right once the last candle is at the right edge of the viewport. From the spec author's words: "마지막 캔들이 보일때까지" — until the last candle is at the visible edge.

The existing `barSpacing > 50` zoom-in cap and resize-aware `minBarSpacing` zoom-out floor bound bar widths, but not the position of `to` relative to the data window. This new rule is a separate constraint on the data position.

## Goals

- `Ctrl/Cmd + wheel` zoom-out stops growing `to` once `to` reaches `lastBarIndex`. Further ctrl-wheel-out ticks continue extending `from` to the left (the anchor effectively migrates to the right edge).
- `Shift + wheel` panning right stops translating once `to` reaches `lastBarIndex`. Span is preserved at the wall (the window's width does not change when it stops).
- The wall is computed from the active **RangeBundle**: `lastBarIndex = bundle.candles.length - 1`.
- The wall only applies to motion that would push `to` further right. Zoom-in and leftward pan are unaffected.
- Plain wheel (right-edge-anchored zoom) is unaffected — its behavior already cannot violate the rule.
- The branch math stays a pure function with unit tests; the data threshold (`maxTo`) is passed in from the React component.

## Non-Goals

- A left wall (clamp on `from`). Zoom-out continues to expand leftward freely past `from = 0`; the existing `minBarSpacing` floor already bounds how far you can zoom out in absolute bar-width terms.
- A soft "elastic" stop at the wall. The clamp is hard: when the new `to` would exceed `maxTo`, it snaps to `maxTo` for that wheel tick.
- Hiding empty space past the last candle that exists due to `rightOffset` padding at the default layout. The library renders a small gap by design; this spec only constrains user-initiated rightward motion.
- Surfacing a setting for the wall threshold. The wall is always at `lastBarIndex`, no user control.

## Design

### Threshold

The wall is at `maxTo = bundle.candles.length - 1` — the logical index of the last candle in the active **RangeBundle** (which spans the full **Stock-Date Range** for the active **Replay Tab**). When `bundle` is null (no data loaded), the helper receives `maxTo = Number.POSITIVE_INFINITY` and behaves identically to the pre-wall version, since the comparison `newTo > Infinity` is always false.

The default layout has `to ≈ lastBarIndex + rightOffset` (15) — that is, on initial mount the viewport already shows 15 bars of empty space past the last candle. Our rule treats that initial padding as a cosmetic default: the very first user-initiated ctrl-wheel-out or rightward shift-pan will snap `to` down to `lastBarIndex`, reclaiming the padding. This is intentional. The user asked the wall to be tight at the last candle; the initial padding is unrelated to user intent.

If field testing shows the snap is jarring, we can move `maxTo` to `lastBarIndex + 15` in one line, but the strict reading of the user's request is the default we ship.

### Direction-gated clamp

Both clamps apply only when motion is rightward:

- **Ctrl/Cmd + wheel:** clamp triggers when `newTo > maxTo && newTo > to` — i.e., the new `to` exceeds the wall AND was moving to the right. Zoom-in (factor < 1, `newTo < to`) never triggers the clamp, even when the current `to` is already past the wall (e.g., immediately after data load with the initial 15-bar padding).
- **Shift + wheel pan:** clamp triggers when `newTo > maxTo && step > 0` — panning rightward only.

This avoids surprising behavior where a zoom-in or leftward pan unexpectedly tightens the right edge.

### Clamp shape

The two branches handle the clamp differently because zoom and pan have different invariants:

| Branch | When clamped | New `to` | New `from` | Rationale |
|---|---|---|---|---|
| Ctrl/Cmd zoom-out | `newTo > maxTo && newTo > to` | `maxTo` | computed `from` (kept as-is) | The mouse anchor effectively migrates to the right edge — subsequent zoom-out continues to extend leftward only. Equivalent to the plain-wheel branch from this point onward. |
| Shift pan-right | `newTo > maxTo && step > 0` | `maxTo` | `maxTo - span` | Pan preserves span. The window's visible width shouldn't shrink because you bumped into the wall. |

### Helper signature change

```ts
export interface WheelInput {
  range: { from: number; to: number };
  deltaY: number;
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
  mouseX: number;
  coordinateToLogical: (x: number) => number | null;
  /**
   * Upper bound for the result's `to`. Typically `bundle.candles.length - 1`
   * — the logical index of the last candle in the active RangeBundle.
   * Pass `Number.POSITIVE_INFINITY` to disable the wall (e.g., before data
   * loads).
   */
  maxTo: number;
}
```

### Helper logic

```ts
export function computeWheelOutcome(i: WheelInput): WheelOutcome {
  const { from, to } = i.range;
  const span = to - from;
  if (span <= 0) return null;

  if (i.shiftKey) {
    const dir = Math.sign(i.deltaY);
    if (dir === 0) return null;
    const step = span * 0.1 * dir;
    const newFrom = from + step;
    const newTo = to + step;
    // Right wall: panning right past the last candle stops translating —
    // pin `to` at maxTo, preserve span.
    if (step > 0 && newTo > i.maxTo) {
      return { from: i.maxTo - span, to: i.maxTo };
    }
    return { from: newFrom, to: newTo };
  }

  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    const newFrom = anchor - (anchor - from) * factor;
    const newTo = anchor + (to - anchor) * factor;
    // Right wall: zoom-out that pushes `to` past the last candle clamps `to`
    // to maxTo. Computed `from` is kept so the anchor migrates to the right
    // edge and subsequent zoom-out extends only leftward.
    // Direction gate (`newTo > to`) ensures zoom-IN doesn't clamp even when
    // the current `to` is already past maxTo (initial state with rightOffset).
    if (newTo > to && newTo > i.maxTo) {
      return { from: newFrom, to: i.maxTo };
    }
    return { from: newFrom, to: newTo };
  }

  // Plain wheel: right-edge-anchored — `to` stays fixed.
  return { from: to - span * factor, to };
}
```

### ChartStage wiring

The `useEffect` that wires the listener gains one new line — computing `maxTo` from the active bundle — and the dependency array grows to include `bundle`:

```tsx
useEffect(() => {
  const container = containerRef.current;
  if (!chart || !container) return;
  const ts = chart.timeScale();
  // `candles.length === 0` would yield maxTo=-1 and clamp every wheel event
  // to a degenerate range — guard against the brief empty-bundle window.
  const maxTo =
    bundle && bundle.candles.length > 0
      ? bundle.candles.length - 1
      : Number.POSITIVE_INFINITY;

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
      maxTo,
    });
    if (outcome) ts.setVisibleLogicalRange(outcome);
  };

  container.addEventListener('wheel', onWheel, { passive: false });
  return () => container.removeEventListener('wheel', onWheel);
}, [chart, bundle]);
```

Re-attaching the listener when `bundle` changes is cheap (one `addEventListener` per **RangeBundle** swap — that is, per Stock-Date Range or Timeframe change in the active **Replay Tab**) and avoids any ref-juggling. The handler closes over `maxTo` directly so there's no stale-bundle risk.

### Interaction with existing clamps

- `barSpacing > 50` zoom-in cap at [ChartStage.tsx:296-304](frontend/src/chart/ChartStage.tsx#L296-L304): unaffected. Our wall only constrains `to` rightward; bar-width caps still trigger through `subscribeVisibleLogicalRangeChange`.
- `minBarSpacing` zoom-out floor at [ChartStage.tsx:278](frontend/src/chart/ChartStage.tsx#L278): unaffected. The bar-width floor and the data-position wall constrain orthogonal quantities; they can compose.
- Initial `fitContent()` + `rightOffset = 15`: unaffected. Initial state has `to ≈ lastBarIndex + 15`. The wall is silent until the first ctrl-out or shift-pan-right, at which point `to` snaps to `lastBarIndex`.

### Cursor side-effect at the wall

When the first ctrl/shift event snaps `to` from `lastBarIndex + 15` to `lastBarIndex`, the viewport publisher republishes the new right edge and PriceStrip writes it to the active **Replay Tab**'s `cursorMs` — _only if no hover-driven crosshair update is active_. In practice the user is almost always hovering the chart while turning the wheel, so the crosshair handler at [ChartStage.tsx:203-212](frontend/src/chart/ChartStage.tsx#L203-L212) owns Cursor and the snap is invisible to the **Cursor Sidebar**. The no-hover case (e.g., user clicks elsewhere then triggers wheel from a hotkey/macro) would jump Cursor backward by ~15 bar buckets — acceptable and consistent with how PriceStrip already handles right-edge changes.

### What about plain wheel and shift-pan-left?

- **Plain wheel** preserves `to`. If the user has just loaded data (`to = lastBarIndex + 15 > maxTo`), plain wheel-out keeps that 115. After a ctrl/shift event tightens it to `lastBarIndex`, plain wheel keeps it there. No clamp needed on this branch.
- **Shift-pan-left** decreases `to`. No clamp needed.

The result: once the right edge is tightened by any user action, it stays tight until they pan/zoom-in to a region away from the wall.

## Testing

### Unit tests — additions to `wheelInteractions.test.ts`

| Case | Setup | Expected |
|---|---|---|
| Ctrl zoom-out past wall | `range={50,99}, deltaY=100, ctrl, anchor=80, maxTo=100` | `to=100` (clamped), `from` from formula |
| Ctrl zoom-out under wall | `range={50,90}, deltaY=100, ctrl, anchor=70, maxTo=100`; computed `newTo ≈ 92.1` (< maxTo) | not clamped, exact formula values |
| Ctrl zoom-in with `to > maxTo` | `range={0,115}, deltaY=-100, ctrl, anchor=50, maxTo=100` | not clamped (direction gate); formula values, `to'<to` |
| Ctrl zoom with `maxTo = Infinity` | any ctrl input with `maxTo=Infinity` | identical to pre-wall behavior |
| Shift pan-right under wall | `range={50,90}, deltaY=100, shift, maxTo=100`; span=40, step=4 → newTo=94 | not clamped, `{from: 54, to: 94}` |
| Shift pan-right hitting wall | `range={50,99}, deltaY=100, shift, maxTo=100`; span=49, step=4.9 → newTo=103.9 | clamped, `{from: 51, to: 100}` (span 49 preserved) |
| Shift pan-left with `to > maxTo` | `range={20,115}, deltaY=-100, shift, maxTo=100`; step=-9.5 | not clamped (step<0), `{from: 10.5, to: 105.5}` |
| Shift pan-right large span | `range={5,95}, deltaY=100, shift, maxTo=100`; span=90, step=9 → newTo=104 | clamped, `{from: 10, to: 100}` (span 90 preserved) |
| Plain wheel unchanged by wall | `range={0,100}, deltaY=100, maxTo=50` | `to=100` (unchanged because plain wheel branch doesn't consult maxTo); `from<0` |
| Existing `Shift > Ctrl` precedence still holds | `range={0,100}, deltaY=100, shift+ctrl, maxTo=Infinity` | pan result (existing test, just confirm maxTo addition didn't break) |

All previously existing tests must still pass after adding the `maxTo` field to `baseInput()` (default `Number.POSITIVE_INFINITY`).

### Manual verification — `/replay`

1. Open `/replay`, load a stock-date with > 100 candles. Initial layout shows ~15 bars of empty space past the last candle.
2. **Ctrl+wheel-out** (hover near the chart middle): zoom out a few ticks. The first tick should snap the rightmost padding tight to the last candle. Subsequent ticks should expand the left side only; the last candle stays glued to the right edge.
3. **Ctrl+wheel-in** while at the wall: zoom in normally — last candle un-pins as the visible window shrinks.
4. **Shift+wheel right**: drag the window right via shift-pan. Should stop translating once the last candle hits the right edge. Subsequent shift-right ticks are no-ops (or visually static).
5. **Shift+wheel left** from any state: pans left freely. The wall doesn't interfere.
6. **Plain wheel** behavior: unchanged from the previous spec — zoom anchored at the right edge.
7. **Switching tabs / changing date range**: load a Stock-Date Range with a different number of candles. Repeat steps 2-5 to confirm `maxTo` updates correctly (no stale bundle reference).

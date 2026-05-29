/**
 * Pure helper that computes a new lightweight-charts logical range
 * (`{from, to}`) for one wheel event on the replay chart.
 *
 * Three branches, selected by modifiers:
 *  - `shiftKey` → pan: translate the range, span unchanged.
 *  - `ctrlOrMetaKey` → zoom anchored at the mouse coordinate.
 *  - default → zoom anchored at `range.to` (rightmost visible candle).
 *
 * Right wall: only the shift branch clamps when rightward motion would
 * push `to` past `maxTo` (typically the last candle's logical index).
 * The ctrl branch preserves the mouse-anchor invariant unconditionally and
 * lets `to` extend past `maxTo` — clamping it would warp the anchor's
 * screen position. Plain wheel is unaffected because it never increases `to`.
 *
 * No DOM, no chart library — separated so the branching logic is
 * unit-testable without mounting a chart.
 *
 * See: `docs/superpowers/specs/2026-05-24-replay-mouse-interactions-design.md`,
 *      `docs/superpowers/specs/2026-05-24-replay-wheel-right-wall-design.md`
 */

export interface WheelInput {
  range: { from: number; to: number };
  deltaY: number;
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
  /** Mouse X relative to the chart container's left edge, in CSS px. */
  mouseX: number;
  /** Chart `timeScale.coordinateToLogical(x)` callback (may return null). */
  coordinateToLogical: (x: number) => number | null;
  /**
   * Upper bound for the result's `to`. Typically `bundle.candles.length - 1`
   * — the logical index of the last candle in the active RangeBundle.
   * Pass `Number.POSITIVE_INFINITY` to disable the wall (e.g., before data
   * loads).
   */
  maxTo: number;
}

export type WheelOutcome = { from: number; to: number } | null;

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

  // deltaY > 0 (wheel down) → factor > 1 → zoom OUT.
  // deltaY < 0 (wheel up) → factor < 1 → zoom IN.
  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    const newFrom = anchor - (anchor - from) * factor;
    const newTo = anchor + (to - anchor) * factor;
    // No right-wall clamp here: clamping `to` while leaving `from` at the
    // formula value breaks the anchor-ratio invariant, causing the candle
    // under the mouse to drift on screen. The library renders empty space
    // past the last candle by design, so letting `to` exceed `maxTo` on
    // ctrl-zoom-out is acceptable. `maxTo` still constrains shift-pan.
    return { from: newFrom, to: newTo };
  }

  // Default: right-edge-anchored zoom — `to` stays fixed.
  return { from: to - span * factor, to };
}

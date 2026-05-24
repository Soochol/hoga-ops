/**
 * Pure helper that computes a new lightweight-charts logical range
 * (`{from, to}`) for one wheel event on the replay chart.
 *
 * Three branches, selected by modifiers:
 *  - `shiftKey` → pan: translate the range, span unchanged.
 *  - `ctrlOrMetaKey` → zoom anchored at the mouse coordinate.
 *  - default → zoom anchored at `range.to` (rightmost visible candle).
 *
 * No DOM, no chart library — separated so the branching logic is
 * unit-testable without mounting a chart.
 *
 * See: `docs/superpowers/specs/2026-05-24-replay-mouse-interactions-design.md`
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
    return { from: from + step, to: to + step };
  }

  // deltaY > 0 (wheel down) → factor > 1 → zoom OUT.
  // deltaY < 0 (wheel up) → factor < 1 → zoom IN.
  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    return {
      from: anchor - (anchor - from) * factor,
      to: anchor + (to - anchor) * factor,
    };
  }

  // Default: right-edge-anchored zoom — `to` stays fixed.
  return { from: to - span * factor, to };
}

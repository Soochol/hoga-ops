/**
 * Pure helper that computes a new lightweight-charts logical range
 * (`{from, to}`) for one wheel event on the replay chart.
 *
 * Three branches, selected by modifiers:
 *  - `shiftKey` → pan: translate the range, span unchanged.
 *  - `ctrlOrMetaKey` → zoom anchored at the mouse coordinate.
 *  - default → zoom anchored at the latest candle (`lastBarIndex`) when it is
 *    at/inside the right edge, else at `range.to` (the viewport right edge,
 *    when scrolled into history).
 *
 * Right wall: only the shift branch clamps when rightward motion would
 * push `to` past `maxTo` (typically the last candle's logical index).
 * The ctrl and plain branches preserve their anchor's screen position
 * unconditionally and let `to` extend past `maxTo` — clamping `to` while
 * leaving `from` at the formula value would warp the anchor. `maxTo` only
 * bounds shift-pan.
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
   * Upper bound for the result's `to` — the latest candle's logical index plus
   * `rightOffset` (the default live-view position). The hook derives the index
   * via `ts.timeToIndex(latestCandleTime)`, NOT `bundle.candles.length - 1`:
   * the shared timeScale indexes the union of all panes' time points, so quote
   * panes add points and `candles.length - 1` understates the true index
   * (observed skew ~273). Pass `Number.POSITIVE_INFINITY` to disable the wall
   * (e.g., before data loads).
   */
  maxTo: number;
  /**
   * Logical index of the latest candle, used as the plain-wheel zoom anchor
   * when it sits at/inside the right edge. Keeps the latest candle pixel-fixed
   * on zoom IN as well as OUT — anchoring on `range.to` (which includes the
   * `rightOffset` padding) let the candle drift left on zoom-in as the
   * padding's pixel share grew. Source: `ts.timeToIndex(latestCandleTime)` in
   * the hook (same union-index reason as `maxTo` — `candles.length - 1` is
   * skewed). When omitted, or when the view is scrolled into history
   * (`range.to < lastBarIndex`), the anchor falls back to `range.to`
   * (right-edge-fixed, per design decision #1).
   */
  lastBarIndex?: number;
  /**
   * Upper bound for the result's span (visible bar count). Typically
   * `timeScale.width() / minBarSpacing` — the library's zoom-out floor.
   * Without this clamp, a zoom request past the floor gets its barSpacing
   * rejected by lightweight-charts while the right edge still applies,
   * degenerating the zoom into a rightward PAN that breaks the ctrl
   * anchor (/diagnose 2026-06-08). Clamping here preserves the anchor
   * ratio at the floor instead. Omit (or pass Infinity) to disable.
   */
  maxSpan?: number;
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
    return clampSpanAroundAnchor(newFrom, newTo, anchor, i.maxSpan);
  }

  // Default: anchor at the latest candle when it's at/inside the right edge
  // (live-edge zoom keeps the last candle pixel-fixed on zoom in AND out),
  // else at `to` (scrolled into history → pin the viewport right edge, per
  // decision #1). `Math.min(to, lastBarIndex)` selects between the two; with
  // lastBarIndex omitted it degrades to the old `anchor = to` behavior.
  const anchor = Math.min(to, i.lastBarIndex ?? to);
  const newFrom = anchor - (anchor - from) * factor;
  const newTo = anchor + (to - anchor) * factor;
  return clampSpanAroundAnchor(newFrom, newTo, anchor, i.maxSpan);
}

/**
 * Clamp a zoom result's span to `maxSpan` while keeping the anchor's
 * RATIO inside the range unchanged — so the bar under the cursor stays at
 * the same pixel even when the library's barSpacing floor is in play.
 * Shift-pan never calls this: its span is unchanged by construction.
 */
function clampSpanAroundAnchor(
  from: number,
  to: number,
  anchor: number,
  maxSpan: number | undefined,
): { from: number; to: number } {
  const span = to - from;
  const max = maxSpan ?? Number.POSITIVE_INFINITY;
  // !(max > 0): 0/NaN 가드 — 폭 미측정(width()=0) 등에서는 클램프 비활성.
  if (!(max > 0) || span <= max) return { from, to };
  const ratio = (anchor - from) / span;
  const clampedFrom = anchor - ratio * max;
  return { from: clampedFrom, to: clampedFrom + max };
}

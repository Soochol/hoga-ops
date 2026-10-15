/**
 * Pure helper that computes a new lightweight-charts logical range
 * (`{from, to}`) for one wheel event on the live chart.
 *
 * Three branches, selected by modifiers:
 *  - `shiftKey` → pan: translate the range, span unchanged.
 *  - `ctrlOrMetaKey` → zoom anchored at the mouse coordinate.
 *  - default → zoom anchored at the latest candle (`lastBarIndex`) when it is
 *    at/inside the right edge, else at the rightmost visible candle.
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
  /** Plot width in CSS px. With a measured width, Ctrl zoom uses the continuous
   * cursor coordinate rather than coordinateToLogical's integer candle bin. */
  plotWidth?: number;
  /** Fallback cursor mapping when the plot width is unavailable. */
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
   * skewed). Historical views use `visibleCandleIndex` instead.
   */
  lastBarIndex?: number;
  /** Rightmost actual candle whose centre is inside the historical viewport.
   * Uses the shared time-grid index, not the candle-array index. */
  visibleCandleIndex?: number;
  /** First actual candle index, for the native minimum-data exposure limit. */
  firstBarIndex?: number;
  /**
   * Upper bound for the result's span (visible bar count). Typically
   * `timeScale.width() / minBarSpacing - 1` — the inclusive-range zoom floor.
   * Without this clamp, a zoom request past the floor gets its barSpacing
   * rejected by lightweight-charts while the right edge still applies,
   * degenerating the zoom into a rightward PAN that breaks the ctrl
   * anchor (/diagnose 2026-06-08). Clamping here preserves the anchor
   * ratio at the floor instead. Omit (or pass Infinity) to disable.
   */
  maxSpan?: number;
  /** Lower bound for `to - from`, derived from the maximum bar spacing. */
  minSpan?: number;
}

export type WheelOutcome = { from: number; to: number } | null;

export function computeWheelOutcome(i: WheelInput): WheelOutcome {
  const { from, to } = i.range;
  const span = to - from;
  if (!Number.isFinite(from) || !Number.isFinite(to) || span < 0 || !Number.isFinite(i.deltaY) || i.deltaY === 0) return null;

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

  // lwc's range includes both boundary bars. Clamp the BAR COUNT before
  // positioning either edge, so native spacing limits cannot turn zoom into pan.
  const count = span + 1;
  const width = i.plotWidth;
  const anchor = i.ctrlOrMetaKey
    ? width != null && Number.isFinite(width) && width > 0
      ? to + 0.5 - (width - 1 - i.mouseX) * count / width
      : i.coordinateToLogical(i.mouseX)
    : i.lastBarIndex != null && i.lastBarIndex <= to ? i.lastBarIndex : i.visibleCandleIndex ?? null;
  let minSpan = Math.max(0, i.minSpan ?? 0);
  if (anchor != null && i.lastBarIndex != null) {
    // Native rightOffset is bounded by count - min(2, data points). In the
    // empty right gutter, hitting that limit would silently pan the chart.
    // Stop zooming BEFORE that correction, preserving the same screen anchor.
    // The latest candle is a conservative data edge when other panes extend
    // the shared time grid further to the right.
    const visibleRatio = (anchor - from + .5) / count;
    const minVisible = Math.min(2, i.lastBarIndex + 1);
    if (visibleRatio > 0) {
      minSpan = Math.max(minSpan, (anchor - i.lastBarIndex + minVisible - .5) / visibleRatio - 1);
    }
    if (i.firstBarIndex != null) {
      // At the oldest data edge lwc also requires at least two exposed grid
      // points. Stop before that clamp can move the historical candle.
      const rightRatio = (to - anchor + .5) / count;
      const minExposed = Math.min(2, i.lastBarIndex - i.firstBarIndex + 1);
      if (rightRatio > 0) {
        minSpan = Math.max(minSpan,
          (i.firstBarIndex + minExposed - 1 - anchor + .5) / rightRatio - 1);
      }
    }
  }
  const maxSpan = i.maxSpan != null && i.maxSpan > 0 ? Math.max(minSpan, i.maxSpan) : Infinity;
  const nextSpan = Math.max(minSpan, Math.min(maxSpan, count * Math.exp(i.deltaY * 0.001) - 1));
  if (!Number.isFinite(nextSpan)) return null;
  if (Math.abs(nextSpan - span) < 1e-9) return { from, to };
  const ratio = (nextSpan + 1) / count;

  if (i.ctrlOrMetaKey) {
    // No right-wall clamp here: clamping `to` while leaving `from` at the
    // formula value breaks the anchor-ratio invariant, causing the candle
    // under the mouse to drift on screen. The library renders empty space
    // past the last candle by design, so letting `to` exceed `maxTo` on
    // ctrl-zoom-out is acceptable. `maxTo` still constrains shift-pan.
    return zoomRange(to, nextSpan, ratio, anchor);
  }

  // Historical candles need the same half-bar centre correction as the latest
  // candle. Keeping only the numeric `to` moved them by half the spacing change.
  return zoomRange(to, nextSpan, ratio, anchor);
}

/**
 * lwc draws index a at width - 1 - (to - a + .5) * width / (span + 1).
 * Preserve that pixel coordinate, including the half-bar centre. Without an
 * anchor, preserve the historical-view right logical edge instead.
 */
function zoomRange(
  to: number,
  span: number,
  ratio: number,
  anchor: number | null,
): { from: number; to: number } {
  const newTo = anchor == null ? to : anchor - 0.5 + (to - anchor + 0.5) * ratio;
  return { from: newTo - span, to: newTo };
}

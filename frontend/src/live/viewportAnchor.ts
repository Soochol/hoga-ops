import type { Time } from 'lightweight-charts';
import type { VirtualAxis } from '../util/virtualAxis';
import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

/**
 * Per-tab saved chart viewport (ADR-0069 A안 — 탭별 보던 위치 복원).
 *
 * A TIME anchor, not a logical index: a cold tab switch re-fetches data and
 * rebuilds the axis, so bar indices are NOT stable across the swap. The
 * right-edge real-ms re-projects through the new axis (`anchorToLogicalIndex`),
 * and the bar span re-applies the zoom. Same primitive useViewportBackfill's
 * prepend repositioner uses (refMs → reproject), different trigger (cold
 * tab restore vs in-session prepend).
 *
 *   capture (탭 떠날 때)              restore (탭 돌아올 때, 캔들 도착 후)
 *   ──────────────────              ──────────────────────────────
 *   getVisibleRange().to ─toReal→   rightEdgeMs ─toVirtual→timeToIndex→ idx
 *   getVisibleLogicalRange span     {from: idx-span, to: idx}
 *   right edge ≈ last candle?        atLiveEdge → pin latest unless userAdjusted
 */
export interface TabViewport {
  /** Real KST ms at the right edge of the visible range (getVisibleRange().to). */
  rightEdgeMs: number;
  /** Visible width in bars (getVisibleLogicalRange().to - .from); carries zoom. */
  barSpan: number;
  /** Right-side chart whitespace in logical bars after the latest candle. Runtime-only. */
  rightPaddingBars?: number;
  /**
   * Captured at the live edge — restore should keep following the latest
   * candle (pin right) rather than pinning the now-stale right-edge bar with
   * newer candles off-screen. Without this, the common "watch live → flip tab
   * → flip back" path returns one bar behind the live edge and reads as broken.
   */
  atLiveEdge: boolean;
  /**
   * Captured after an explicit wheel zoom/pan. Daily live-edge self-healing
   * should preserve this view instead of treating the wider span as an
   * accidental resize expansion.
   */
  userAdjusted?: boolean;
}

interface LogicalRange {
  from: number;
  to: number;
}
interface VisibleRange {
  to: Time | number;
}

/**
 * Pure: build a TabViewport from the chart's two range reads + the axis.
 * Null when either read is missing or the math is non-finite (a still-empty
 * or torn-down chart), so the caller simply skips the snapshot.
 */
export function viewportFromRanges(
  lr: LogicalRange | null,
  vr: VisibleRange | null,
  axis: VirtualAxis,
  lastCandleMs: number | null,
  lastCandleLogicalIndex?: number | null,
): TabViewport | null {
  if (!lr || !vr || axis.segments.length === 0) return null;
  const rightEdgeMs = axis.toReal((vr.to as number) * 1000);
  const barSpan = lr.to - lr.from;
  if (!Number.isFinite(rightEdgeMs) || !Number.isFinite(barSpan) || barSpan <= 0) return null;
  // At-live-edge: right edge within ~1s of the last real candle. The 1s
  // tolerance absorbs the toReal round-trip; a scrolled-back view lands well
  // below lastCandleMs so the check is never borderline there.
  const atLiveEdge = lastCandleMs !== null && rightEdgeMs >= lastCandleMs - 1000;
  const rightPaddingBars =
    typeof lastCandleLogicalIndex === 'number' && Number.isFinite(lastCandleLogicalIndex)
      ? lr.to - (lastCandleLogicalIndex + 1)
      : null;
  return {
    rightEdgeMs,
    barSpan,
    atLiveEdge,
    ...(rightPaddingBars !== null && rightPaddingBars >= 0 ? { rightPaddingBars } : {}),
  };
}

/**
 * Virtual seconds for a real-ms anchor, ready for `timeScale.timeToIndex()`.
 * Rounded because UTCTimestamp must be an integer and the toReal→toVirtual
 * round-trip can land a hair off a bar boundary (mirrors useViewportBackfill's
 * reposition rounding at :170).
 */
export function realMsToVirtualSeconds(axis: VirtualAxis, realMs: number): number {
  return Math.round(axis.toVirtual(realMs) / 1000);
}

export interface RestoreRange {
  from: number;
  to: number;
  /** Snap the right edge to the latest bar after setting the range (live-edge
   *  restore only) — mirrors the minute initial-view's scrollToPosition(0). */
  scrollToRight: boolean;
}

/**
 * Pure: the logical range to apply on a cold restore.
 *
 * Clamps the APPLIED `from` to `>= 0` (a non-negative target keeps the restore
 * inside loaded data; lwc may still report a fractional `from` back through
 * subscribeVisibleLogicalRangeChange once rightOffset padding is applied, but a
 * single self-limiting chunk-extend is the worst case there — the monotonic
 * extendHistoricalRange guard absorbs repeats).
 *
 * Returns null when the anchor can't be placed (anchorIndex null) and it is not
 * a live-edge restore → the caller falls back to the default initial view. The
 * caller passes anchorIndex=null when the anchor is off the left edge of loaded
 * data (older than the earliest bar); lwc's findNearest timeToIndex would
 * otherwise clamp such an anchor to bar 0 and yield a degenerate window.
 */
export function computeRestoreRange(
  anchor: TabViewport,
  totalBars: number,
  anchorIndex: number | null,
  rightOffsetOverride?: number,
): RestoreRange | null {
  const span = Math.max(1, Math.round(anchor.barSpan));
  const rightOffset = rightOffsetOverride ?? (CHART_TIMESCALE_OPTIONS.rightOffset ?? 0);
  const savedRightPadding =
    typeof anchor.rightPaddingBars === 'number' && Number.isFinite(anchor.rightPaddingBars)
      ? Math.max(0, anchor.rightPaddingBars)
      : null;
  if (anchor.atLiveEdge && savedRightPadding !== null) {
    const to = totalBars + savedRightPadding;
    return { from: Math.max(0, to - span), to, scrollToRight: false };
  }
  if (anchor.atLiveEdge && anchor.userAdjusted !== true) {
    // Follow live: keep the saved zoom while preserving the standard right
    // whitespace band after the latest bar.
    return { from: Math.max(0, totalBars - span), to: totalBars + rightOffset, scrollToRight: false };
  }
  if (anchorIndex === null) return null;
  return { from: Math.max(0, anchorIndex - span), to: anchorIndex, scrollToRight: false };
}

import type { VirtualAxis } from '../../util/virtualAxis';

/**
 * Shared building blocks for the **Auction Mask** rendering action (ADR-0029).
 *
 * Three chart-pane projectors (RatioPane, QuoteTotalsPane, Cumulative Net Fill)
 * each need to emit "this point should be invisible during the closing Auction
 * Window" markers. They differ only in which `color` field(s) the series type
 * accepts: BaselineSeries needs six (top/bottom × line/fill1/fill2), LineSeries
 * needs one (`color`). The predicate `isAuctionHidden` and the color constants
 * are factored out here so the rgba sentinel lives in one place and a future
 * change to the masking technique (different sentinel, opacity, etc.) touches
 * one file.
 *
 * Why not just drop the in-window points and let the indicators go empty (the
 * "filter at source" model)? Two lightweight-charts v5 behaviours block it:
 *   1. Time-scale is bar-index based. Dropping points shrinks the visible
 *      range past the auction window, so `AuctionWindowOverlay`'s
 *      `timeToCoordinate(auctionStart)` returns null and the highlight band
 *      disappears.
 *   2. LineSeries / BaselineSeries silently interpolate across both
 *      `WhitespaceData` and missing-time gaps, so day-N close would still
 *      draw a diagonal into day-(N+1) open.
 * Per-point transparent `color` is the documented escape hatch. See ADR-0029.
 */

export const TRANSPARENT = 'rgba(0,0,0,0)';

/** Per-point overrides for BaselineSeries (RatioPane). The series renders
 *  both a line and a gradient fill — each needs its own transparent override
 *  or the auction-window plateau remains visible as the fill. */
export const BASELINE_HIDDEN_COLORS = {
  topLineColor: TRANSPARENT,
  topFillColor1: TRANSPARENT,
  topFillColor2: TRANSPARENT,
  bottomLineColor: TRANSPARENT,
  bottomFillColor1: TRANSPARENT,
  bottomFillColor2: TRANSPARENT,
} as const;

/** Per-point override for LineSeries (QuoteTotalsPane, Cumulative Net Fill).
 *  `color` paints the *outgoing* segment from this point, so transparent here
 *  hides the connector to the next point. Day-boundary connectors are also
 *  covered because the day-N last in-auction point's outgoing segment goes
 *  to day-(N+1)'s first value. */
export const LINE_HIDDEN_COLOR = { color: TRANSPARENT } as const;

/**
 * The single predicate: "should this `t` be hidden by the Auction Mask?".
 * Returns false fast when the toggle is off so callers can use it inline
 * without an outer guard.
 */
export function isAuctionHidden(
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow'>,
  mask: boolean,
  t: number,
): boolean {
  if (!mask) return false;
  return axis.inClosingAuctionWindow(t);
}

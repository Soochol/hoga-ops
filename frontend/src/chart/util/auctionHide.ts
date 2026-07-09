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

/**
 * ADR-0062 v2 — 구조적 마스크 보강. 호가비·총잔량 계산에서 배제된 붕괴 버킷(마감
 * 동시호가 **및 장중 VI**)은 `(bid_total, ask_total) = (0, 0)` 센티넬로 방출된다
 * (연속거래 책은 deep-book 정의상 항상 양측 잔량 > 0이라 (0,0)이 붕괴를 유일 식별).
 * 시간 마스크(inClosingAuctionWindow)는 15:20~15:30만 가리므로, 이 구조 센티넬을
 * 함께 봐야 장중 VI (0,0) 평지가 가려진다. mask 토글 OFF면 false(기존처럼 (0,0) 노출).
 */
export function isExcludedQuoteBucket(
  mask: boolean,
  bidTotal: number,
  askTotal: number,
): boolean {
  return mask && bidTotal === 0 && askTotal === 0;
}

/**
 * Break the visible connector INTO a masked auction run.
 *
 * The Auction Mask transparents each masked point's OUTGOING segment
 * (lightweight-charts colors the segment that *leaves* a point), but the
 * connector FROM the last pre-auction point INTO the first masked point stays
 * visible — the line slopes from the last continuous bucket across the auction
 * window down to the masked `value: 0` point (the "내려가며 뻗는 연결선"). Call
 * this right before pushing a masked point to transparent the previous emitted
 * point's outgoing segment. Idempotent within a masked run: re-applying the
 * hidden color to an already-hidden previous point is a no-op. No-op when `out`
 * is empty (the run starts at the viewport edge).
 *
 * `projectCumulativeNetFill` solves the same problem inline via
 * `lastPreAuctionIdx`; the line/baseline quote projectors use this helper.
 */
export function maskOutgoingConnector<T extends object>(out: T[], hiddenColors: object): void {
  const i = out.length - 1;
  if (i >= 0) out[i] = { ...out[i], ...hiddenColors } as T;
}

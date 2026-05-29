import type { VirtualAxis } from '../util/virtualAxis';
import { useChartPrefsStore } from './chartPrefs';

/**
 * Returns whether the **Auction Mask** is currently active for the
 * caller-provided cursor (CONTEXT.md "Auction Mask").
 *
 * Active iff (1) the global `auctionWindowMask` toggle is on AND (2) the
 * cursor falls inside the closing Auction Window. The toggle short-circuits
 * the axis predicate so a `false` toggle skips work entirely.
 *
 * Pure shape `(axis, cursorMs) => boolean`: the caller owns both the axis
 * and the cursor source (per-tab cursor lives in the surface-specific
 * store, e.g. `useLiveCursorStore` for /live), while the toggle reads from
 * the global `useChartPrefsStore` (ADR-0048 — chart prefs are app-wide,
 * not per-tab).
 *
 * Chart-pane projectors use the state-machine variant
 * `chart/util/auctionMaskGap` instead, which encapsulates the same
 * predicate plus boundary-whitespace emission for line series (ADR-0029).
 */
export function useAuctionMaskActive(
  axis: VirtualAxis | null,
  cursorMs: number | null,
): boolean {
  const auctionWindowMask = useChartPrefsStore((s) => s.auctionWindowMask);
  if (!auctionWindowMask) return false;
  if (axis === null || cursorMs === null) return false;
  return axis.inClosingAuctionWindow(cursorMs);
}

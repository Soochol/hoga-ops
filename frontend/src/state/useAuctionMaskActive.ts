import { useTabsStore } from './tabs';
import { useCursor } from '../api/useCursor';
import type { VirtualAxis } from '../util/virtualAxis';

/**
 * Returns whether the **Auction Mask** is currently active for the active
 * tab's cursor (CONTEXT.md "Auction Mask").
 *
 * Active iff (1) the per-tab `auctionWindowMask` toggle is on AND (2) the
 * cursor falls inside the closing Auction Window. The toggle short-circuits
 * the axis predicate so a `false` toggle skips work entirely.
 *
 * This is the single spot-view consumer of the Auction Mask. Chart-pane
 * projectors use the state-machine variant `chart/util/auctionMaskGap`
 * instead, which encapsulates the same predicate plus boundary-whitespace
 * emission for line series (ADR-0029).
 */
export function useAuctionMaskActive(axis: VirtualAxis): boolean {
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask);
  const { cursorMs } = useCursor();
  if (!auctionWindowMask) return false;
  if (cursorMs == null || !Number.isFinite(cursorMs)) return false;
  return axis.inClosingAuctionWindow(cursorMs);
}

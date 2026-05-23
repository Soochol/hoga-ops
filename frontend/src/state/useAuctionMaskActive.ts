import { useTabsStore } from './tabs';
import { useCursor } from '../api/useCursor';
import type { VirtualAxis } from '../util/virtualAxis';

/**
 * Returns whether the Auction Mask is currently active for the active tab's cursor.
 *
 * Auction Mask is active iff (1) the per-tab `auctionWindowMask` toggle is on AND
 * (2) the cursor falls inside the closing Auction Window (`VirtualAxis.inClosingAuctionWindow`).
 * Spot views (TotalQtyBar, future masking consumers) read this; series projectors that
 * loop over many `t` values inline the same predicate because they cannot call hooks.
 */
export function useAuctionMaskActive(axis: VirtualAxis): boolean {
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask);
  const { cursorMs } = useCursor();
  if (!auctionWindowMask) return false;
  if (cursorMs == null || !Number.isFinite(cursorMs)) return false;
  return axis.inClosingAuctionWindow(cursorMs);
}

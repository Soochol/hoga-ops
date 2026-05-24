import { useTabsStore } from './tabs';
import { useCursor } from '../api/useCursor';
import { isAuctionMaskActive } from '../util/auctionMask';
import type { VirtualAxis } from '../util/virtualAxis';

/**
 * Returns whether the Auction Mask is currently active for the active tab's cursor.
 *
 * Active iff (1) the per-tab `auctionWindowMask` toggle is on AND (2) the cursor
 * falls inside the closing Auction Window. The rule itself lives in
 * `util/auctionMask.isAuctionMaskActive`; this hook owns the store + cursor
 * reads plus the cursor-null guard. Spot views (TotalQtyBar, etc.) use this;
 * series projectors call `isAuctionMaskActive` directly (cannot use hooks).
 */
export function useAuctionMaskActive(axis: VirtualAxis): boolean {
  const auctionWindowMask = useTabsStore((s) => s.getPrefs(s.activeTabId).auctionWindowMask);
  const { cursorMs } = useCursor();
  if (cursorMs == null || !Number.isFinite(cursorMs)) return false;
  return isAuctionMaskActive(auctionWindowMask, axis, cursorMs);
}

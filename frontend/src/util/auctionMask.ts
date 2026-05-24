import type { VirtualAxis } from './virtualAxis';

/**
 * Pure Auction Mask predicate (CONTEXT.md "Auction Mask").
 *
 * Returns `true` iff (1) the per-tab `auctionWindowMask` toggle is on AND
 * (2) `t` falls inside the closing Auction Window per `VirtualAxis`.
 *
 * Used by series projectors that loop over many `t` values; the React hook
 * variant `state/useAuctionMaskActive` delegates here after threading cursor
 * + null guards.
 *
 * The narrow `Pick<VirtualAxis, 'inClosingAuctionWindow'>` parameter lets
 * test fakes satisfy the contract without constructing a full `VirtualAxis`.
 */
export function isAuctionMaskActive(
  auctionWindowMask: boolean,
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow'>,
  t: number,
): boolean {
  if (!auctionWindowMask) return false;
  return axis.inClosingAuctionWindow(t);
}

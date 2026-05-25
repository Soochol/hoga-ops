import type { Time, WhitespaceData } from 'lightweight-charts';
import type { VirtualAxis } from '../../util/virtualAxis';

/**
 * State-machine helper for projectors that need to drop in-auction-window
 * points AND break their continuous line cleanly at the 15:20 boundary
 * (ADR-0029). Without an explicit `WhitespaceData` at the boundary,
 * lightweight-charts would interpolate a straight segment from the last
 * pre-window point to the first post-window (or next-day) point —
 * a "phantom break" that crosses the empty band diagonally.
 *
 * Usage in a projector loop:
 *
 *     const gap = makeAuctionMaskGap(axis, ctx.auctionWindowMask);
 *     const out = [];
 *     for (const p of bundle.points) {
 *       if (!axis.contains(p.t)) continue;
 *       const br = gap.breakBefore(p.t);
 *       if (br) out.push(br);
 *       if (gap.isHidden(p.t)) continue;
 *       out.push({ time: virtualSeconds(p.t), value: p.value });
 *     }
 *
 * When `enabled` is false, both methods are no-ops so projectors can call
 * them unconditionally.
 *
 * `reset()` is provided for callers that iterate segments outermost
 * (Cumulative Net Fill) — it clears the "we already broke" flag so a
 * fresh segment's first in-auction point still triggers a break. Day
 * boundaries already insert their own whitespace via the existing
 * per-segment logic; both whitespaces can coexist (different timestamps).
 */
export type AuctionMaskGap = {
  /** Returns a WhitespaceData to push BEFORE emitting the current point,
   *  or null. Called once per point. */
  breakBefore(t: number): WhitespaceData<Time> | null;
  /** Whether this point should be skipped (inside the auction window). */
  isHidden(t: number): boolean;
  /** Re-arm the entry-detection flag. Call at segment boundaries when
   *  the caller iterates segments. */
  reset(): void;
};

export function makeAuctionMaskGap(
  axis: Pick<VirtualAxis, 'inClosingAuctionWindow' | 'toVirtual'>,
  enabled: boolean,
): AuctionMaskGap {
  if (!enabled) {
    return {
      breakBefore: () => null,
      isHidden: () => false,
      reset: () => {},
    };
  }

  let wasInAuction = false;

  return {
    breakBefore(t: number): WhitespaceData<Time> | null {
      const inside = axis.inClosingAuctionWindow(t);
      if (inside && !wasInAuction) {
        wasInAuction = true;
        // 1ms before the first in-auction virtual time, in seconds —
        // matches the day-boundary whitespace convention in fillStrength.ts.
        const breakTime = (axis.toVirtual(t) - 1) / 1000;
        return { time: breakTime as Time };
      }
      if (!inside) wasInAuction = false;
      return null;
    },
    isHidden(t: number): boolean {
      return axis.inClosingAuctionWindow(t);
    },
    reset(): void {
      wasInAuction = false;
    },
  };
}

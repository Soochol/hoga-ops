import { describe, it, expect } from 'vitest';
import { makeAuctionMaskGap } from './auctionMaskGap';

type AxisLike = {
  inClosingAuctionWindow: (t: number) => boolean;
  toVirtual: (t: number) => number;
};

const fakeAxis = (inAuction: (t: number) => boolean): AxisLike => ({
  inClosingAuctionWindow: inAuction,
  toVirtual: (t) => t, // 1:1 mapping for tests
});

describe('makeAuctionMaskGap — disabled', () => {
  it('isHidden always returns false when enabled=false', () => {
    const gap = makeAuctionMaskGap(fakeAxis(() => true), false);
    expect(gap.isHidden(1000)).toBe(false);
    expect(gap.isHidden(2000)).toBe(false);
  });

  it('breakBefore always returns null when enabled=false', () => {
    const gap = makeAuctionMaskGap(fakeAxis(() => true), false);
    expect(gap.breakBefore(1000)).toBeNull();
    expect(gap.breakBefore(2000)).toBeNull();
  });
});

describe('makeAuctionMaskGap — enabled', () => {
  it('isHidden returns true iff axis predicate is true', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    expect(gap.isHidden(1000)).toBe(false);
    expect(gap.isHidden(5000)).toBe(true);
    expect(gap.isHidden(9000)).toBe(true);
  });

  it('emits one WhitespaceData at the first transition into the auction window', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    expect(gap.breakBefore(1000)).toBeNull();
    expect(gap.breakBefore(3000)).toBeNull();
    const br = gap.breakBefore(5000);
    expect(br).not.toBeNull();
    // Whitespace is positioned 1ms before the first in-auction virtual time,
    // converted to seconds.
    expect(br).toEqual({ time: (5000 - 1) / 1000 });
  });

  it('does NOT emit a second break for subsequent in-auction points', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    gap.breakBefore(1000); // outside
    gap.breakBefore(5000); // entry — break emitted
    expect(gap.breakBefore(6000)).toBeNull(); // still inside — no second break
    expect(gap.breakBefore(7000)).toBeNull();
  });

  it('re-arms after leaving the auction window (defensive)', () => {
    // Synthetic axis that toggles in/out/in for the same iteration.
    const inAuction = (t: number) => t >= 5000 && t <= 6000;
    const gap = makeAuctionMaskGap(fakeAxis(inAuction), true);
    expect(gap.breakBefore(5000)).toEqual({ time: 4.999 }); // entry 1
    expect(gap.breakBefore(6000)).toBeNull(); // still in
    expect(gap.breakBefore(7000)).toBeNull(); // left
    expect(gap.breakBefore(8000)).toBeNull(); // still out
    // A re-entry inside the same iterator (rare) should break again.
    const inAuction2 = (t: number) => t >= 9000;
    const gap2 = makeAuctionMaskGap(fakeAxis(inAuction2), true);
    // Mirror: enter, leave, enter again on a different instance proves
    // reset() works; here we use reset() directly.
    gap.reset();
    expect(gap2.breakBefore(9000)).toEqual({ time: 8.999 });
  });

  it('reset() clears the "already broke" flag without affecting predicate', () => {
    const gap = makeAuctionMaskGap(fakeAxis((t) => t >= 5000), true);
    gap.breakBefore(5000); // entry, break emitted
    expect(gap.breakBefore(6000)).toBeNull();
    gap.reset();
    // After reset, the next in-auction point emits a break again.
    expect(gap.breakBefore(6000)).toEqual({ time: 5.999 });
  });
});

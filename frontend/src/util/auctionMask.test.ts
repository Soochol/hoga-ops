import { describe, it, expect, vi } from 'vitest';
import { isAuctionMaskActive } from './auctionMask';

type AxisLike = { inClosingAuctionWindow: (t: number) => boolean };

describe('isAuctionMaskActive — behavior', () => {
  it('returns false when toggle is off, and does not call axis predicate', () => {
    const spy = vi.fn(() => true);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(false, axis, 1_700_000_000_000)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns false when toggle is on but axis predicate returns false', () => {
    const spy = vi.fn(() => false);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(true, axis, 1_700_000_000_000)).toBe(false);
    expect(spy).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('returns true when toggle is on and axis predicate returns true', () => {
    const spy = vi.fn(() => true);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(true, axis, 1_700_000_000_000)).toBe(true);
    expect(spy).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('short-circuits before axis throws when toggle is off', () => {
    const axis: AxisLike = {
      inClosingAuctionWindow: () => {
        throw new Error('should not be called');
      },
    };
    expect(() => isAuctionMaskActive(false, axis, 0)).not.toThrow();
    expect(isAuctionMaskActive(false, axis, 0)).toBe(false);
  });

  it('forwards t === 0 (and other boundary values) to the axis verbatim', () => {
    const spy = vi.fn((t: number) => t === 0);
    const axis: AxisLike = { inClosingAuctionWindow: spy };
    expect(isAuctionMaskActive(true, axis, 0)).toBe(true);
    expect(spy).toHaveBeenCalledWith(0);
  });
});

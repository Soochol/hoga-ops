import { describe, it, expect } from 'vitest';
import { isAuctionMaskActive } from './auctionMask';

describe('isAuctionMaskActive — scaffold', () => {
  it('exports as a function', () => {
    expect(typeof isAuctionMaskActive).toBe('function');
  });
});

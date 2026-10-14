import { describe, expect, it } from 'vitest';
import { priceTickPcts } from './volumePriceAxis';

describe('priceTickPcts', () => {
  it('keeps the three price ticks when there is room', () => {
    expect(priceTickPcts(240, 10.5, 25)).toEqual([0, 50, 100]);
  });
  it('reserves the POC label in a short graph', () => {
    expect(priceTickPcts(20, 10.5, 5)).toEqual([]);
    expect(priceTickPcts(80, 10.5, 5)).toEqual([50, 100]);
  });
  it('accounts for larger text without keeping overlapping labels', () => {
    expect(priceTickPcts(40, 21, 5)).toEqual([]);
    expect(priceTickPcts(80, 10.5, null)).toEqual([0, 50, 100]);
  });
});

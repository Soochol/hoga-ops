// frontend/src/chart/drawing/simplify.test.ts
import { describe, expect, it } from 'vitest';
import { rdpKeptIndices, simplifyByPixels, type Px } from './simplify';

describe('rdpKeptIndices', () => {
  it('keeps only the endpoints of a straight line', () => {
    const pts: Px[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 0 },
    ];
    expect(rdpKeptIndices(pts, 1.5)).toEqual([0, 3]);
  });

  it('keeps a corner point that exceeds epsilon', () => {
    const pts: Px[] = [
      { x: 0, y: 0 },
      { x: 5, y: 10 }, // 10px off the 0→(10,0) chord → kept
      { x: 10, y: 0 },
    ];
    expect(rdpKeptIndices(pts, 1.5)).toEqual([0, 1, 2]);
  });

  it('drops a point within epsilon of the chord', () => {
    const pts: Px[] = [
      { x: 0, y: 0 },
      { x: 5, y: 1 }, // 1px off → within 1.5 → dropped
      { x: 10, y: 0 },
    ];
    expect(rdpKeptIndices(pts, 1.5)).toEqual([0, 2]);
  });

  it('returns all indices for <= 2 points', () => {
    expect(rdpKeptIndices([{ x: 0, y: 0 }], 1.5)).toEqual([0]);
    expect(rdpKeptIndices([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1.5)).toEqual([0, 1]);
  });
});

describe('simplifyByPixels', () => {
  it('returns the original data items at surviving indices', () => {
    const data = [
      { realMs: 0, price: 100 },
      { realMs: 1, price: 100 },
      { realMs: 2, price: 100 },
      { realMs: 3, price: 100 },
    ];
    // Project realMs→x, price→y (all colinear) → only endpoints survive.
    const out = simplifyByPixels(data, (p) => ({ x: p.realMs * 5, y: p.price }), 1.5);
    expect(out).toEqual([data[0], data[3]]);
  });

  it('keeps items that fail to project (never silently dropped)', () => {
    const data = [
      { realMs: 0, price: 100 },
      { realMs: 1, price: 100 },
      { realMs: 2, price: 100 },
      { realMs: 3, price: 100 },
    ];
    const out = simplifyByPixels(
      data,
      (p) => (p.realMs === 1 ? null : { x: p.realMs * 5, y: p.price }),
      1.5,
    );
    expect(out).toContain(data[1]); // unprojectable but retained
  });

  it('leaves short strokes untouched', () => {
    const data = [{ realMs: 0, price: 1 }, { realMs: 1, price: 2 }];
    expect(simplifyByPixels(data, (p) => ({ x: p.realMs, y: p.price }), 1.5)).toEqual(data);
  });
});

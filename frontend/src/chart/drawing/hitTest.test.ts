// frontend/src/chart/drawing/hitTest.test.ts
import { describe, expect, it } from 'vitest';
import { distanceToHline, distanceToSegment, distanceToPolyline } from './hitTest';

describe('distanceToHline', () => {
  it('returns vertical distance from the cursor Y to the line Y', () => {
    expect(distanceToHline({ x: 100, y: 50 }, 60)).toBe(10);
    expect(distanceToHline({ x: -999, y: 200 }, 200)).toBe(0);
  });
});

describe('distanceToSegment', () => {
  it('returns 0 when the point lies on the segment', () => {
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('returns perpendicular distance for a point above a horizontal segment', () => {
    expect(distanceToSegment({ x: 5, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(4);
  });

  it('returns distance to nearest endpoint when projection falls outside', () => {
    expect(distanceToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('handles degenerate segments (a == b) as point distance', () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('distanceToPolyline', () => {
  it('returns the minimum distance across all consecutive segments', () => {
    const polyline = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(distanceToPolyline({ x: 5, y: 3 }, polyline)).toBe(3);
    expect(distanceToPolyline({ x: 13, y: 5 }, polyline)).toBe(3);
  });

  it('returns Infinity for polylines with fewer than 2 points', () => {
    expect(distanceToPolyline({ x: 0, y: 0 }, [])).toBe(Infinity);
    expect(distanceToPolyline({ x: 0, y: 0 }, [{ x: 1, y: 1 }])).toBe(Infinity);
  });
});

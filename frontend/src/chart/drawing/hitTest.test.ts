// frontend/src/chart/drawing/hitTest.test.ts
import { describe, expect, it } from 'vitest';
import {
  distanceToHline,
  distanceToSegment,
  distanceToPolyline,
  hitTestDrawings,
  type HitCoord,
} from './hitTest';
import type { Drawing } from './types';

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

/** SR-5: hitTestDrawings is the kind-dispatch interaction core lifted out of
 * DrawingOverlay so it can be tested with stub coordinate closures instead of
 * a live IChartApi. These cases pin pane-match gating, per-kind threshold
 * compares, and topmost-first ordering. */
describe('hitTestDrawings', () => {
  // Identity-ish stub coords: x == realMs, y == price; everything is on
  // 'candle'. Lets each case place geometry in plain pixel space.
  const coord: HitCoord = {
    realMsToCanvasX: (realMs) => realMs,
    priceToCanvasY: (price) => price,
    paneIdAtY: () => 'candle',
  };

  const hline = (id: string, price: number): Drawing => ({
    id, kind: 'hline', price, paneId: 'candle',
    color: '#fff', width: 2, lineStyle: 'solid',
  });

  it('hits an hline within the hline threshold (6px) and misses beyond it', () => {
    const d = hline('h1', 100);
    expect(hitTestDrawings(coord, [d], 50, 104)).toBe(d); // 4px away → hit
    expect(hitTestDrawings(coord, [d], 50, 110)).toBeNull(); // 10px away → miss
  });

  it('returns null when the cursor pane does not match the drawing pane', () => {
    const d = hline('h1', 100);
    const otherPane: HitCoord = { ...coord, paneIdAtY: () => 'volume' };
    expect(hitTestDrawings(otherPane, [d], 50, 100)).toBeNull();
  });

  it('hits a trendline body within trendlineBody threshold (8px)', () => {
    const t: Drawing = {
      id: 't1', kind: 'trendline', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 0 },
    };
    expect(hitTestDrawings(coord, [t], 50, 5)).toBe(t); // 5px above the segment
    expect(hitTestDrawings(coord, [t], 50, 20)).toBeNull(); // 20px → miss
  });

  it('hits a pencil polyline within pencil threshold (8px)', () => {
    const p: Drawing = {
      id: 'p1', kind: 'pencil', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
      points: [
        { realMs: 0, price: 0 },
        { realMs: 100, price: 0 },
        { realMs: 100, price: 100 },
      ],
    };
    expect(hitTestDrawings(coord, [p], 50, 3)).toBe(p);
    expect(hitTestDrawings(coord, [p], 50, 30)).toBeNull();
  });

  it('returns the topmost (last-drawn) drawing when two overlap', () => {
    const bottom = hline('bottom', 100);
    const top = hline('top', 100);
    // Array order = z-order; iteration is back-to-front so the LAST element wins.
    expect(hitTestDrawings(coord, [bottom, top], 50, 100)).toBe(top);
  });

  it('returns null for an empty drawing list', () => {
    expect(hitTestDrawings(coord, [], 50, 100)).toBeNull();
  });

  it('skips a drawing whose projected coordinates are null (off-axis)', () => {
    const offAxis: HitCoord = { ...coord, priceToCanvasY: () => null };
    expect(hitTestDrawings(offAxis, [hline('h1', 100)], 50, 100)).toBeNull();
  });
});

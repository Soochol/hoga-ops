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

  it('hits a vline by horizontal proximity regardless of cursor pane', () => {
    const v: Drawing = {
      id: 'v1', kind: 'vline', realMs: 100, paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid',
    };
    // Cursor in a DIFFERENT pane (volume) still grabs the vline (pane-agnostic).
    const otherPane: HitCoord = { ...coord, paneIdAtY: () => 'volume' };
    expect(hitTestDrawings(otherPane, [v], 104, 999)).toBe(v); // 4px away → hit
    expect(hitTestDrawings(otherPane, [v], 110, 999)).toBeNull(); // 10px → miss
  });

  it('hits a rect on its border AND its interior (solid box, grab-to-move)', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
    };
    const c: HitCoord = { ...coord, canvasWidth: 800 };
    expect(hitTestDrawings(c, [r], 3, 50)).toBe(r); // near left edge → hit
    expect(hitTestDrawings(c, [r], 50, 3)).toBe(r); // near top edge → hit
    expect(hitTestDrawings(c, [r], 50, 50)).toBe(r); // dead centre → hit (fill)
    expect(hitTestDrawings(c, [r], 200, 50)).toBeNull(); // outside the box → miss
  });

  it('boxInterior:false keeps the border but drops the fill (drawing-mode grab test)', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.2,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
    };
    const c: HitCoord = { ...coord, canvasWidth: 800 };
    const outline = { boxInterior: false };
    // 윤곽은 그대로 잡힌다 — 방금 그린 사각형을 테두리로 옮기는 길은 남는다.
    expect(hitTestDrawings(c, [r], 3, 50, outline)).toBe(r);
    expect(hitTestDrawings(c, [r], 50, 3, outline)).toBe(r);
    // 안쪽은 놓친다 — 그 자리는 다음 도형을 그릴 자리다(기본값에서는 잡힌다, 위 테스트).
    expect(hitTestDrawings(c, [r], 50, 50, outline)).toBeNull();
    expect(hitTestDrawings(c, [r], 200, 50, outline)).toBeNull();
  });

  it('boxInterior:false does not touch non-box kinds', () => {
    // 게이트가 좁히는 것은 채워진 박스뿐이다 — 선·자유곡선의 밴드는 그대로여야
    // 연필/추세선의 이동 경로가 살아 있다.
    const h = hline('h1', 100);
    expect(hitTestDrawings(coord, [h], 50, 103, { boxInterior: false })).toBe(h);
  });

  it('rect with a corner off-axis falls back to the canvas edge and stays selectable', () => {
    const r: Drawing = {
      id: 'r1', kind: 'rect', paneId: 'candle',
      color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0,
      a: { realMs: 0, price: 0 }, b: { realMs: 100, price: 100 },
    };
    // b.realMs projects off-axis → x falls back to canvasWidth (800).
    const c: HitCoord = {
      ...coord,
      canvasWidth: 800,
      realMsToCanvasX: (realMs) => (realMs === 100 ? null : realMs),
    };
    expect(hitTestDrawings(c, [r], 3, 50)).toBe(r); // left edge still resolves
  });

  it('hits a text label within its measured bounding box', () => {
    const t: Drawing = {
      id: 't1', kind: 'text', at: { realMs: 100, price: 100 },
      text: '메모', fontSize: 13, paneId: 'candle',
      color: '#fff', width: 1, lineStyle: 'solid',
    };
    // Stub measureTextWidth → 40px box; anchor at (100,100), height ≈ 13+4.
    const c: HitCoord = { ...coord, measureTextWidth: () => 40 };
    expect(hitTestDrawings(c, [t], 110, 105)).toBe(t); // inside the box
    expect(hitTestDrawings(c, [t], 200, 105)).toBeNull(); // right of the box
    expect(hitTestDrawings(c, [t], 110, 130)).toBeNull(); // below the box
  });

  it('keeps an off-axis text grabbable via the clamped projector (dragged into a gap)', () => {
    const t: Drawing = {
      id: 't1', kind: 'text', at: { realMs: 50_000, price: 100 },
      text: '메모', fontSize: 13, paneId: 'candle',
      color: '#fff', width: 1, lineStyle: 'solid',
    };
    // Plain projector returns null for this gap anchor (would vanish +
    // un-selectable); the clamped projector snaps it to x=120 so it stays
    // grabbable there — exactly how renderText paints it.
    const c: HitCoord = {
      ...coord,
      measureTextWidth: () => 40,
      realMsToCanvasX: (realMs) => (realMs === 50_000 ? null : realMs),
      realMsToCanvasXClamped: (realMs) => (realMs === 50_000 ? 120 : realMs),
    };
    // Without the clamp the text is unreachable:
    const noClamp: HitCoord = { ...c, realMsToCanvasXClamped: undefined };
    expect(hitTestDrawings(noClamp, [t], 130, 105)).toBeNull();
    // With the clamp, the box sits at x∈[117,163] → (130,105) hits.
    expect(hitTestDrawings(c, [t], 130, 105)).toBe(t);
  });

  it('returns null for an empty drawing list', () => {
    expect(hitTestDrawings(coord, [], 50, 100)).toBeNull();
  });

  it('skips a drawing whose projected coordinates are null (off-axis)', () => {
    const offAxis: HitCoord = { ...coord, priceToCanvasY: () => null };
    expect(hitTestDrawings(offAxis, [hline('h1', 100)], 50, 100)).toBeNull();
  });
});

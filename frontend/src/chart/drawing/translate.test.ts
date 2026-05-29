// frontend/src/chart/drawing/translate.test.ts

import { describe, expect, it } from 'vitest';
import type { Drawing, Hline, Pencil, Trendline } from './types';
import { clampDPriceForDrawing, pricesOf, translateDrawing } from './translate';

const baseStyle = { color: '#14B8A6', width: 1.5, lineStyle: 'solid' as const };

describe('translateDrawing — hline', () => {
  it('shifts price by dPrice and ignores dMs (hline has no time coordinate)', () => {
    const h: Hline = { id: 'h1', kind: 'hline', price: 100, ...baseStyle, paneId: 'candle' };
    expect(translateDrawing(h, 999, 5)).toEqual({ price: 105 });
    expect(translateDrawing(h, -1_000_000, -10)).toEqual({ price: 90 });
  });
});

describe('translateDrawing — trendline', () => {
  it('shifts both endpoints by (dMs, dPrice)', () => {
    const t: Trendline = {
      id: 't1',
      kind: 'trendline',
      a: { realMs: 1_000, price: 100 },
      b: { realMs: 2_000, price: 200 },
      ...baseStyle,
      paneId: 'candle',
    };
    expect(translateDrawing(t, 500, 5)).toEqual({
      a: { realMs: 1_500, price: 105 },
      b: { realMs: 2_500, price: 205 },
    });
  });
});

describe('translateDrawing — pencil', () => {
  it('shifts every vertex by (dMs, dPrice)', () => {
    const p: Pencil = {
      id: 'p1',
      kind: 'pencil',
      points: [
        { realMs: 1_000, price: 100 },
        { realMs: 1_010, price: 105 },
        { realMs: 1_020, price: 110 },
      ],
      ...baseStyle,
      paneId: 'candle',
    };
    expect(translateDrawing(p, 50, 2)).toEqual({
      points: [
        { realMs: 1_050, price: 102 },
        { realMs: 1_060, price: 107 },
        { realMs: 1_070, price: 112 },
      ],
    });
  });

  it('handles an empty point list cleanly (no crash; returns empty points)', () => {
    const p: Pencil = { id: 'p1', kind: 'pencil', points: [], ...baseStyle, paneId: 'candle' };
    const result = translateDrawing(p, 100, 10) as Partial<Pencil>;
    expect(result.points).toEqual([]);
  });
});

describe('pricesOf', () => {
  it('returns [price] for hline', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 50, ...baseStyle, paneId: 'candle' };
    expect(pricesOf(h)).toEqual([50]);
  });
  it('returns [a.price, b.price] for trendline', () => {
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 10 }, b: { realMs: 0, price: 90 },
      ...baseStyle, paneId: 'candle',
    };
    expect(pricesOf(t)).toEqual([10, 90]);
  });
  it('returns every vertex price for pencil', () => {
    const p: Pencil = {
      id: 'p', kind: 'pencil',
      points: [{ realMs: 0, price: 5 }, { realMs: 1, price: 50 }, { realMs: 2, price: 7 }],
      ...baseStyle, paneId: 'candle',
    };
    expect(pricesOf(p)).toEqual([5, 50, 7]);
  });
});

describe('clampDPriceForDrawing', () => {
  const bounds = { top: 100, bottom: 0 }; // pane spans price ∈ [0, 100]

  it('passes a dPrice through unchanged when every vertex stays inside the pane', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 50, ...baseStyle, paneId: 'candle' };
    expect(clampDPriceForDrawing(h, 10, bounds)).toBe(10);
    expect(clampDPriceForDrawing(h, -10, bounds)).toBe(-10);
  });

  it('caps positive dPrice so no vertex exceeds pane top', () => {
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 90 }, b: { realMs: 0, price: 50 },
      ...baseStyle, paneId: 'candle',
    };
    // a is 10 below top; b is 50 below top. cap = min(10, 50) = 10.
    expect(clampDPriceForDrawing(t, 50, bounds)).toBe(10);
  });

  it('caps negative dPrice so no vertex falls below pane bottom', () => {
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 5 }, b: { realMs: 0, price: 90 },
      ...baseStyle, paneId: 'candle',
    };
    // Lowest vertex (a=5) can drop by 5 before hitting 0. cap = -5.
    expect(clampDPriceForDrawing(t, -50, bounds)).toBe(-5);
  });

  it('preserves trendline spread at the boundary (the shape-preservation invariant)', () => {
    // The whole point of this helper: a trendline whose lower endpoint
    // touches the floor still moves both endpoints together when the user
    // tries to drag down further (clamped to 0 dPrice), so the 80-unit
    // spread between the endpoints survives.
    const t: Trendline = {
      id: 't', kind: 'trendline',
      a: { realMs: 0, price: 10 }, b: { realMs: 0, price: 90 },
      ...baseStyle, paneId: 'candle',
    };
    const cappedDown = clampDPriceForDrawing(t, -100, bounds);
    const translated = translateDrawing(t, 0, cappedDown) as Partial<Trendline>;
    const newA = translated.a!.price;
    const newB = translated.b!.price;
    // Both endpoints shift by the same capped amount; spread of 80 preserved.
    expect(newB - newA).toBe(80);
    // Lower endpoint pinned to the floor.
    expect(newA).toBe(0);
  });

  it('tolerates inverted bounds', () => {
    const h: Hline = { id: 'h', kind: 'hline', price: 50, ...baseStyle, paneId: 'candle' };
    expect(clampDPriceForDrawing(h, 60, { top: 0, bottom: 100 })).toBe(50);
  });

  it('freezes the drag (returns 0) when a vertex is already outside the bounds', () => {
    // Autoscale shift moved the bounds while the user is mid-drag and a
    // vertex now sits above the new top. We don't yank the drawing.
    const h: Hline = { id: 'h', kind: 'hline', price: 200, ...baseStyle, paneId: 'candle' };
    expect(clampDPriceForDrawing(h, 5, bounds)).toBe(0);
  });
});

describe('translateDrawing — exhaustiveness', () => {
  it('returns Partial<Drawing> for every Drawing.kind', () => {
    // If a new kind is added to the Drawing union without extending
    // translateDrawing, this test still compiles but TypeScript flags the
    // missing case in the switch — see types.ts.
    const cases: Drawing[] = [
      { id: '1', kind: 'hline', price: 0, ...baseStyle, paneId: 'candle' },
      {
        id: '2',
        kind: 'trendline',
        a: { realMs: 0, price: 0 },
        b: { realMs: 0, price: 0 },
        ...baseStyle,
        paneId: 'candle',
      },
      { id: '3', kind: 'pencil', points: [], ...baseStyle, paneId: 'candle' },
    ];
    for (const d of cases) expect(translateDrawing(d, 1, 1)).toBeTypeOf('object');
  });
});

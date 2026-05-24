// frontend/src/chart/drawing/translate.test.ts

import { describe, expect, it } from 'vitest';
import type { Drawing, Hline, Pencil, Trendline } from './types';
import { translateDrawing } from './translate';

const baseStyle = { color: '#14B8A6', width: 1.5 };

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

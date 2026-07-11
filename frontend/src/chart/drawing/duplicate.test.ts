// frontend/src/chart/drawing/duplicate.test.ts
import { describe, expect, it } from 'vitest';
import { refCoords, cloneWithOffset } from './duplicate';
import type { Drawing } from './types';

const style = { color: '#14B8A6', width: 2, lineStyle: 'solid' as const, paneId: 'candle' as const };

describe('refCoords', () => {
  it('gives price-only for hline, time-only for vline', () => {
    expect(refCoords({ id: 'h', kind: 'hline', price: 100, ...style })).toEqual({
      realMs: null, price: 100,
    });
    expect(refCoords({ id: 'v', kind: 'vline', realMs: 5000, ...style })).toEqual({
      realMs: 5000, price: null,
    });
  });

  it('uses the first anchor for 2-point and pencil shapes', () => {
    const t: Drawing = {
      id: 't', kind: 'trendline',
      a: { realMs: 1000, price: 50 }, b: { realMs: 2000, price: 60 }, ...style,
    };
    expect(refCoords(t)).toEqual({ realMs: 1000, price: 50 });
  });
});

describe('cloneWithOffset', () => {
  it('produces a new id and translated geometry', () => {
    const h: Drawing = { id: 'h1', kind: 'hline', price: 100, ...style };
    const clone = cloneWithOffset(h, 999, 5);
    expect(clone.id).not.toBe('h1');
    expect(clone.kind).toBe('hline');
    if (clone.kind === 'hline') expect(clone.price).toBe(105); // dMs ignored by hline
  });

  it('shifts both endpoints of a trendline', () => {
    const t: Drawing = {
      id: 't1', kind: 'trendline',
      a: { realMs: 1000, price: 50 }, b: { realMs: 2000, price: 60 }, ...style,
    };
    const clone = cloneWithOffset(t, 100, 5);
    if (clone.kind === 'trendline') {
      expect(clone.a).toEqual({ realMs: 1100, price: 55 });
      expect(clone.b).toEqual({ realMs: 2100, price: 65 });
    }
    expect(clone.id).not.toBe('t1');
  });
});

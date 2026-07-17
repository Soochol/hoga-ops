// frontend/src/chart/drawing/duplicate.test.ts
import { describe, expect, it } from 'vitest';
import { refCoords, cloneWithOffset } from './duplicate';
import { dragTimeDomain } from './chartCoordinates';
import { createVirtualAxis } from '../../util/virtualAxis';
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

  it('keeps every vertex on-axis when the offset crosses a session boundary', () => {
    // Sessions A [0, 1_000_000] and B [10_000_000, 11_000_000] — the overlay
    // passes a virtual-domain shift function (mirroring duplicateSelectedRef):
    // ref vertex a sits 4 bars before A's close, so its +14px offset crosses
    // into session B. A flat real-ms delta (the old path) would have carried
    // the 9_000_000 gap into vertex b and stranded it off-axis.
    const axis = createVirtualAxis([
      { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
      { date: '20260102', sessionOpenMs: 10_000_000, sessionCloseMs: 11_000_000 },
    ]);
    const dom = dragTimeDomain(axis, { lastRealMs: 10_900_000, bucketMs: 60_000 });
    const rect: Drawing = {
      id: 'r1', kind: 'rect',
      // Wide rect late in session A: a (ref) on the last full bar (#16),
      // b much earlier (#8) — bar-grid values, like real pixel-derived anchors.
      a: { realMs: 960_000, price: 50 }, b: { realMs: 480_000, price: 60 },
      fillOpacity: 0.1, ...style,
    };
    // Ref vertex offset lands 1 bar into session B → Δvirtual = 101_000 (the
    // crossed gap's 1s rides along).
    const refShifted = 10_060_000;
    const dVirtual = dom.toVirtual(refShifted) - dom.toVirtual(rect.kind === 'rect' ? rect.a.realMs : 0);
    const clone = cloneWithOffset(rect, (ms) => dom.toReal(dom.toVirtual(ms) + dVirtual), 1);
    if (clone.kind === 'rect') {
      expect(clone.a.realMs).toBe(refShifted);
      // b stays inside session A, shifted by the same bar count as the ref
      // (+2 bars once the grid snap cancels the gap residue — un-snapped it
      // would sit at 581_000, off the bar grid, which timeToCoordinate can't
      // resolve; the flat real-ms path would have put it inside the gap).
      expect(clone.b.realMs).toBe(600_000);
      expect(axis.contains(clone.a.realMs)).toBe(true);
      expect(axis.contains(clone.b.realMs)).toBe(true);
      expect(clone.b.realMs % 60_000).toBe(0);
    }
  });
});

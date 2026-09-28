import { describe, expect, it } from 'vitest';
import { createVirtualAxis } from '../../util/virtualAxis';
import { dragBarDomain } from './chartCoordinates';
import { captureRectCorner, extendRectToTime, projectRectX, rectCornerAtBar, translateRectBars } from './rectCoordinates';
import type { Rect } from './types';

const box: Rect = {
  id: 'free', kind: 'rect', paneId: 'candle', color: '#fff', width: 2, lineStyle: 'solid', fillOpacity: 0.1,
  a: { realMs: 60_000, price: 100 }, b: { realMs: 120_000, price: 200 }, subX: { a: -0.2, b: 0.3 },
};
const domain = { toBar: (ms: number) => ms / 60_000, toReal: (bar: number) => Math.round(bar) * 60_000 };

describe('rectangle coordinates', () => {
  it('preserves arbitrary pointer X, scales with zoom and respects an explicit candle snap', () => {
    const corner = captureRectCorner(box.a, 96, () => 100, 20, false);
    expect(corner.subX).toBe(-0.2);
    expect(projectRectX(corner.realMs, corner.subX, () => 100, 20)).toBe(96);
    expect(projectRectX(corner.realMs, corner.subX, () => 200, 40)).toBe(192);
    const snapped = captureRectCorner(box.a, 96, () => 100, 20, true);
    expect(projectRectX(snapped.realMs, snapped.subX, () => 100, 20)).toBe(100);
  });

  it('does not double-correct an already continuous future-band coordinate', () => {
    const corner = captureRectCorner({ realMs: 144_000, price: 100 }, 48, ms => ms / 3_000, 20, false);
    expect(corner.subX ?? 0).toBe(0);
    expect(projectRectX(corner.realMs, corner.subX, ms => ms / 3_000, 20)).toBe(48);
  });

  it('falls back to the anchor without a pitch and preserves null projection', () => {
    expect(projectRectX(60_000, 0.4, () => 20, undefined)).toBe(20);
    expect(projectRectX(60_000, 0.4, () => null, 20)).toBeNull();
  });

  it('moves a fraction of a bar while preserving width, including a return trip', () => {
    const moved = { ...box, ...translateRectBars(box, 0.15, 10, domain) };
    expect(projectRectX(moved.a.realMs, moved.subX?.a, ms => ms / 3_000, 20)).toBeCloseTo(19);
    expect(projectRectX(moved.b.realMs, moved.subX?.b, ms => ms / 3_000, 20)).toBeCloseTo(49);
    const restored = translateRectBars(moved, -0.15, -10, domain);
    expect(restored.a).toEqual(box.a);
    expect(restored.b).toEqual(box.b);
    expect(restored.subX?.a).toBeCloseTo(-0.2);
    expect(restored.subX?.b).toBeCloseTo(0.3);
  });

  it('extends the correct crossed corner inside one candle and clears only its residual', () => {
    const crossed = { ...box, b: { ...box.b, realMs: box.a.realMs }, subX: { a: 0.4, b: -0.3 } };
    expect(extendRectToTime(crossed, 180_000, domain)).toEqual({
      a: { realMs: 180_000, price: 100 }, subX: { a: 0, b: -0.3 },
    });
  });

  it('carries fractional positions across a session boundary with missing loaded candles', () => {
    const axis = createVirtualAxis([
      { date: '20260527', sessionOpenMs: 0, sessionCloseMs: 120_000 },
      { date: '20260528', sessionOpenMs: 86_400_000, sessionCloseMs: 86_520_000 },
    ]);
    const bars = dragBarDomain(axis, { lastRealMs: 86_520_000, bucketMs: 60_000 },
      [0, 120_000, 86_400_000, 86_520_000].map(ts_ms => ({ ts_ms })));
    const corner = rectCornerAtBar(1.8, 100, bars);
    expect(corner.realMs).toBe(86_400_000);
    expect(corner.subX).toBeCloseTo(-0.2);
    expect(bars.toBar(corner.realMs) + (corner.subX ?? 0)).toBeCloseTo(1.8);
  });

  it.each([86_400_000, 7 * 86_400_000, 30 * 86_400_000])('preserves a sub-bar calendar position with bucket %s', bucketMs => {
    const start = Date.UTC(2026, 4, 25);
    const end = start + bucketMs;
    const axis = createVirtualAxis([
      { date: '20260525', sessionOpenMs: start, sessionCloseMs: start },
      { date: '20260526', sessionOpenMs: end, sessionCloseMs: end },
    ], start, { mode: 'calendar' });
    const bars = dragBarDomain(axis, { lastRealMs: end, bucketMs }, [{ ts_ms: start }, { ts_ms: end }]);
    const corner = rectCornerAtBar(0.7, 100, bars);
    expect(corner.realMs).toBe(end);
    expect(corner.subX).toBeCloseTo(-0.3);
  });
});

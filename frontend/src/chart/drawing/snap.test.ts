// frontend/src/chart/drawing/snap.test.ts
import { describe, expect, it } from 'vitest';
import {
  nearestCandleIndex,
  snapRealMs,
  snapPoint,
  constrainAngle,
  type SnapCandle,
} from './snap';

const candles: SnapCandle[] = [
  { ts_ms: 1000, open: 100, high: 110, low: 95, close: 105 },
  { ts_ms: 2000, open: 105, high: 120, low: 100, close: 118 },
  { ts_ms: 3000, open: 118, high: 125, low: 112, close: 115 },
];

describe('nearestCandleIndex', () => {
  it('finds the nearest candle by timestamp', () => {
    expect(nearestCandleIndex(candles, 900)).toBe(0);
    expect(nearestCandleIndex(candles, 1400)).toBe(0); // closer to 1000
    expect(nearestCandleIndex(candles, 1600)).toBe(1); // closer to 2000
    expect(nearestCandleIndex(candles, 5000)).toBe(2); // past the end → last
  });
  it('returns -1 for an empty array', () => {
    expect(nearestCandleIndex([], 1000)).toBe(-1);
  });
});

describe('snapRealMs', () => {
  it('snaps to the nearest candle timestamp', () => {
    expect(snapRealMs(candles, 1600)).toBe(2000);
    expect(snapRealMs(candles, 1100)).toBe(1000);
  });
  it('is a no-op for empty candles', () => {
    expect(snapRealMs([], 1234)).toBe(1234);
  });
});

describe('snapPoint', () => {
  // Identity priceToY (price == pixel) so thresholds are in price units here.
  const priceToY = (p: number) => p;

  it('snaps price to the nearest OHLC within threshold on the candle pane', () => {
    // raw price 103 near candle[1] (nearest to realMs 1950); OHLC = 105/120/100/118.
    const out = snapPoint(
      { realMs: 1950, price: 103 },
      { candles, paneId: 'candle', priceToY, pxThreshold: 10 },
    );
    expect(out.realMs).toBe(2000); // X snapped
    expect(out.price).toBe(105); // nearest OHLC (open) within 10px
  });

  it('leaves price unchanged when no OHLC is within threshold', () => {
    const out = snapPoint(
      { realMs: 1000, price: 50 }, // far from any OHLC of candle[0]
      { candles, paneId: 'candle', priceToY, pxThreshold: 10 },
    );
    expect(out.realMs).toBe(1000);
    expect(out.price).toBe(50); // unchanged
  });

  it('snaps X only on non-candle panes', () => {
    const out = snapPoint(
      { realMs: 1950, price: 999 },
      { candles, paneId: 'volume', priceToY, pxThreshold: 10 },
    );
    expect(out.realMs).toBe(2000);
    expect(out.price).toBe(999);
  });
});

describe('constrainAngle', () => {
  it('snaps a near-horizontal drag to horizontal', () => {
    const out = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 8 });
    expect(out.y).toBeCloseTo(0, 5);
    expect(out.x).toBeGreaterThan(90);
  });
  it('snaps a near-45° drag to exactly 45°', () => {
    const out = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(Math.abs(out.x)).toBeCloseTo(Math.abs(out.y), 5);
  });
  it('snaps a near-vertical drag to vertical', () => {
    const out = constrainAngle({ x: 0, y: 0 }, { x: 6, y: 100 });
    expect(out.x).toBeCloseTo(0, 5);
  });
});

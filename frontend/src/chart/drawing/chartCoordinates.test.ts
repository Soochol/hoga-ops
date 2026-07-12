// frontend/src/chart/drawing/chartCoordinates.test.ts
//
// Focused tests for the empty-band (future) extrapolation added so drawings can
// be created/rendered in the whitespace right of the last candle. Uses a fake
// timeScale where in-data pixels map linearly and the empty band (past the last
// bar) returns null from coordinateToTime — mirroring lightweight-charts.

import { describe, expect, it } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { realMsToCanvasX, realMsToCanvasXClamped, canvasXToRealMs, type FutureBand } from './chartCoordinates';

// Virtual axis stub: identity in this test (virtual ms == real ms), one session
// spanning [0, LAST]. contains() true only within the session.
const LAST_REAL = 1_000_000; // last candle realMs
const BUCKET = 1_000; // 1s bars
const axis = {
  contains: (realMs: number) => realMs >= 0 && realMs <= LAST_REAL,
  toVirtual: (realMs: number) => realMs,
  toReal: (virtualMs: number) => virtualMs,
} as unknown as Parameters<typeof realMsToCanvasX>[1];

// Fake chart: 100px per bar. Bar index = realMs / BUCKET. Data spans logical
// [0, 1000] → x in [0, 100000] (10px/bar here for smaller numbers).
const PX_PER_BAR = 10;
const LAST_X = (LAST_REAL / BUCKET) * PX_PER_BAR; // = 10000
const chart = {
  timeScale: () => ({
    // In-data: time resolves for x within [0, LAST_X]; null outside (both the
    // left pre-data whitespace and the right empty band), like real lwc.
    coordinateToTime: (x: number) =>
      x >= 0 && x <= LAST_X ? (x / PX_PER_BAR) * BUCKET / 1000 : null,
    timeToCoordinate: (timeSec: number) => (timeSec * 1000 / BUCKET) * PX_PER_BAR,
    coordinateToLogical: (x: number) => x / PX_PER_BAR,
    logicalToCoordinate: (logical: number) => logical * PX_PER_BAR,
  }),
} as unknown as IChartApi;

const future: FutureBand = { lastRealMs: LAST_REAL, bucketMs: BUCKET };

describe('empty-band extrapolation', () => {
  it('canvasXToRealMs returns null in the empty band without a future ref', () => {
    // x past LAST_X (10000) → coordinateToTime null → no future → null.
    expect(canvasXToRealMs(chart, axis, 10500)).toBeNull();
  });

  it('canvasXToRealMs extrapolates realMs in the empty band with a future ref', () => {
    // x=10500 is 5 bars past the last (500px past 10000 @ 10px/bar → +50 bars? )
    // logical(10500)=1050, lastLogical(10000)=1000 → 50 bars ahead → +50*BUCKET.
    const rm = canvasXToRealMs(chart, axis, 10500, future);
    expect(rm).toBe(LAST_REAL + 50 * BUCKET);
  });

  it('canvasXToRealMs still uses the in-data path when time resolves', () => {
    expect(canvasXToRealMs(chart, axis, 5000, future)).toBe(500_000); // in-data, exact
  });

  it('realMsToCanvasX extrapolates X for a future realMs past the last candle', () => {
    const futureRealMs = LAST_REAL + 30 * BUCKET;
    const x = realMsToCanvasX(chart, axis, futureRealMs, future);
    // 30 bars past last → lastLogical 1000 + 30 → x = 1030 * 10 = 10300
    expect(x).toBe(10300);
  });

  it('realMsToCanvasX returns null for a future realMs without a future ref', () => {
    expect(realMsToCanvasX(chart, axis, LAST_REAL + 5 * BUCKET)).toBeNull();
  });

  it('does not extrapolate into the LEFT whitespace (before data)', () => {
    // A negative-ish x maps to logical < lastLogical → guarded out (null).
    expect(canvasXToRealMs(chart, axis, -50, future)).toBeNull();
  });
});

describe('realMsToCanvasXClamped (off-axis text anchor)', () => {
  // Two-session axis with a real gap (seg A [0,1000], seg B [100000,101000]).
  // Virtual time compresses the gap: seg B's real 100000 maps to virtual 2000.
  const segA = { sessionOpenMs: 0, sessionCloseMs: 1_000, virtualStart: 0 };
  const segB = { sessionOpenMs: 100_000, sessionCloseMs: 101_000, virtualStart: 2_000 };
  const gapAxis = {
    segments: [segA, segB],
    contains: (rm: number) =>
      (rm >= segA.sessionOpenMs && rm <= segA.sessionCloseMs) ||
      (rm >= segB.sessionOpenMs && rm <= segB.sessionCloseMs),
    toVirtual: (rm: number) =>
      rm <= segA.sessionCloseMs ? rm : rm - segB.sessionOpenMs + segB.virtualStart,
    toReal: (vm: number) => vm,
    // segment containing rm, or the prior segment when rm is in a gap; -1 pre-axis.
    findByReal: (rm: number) =>
      rm < segA.sessionOpenMs ? -1 : rm <= segB.sessionCloseMs && rm >= segB.sessionOpenMs ? 1 : 0,
  } as unknown as Parameters<typeof realMsToCanvasXClamped>[1];

  // Linear virtual-ms → x: x = virtualMs / BUCKET * PX_PER_BAR.
  const gapChart = {
    timeScale: () => ({
      coordinateToTime: (x: number) => (x >= 0 && x <= 30 ? (x / PX_PER_BAR) * BUCKET / 1000 : null),
      timeToCoordinate: (timeSec: number) => (timeSec * 1000 / BUCKET) * PX_PER_BAR,
      coordinateToLogical: (x: number) => x / PX_PER_BAR,
      logicalToCoordinate: (logical: number) => logical * PX_PER_BAR,
    }),
  } as unknown as IChartApi;

  it('plain realMsToCanvasX returns null in the inter-session gap (the vanish)', () => {
    // 50000 sits in the gap between seg A close and seg B open → off every
    // segment, not past the last candle → null → the text would disappear.
    expect(realMsToCanvasX(gapChart, gapAxis, 50_000)).toBeNull();
  });

  it('clamps a gap realMs to the nearer session boundary and projects it', () => {
    // dist to segA.close (1000) = 49000 < dist to segB.open (100000) = 50000
    // → snap to segA.close=1000 → virtual 1000 → x = 1000/1000*10 = 10.
    expect(realMsToCanvasXClamped(gapChart, gapAxis, 50_000)).toBe(10);
  });

  it('snaps to the NEXT session open when the gap realMs is nearer to it', () => {
    // 99000: dist to segA.close = 98000, dist to segB.open = 1000 → segB.open
    // → virtual 2000 → x = 2000/1000*10 = 20.
    expect(realMsToCanvasXClamped(gapChart, gapAxis, 99_000)).toBe(20);
  });

  it('clamps a pre-axis realMs to the first session open (left edge)', () => {
    expect(realMsToCanvasX(gapChart, gapAxis, -5_000)).toBeNull();
    expect(realMsToCanvasXClamped(gapChart, gapAxis, -5_000)).toBe(0); // segA.open → x=0
  });

  it('clamps a realMs past the final close to the last session close', () => {
    // 200000 past segB.close, no future ref → snap to segB.close=101000 →
    // virtual 3000 → x = 3000/1000*10 = 30.
    expect(realMsToCanvasXClamped(gapChart, gapAxis, 200_000)).toBe(30);
  });

  it('passes an on-axis realMs straight through (no clamping)', () => {
    // 500 is inside seg A → direct projection, virtual 500 → x = 5.
    expect(realMsToCanvasXClamped(gapChart, gapAxis, 500)).toBe(5);
  });
});

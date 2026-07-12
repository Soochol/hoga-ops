// frontend/src/chart/drawing/chartCoordinates.test.ts
//
// Focused tests for the empty-band (future) extrapolation added so drawings can
// be created/rendered in the whitespace right of the last candle. Uses a fake
// timeScale where in-data pixels map linearly and the empty band (past the last
// bar) returns null from coordinateToTime — mirroring lightweight-charts.

import { describe, expect, it } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { createVirtualAxis } from '../../util/virtualAxis';
import {
  realMsToCanvasX,
  realMsToCanvasXClamped,
  canvasXToRealMs,
  dragTimeDomain,
  type FutureBand,
} from './chartCoordinates';

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

// Body-drag translation domain: shifting a vertex by Δvirtual must always land
// it back on-axis (or in the linearized future band), unlike the old flat
// Δ-real-ms which stranded vertices inside inter-session gaps whenever the
// cursor crossed a day boundary (rect/measure stretched to the canvas edge or
// vanished — the drag "왔다갔다" bug).
describe('dragTimeDomain — intraday', () => {
  // Two real sessions with a big overnight gap: A [0, 1_000_000],
  // B [10_000_000, 11_000_000]. Virtual: A [0, 1_000_000], B starts at
  // 1_001_000 (gap collapses to INTER_SEGMENT_GAP_MS = 1000).
  const axis = createVirtualAxis([
    { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
    { date: '20260102', sessionOpenMs: 10_000_000, sessionCloseMs: 11_000_000 },
  ]);
  // Last candle mid session B, 1-minute bars.
  const future: FutureBand = { lastRealMs: 10_500_000, bucketMs: 60_000 };
  const dom = dragTimeDomain(axis, future);

  it('round-trips on-axis realMs exactly (identity when unshifted)', () => {
    for (const ms of [0, 500_000, 1_000_000, 10_000_000, 10_200_000]) {
      expect(dom.toReal(dom.toVirtual(ms))).toBe(ms);
    }
  });

  it('a gap-crossing shift lands the vertex ON-AXIS in the next session', () => {
    // Vertex late in session A, shifted right by 200_000 virtual ms — enough
    // to cross the compressed overnight gap into session B.
    const shifted = dom.toReal(dom.toVirtual(900_000) + 200_000);
    expect(axis.contains(shifted)).toBe(true);
    // virtual 1_100_000 → 99_000 into session B → real 10_099_000. The old
    // real-ms shift (900_000 + 200_000 = 1_100_000) landed in the gap instead.
    expect(shifted).toBe(10_099_000);
    expect(axis.contains(1_100_000)).toBe(false);
  });

  it('a leftward gap-crossing shift is exactly inverse (drag back restores)', () => {
    const there = dom.toVirtual(900_000) + 200_000;
    expect(dom.toReal(there - 200_000)).toBe(900_000);
  });

  it('heals a gap-stranded realMs (legacy real-ms drag leftover) to the next open', () => {
    // 5_000_000 sits in the overnight gap — the zero-shift round-trip snaps it
    // forward onto session B's open instead of leaving it invisible.
    expect(dom.toReal(dom.toVirtual(5_000_000))).toBe(10_000_000);
  });

  it('is seamless across the last-candle boundary (on-axis after the last bar)', () => {
    // 10_800_000 is beyond the last candle but still inside session B: the
    // on-axis toVirtual and the future-branch toReal must agree exactly.
    expect(dom.toReal(dom.toVirtual(10_800_000))).toBe(10_800_000);
  });

  it('round-trips future-band realMs past the session close (bar-linear extension)', () => {
    // 2 bars past session B's close: creation extrapolates such anchors; the
    // drag domain must keep them draggable rather than clamping onto the close.
    const bandMs = 11_120_000;
    expect(dom.toReal(dom.toVirtual(bandMs))).toBe(bandMs);
    // And shifting one bar right moves exactly one bucket in real time.
    expect(dom.toReal(dom.toVirtual(bandMs) + future.bucketMs)).toBe(bandMs + future.bucketMs);
  });

  it('exposes the axis origin for the shape-preserving left cap', () => {
    expect(dom.originV).toBe(0);
  });
});

describe('dragTimeDomain — calendar (D/W/M)', () => {
  // Three trading days; calendar mode gives each day one INTER_SEGMENT_GAP_MS
  // (1000) of virtual width regardless of session length.
  const axis = createVirtualAxis(
    [
      { date: '20260105', sessionOpenMs: 0, sessionCloseMs: 1_000 },
      { date: '20260106', sessionOpenMs: 100_000, sessionCloseMs: 101_000 },
      { date: '20260107', sessionOpenMs: 200_000, sessionCloseMs: 201_000 },
    ],
    0,
    { mode: 'calendar' },
  );
  const future: FutureBand = { lastRealMs: 200_000, bucketMs: 50_000 };
  const dom = dragTimeDomain(axis, future);

  it('shifts an anchor by whole segments onto the target day open', () => {
    // Day 1 anchor + 2 segment pitches (2 × 1000 virtual) → day 3 open, even
    // though the real-ms distance (200_000) is irregular across the days.
    expect(dom.toReal(dom.toVirtual(0) + 2_000)).toBe(200_000);
  });

  it('extends past the last bar at one bucketMs per segment pitch', () => {
    // One pitch past the last anchor → one bucket of real time ahead.
    const v = dom.toVirtual(200_000) + 1_000;
    expect(dom.toReal(v)).toBe(250_000);
    // And the forward map inverts it (round-trip through the band).
    expect(dom.toVirtual(250_000)).toBe(v);
  });
});

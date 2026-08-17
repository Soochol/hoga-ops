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
  dragBarDomain,
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

/**
 * `logicalToCoordinate` as lightweight-charts actually behaves: **whole logical
 * indices only**. A fractional argument yields `0` — not null, not an
 * interpolated coordinate (measured on lwc 5.2, 60m chart: 1155 → 312.7,
 * 1156 → 319.9, 1155.1 / 1155.25 / 1155.5 / 1155.75 → 0).
 *
 * This detail is load-bearing for the suite, not decoration. The stub used to
 * interpolate fractions linearly, which made it IMPOSSIBLE for any test here to
 * catch a caller passing a fraction — and one did: the future-band projection
 * pinned every off-grid vertex to x=0 on aggregated minute frames. Keep the
 * fraction→0 branch; without it the regression test below passes against the
 * broken implementation too.
 */
const stubLogicalToCoordinate = (logical: number) =>
  Number.isInteger(logical) ? logical * PX_PER_BAR : 0;
const LAST_X = (LAST_REAL / BUCKET) * PX_PER_BAR; // = 10000
const chart = {
  timeScale: () => ({
    // In-data: time resolves for x within [0, LAST_X]; null outside (both the
    // left pre-data whitespace and the right empty band), like real lwc.
    coordinateToTime: (x: number) =>
      x >= 0 && x <= LAST_X ? (x / PX_PER_BAR) * BUCKET / 1000 : null,
    timeToCoordinate: (timeSec: number) => (timeSec * 1000 / BUCKET) * PX_PER_BAR,
    coordinateToLogical: (x: number) => x / PX_PER_BAR,
    logicalToCoordinate: stubLogicalToCoordinate,
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

  it('extrapolates a FRACTIONAL bars-ahead instead of collapsing to the left edge', () => {
    // The aggregated-minute-frame case. `/live` fetches 1m and folds it
    // client-side, so a drawing anchored on the 1m grid lands BETWEEN two bars
    // of every larger frame — 0.4 bars past the last candle here. lwc resolves
    // only whole logicals (fraction → 0), so handing it `lastLogical + 0.4`
    // returned 0 and the vertex snapped to x=0: a trendline drawn minutes ago
    // stretched across the entire chart, differently on every minute frame.
    const x = realMsToCanvasX(chart, axis, LAST_REAL + 0.4 * BUCKET, future);
    expect(x).toBe(LAST_X + 0.4 * PX_PER_BAR); // 10004, not 0
  });

  it('keeps whole bars-ahead identical to the direct logical projection', () => {
    // Guards the fix's blast radius: the pixel-arithmetic path must reproduce
    // what lwc itself returns wherever lwc could answer at all.
    for (const bars of [1, 7, 30]) {
      expect(realMsToCanvasX(chart, axis, LAST_REAL + bars * BUCKET, future))
        .toBe(stubLogicalToCoordinate(LAST_X / PX_PER_BAR + bars));
    }
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
      logicalToCoordinate: stubLogicalToCoordinate,
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

// Body-drag translation domain: a horizontal drag delta must move every vertex
// by the same number of ON-SCREEN COLUMNS as the cursor, and must always land
// each vertex back on-axis (or in the linearized future band).
//
// Two failure modes are pinned here, both of which shipped:
//   - a flat Δ-real-ms stranded vertices inside inter-session gaps whenever the
//     cursor crossed a day boundary (rect/measure stretched to the canvas edge
//     or vanished — the drag "왔다갔다" bug);
//   - Δ-virtual-ms fixed that but is not uniform on screen (a day boundary is
//     INTER_SEGMENT_GAP_MS wide, a full column), so a vertex straddling one
//     moved two columns per one of the cursor's and the shape stretched by a
//     bar per boundary.
describe('dragBarDomain — intraday', () => {
  // Two real sessions with a big overnight gap: A [0, 1_000_000],
  // B [10_000_000, 11_000_000]. BUCKET divides each session evenly (as the
  // real 390-minute session divides by 1/3/5/10/15/30m), so every column —
  // including the closing one — sits on the grid. Ordinals: A 0..20, B 21..41.
  const axis = createVirtualAxis([
    { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
    { date: '20260102', sessionOpenMs: 10_000_000, sessionCloseMs: 11_000_000 },
  ]);
  const BUCKET = 50_000;
  // Last candle on B's 8th bar.
  const future: FutureBand = { lastRealMs: 10_400_000, bucketMs: BUCKET };
  const dom = dragBarDomain(axis, future);

  it('numbers the columns consecutively across the day boundary', () => {
    // The whole point of the domain: A's close and B's open are ADJACENT on
    // screen, so their ordinals differ by exactly 1 — even though they are
    // 2.5 hours apart in real time and INTER_SEGMENT_GAP_MS (1 000) apart in
    // virtual time, which is 1/50 of a bar and rounds away to nothing.
    expect(dom.toBar(950_000)).toBe(19);
    expect(dom.toBar(1_000_000)).toBe(20); // A's close
    expect(dom.toBar(10_000_000)).toBe(21); // B's open — the very next column
    expect(dom.toBar(10_050_000)).toBe(22);
    expect(dom.barSized).toBe(true);
  });

  it('costs one unit per column INSIDE a session and ACROSS the boundary alike', () => {
    // The regression this domain exists for: these two must be equal. In the
    // virtual-ms domain they were 50 000 and 1 000.
    const insideSession = dom.toBar(10_050_000) - dom.toBar(10_000_000);
    const acrossBoundary = dom.toBar(10_000_000) - dom.toBar(1_000_000);
    expect(insideSession).toBe(1);
    expect(acrossBoundary).toBe(1);
  });

  it('moves a boundary-straddling shape by the same columns as one that is not', () => {
    // THE bug, stated as an invariant. A trendline dragged 3 columns left, one
    // of whose vertices crosses the day boundary on the way: both move 3
    // columns, so the span survives. Under Δ-virtual-ms the crossing vertex
    // moved 4 and the shape stretched by exactly one bar per boundary
    // (measured on a real axis: trendline width 15 → 16, pencil span 18 → 19).
    const a = 10_000_000; // B's open
    const b = 10_150_000; // 3 columns to its right
    const movedA = dom.toReal(dom.toBar(a) - 3);
    const movedB = dom.toReal(dom.toBar(b) - 3);
    expect(dom.toBar(movedA)).toBe(18); // crossed into session A
    expect(dom.toBar(movedB)).toBe(21); // stayed in B
    expect(dom.toBar(movedB) - dom.toBar(movedA)).toBe(3); // span preserved
    expect(axis.contains(movedA)).toBe(true);
    expect(axis.contains(movedB)).toBe(true);
  });

  it('round-trips on-axis bar-grid realMs exactly (identity when unshifted)', () => {
    // Samples sit on the bar grid (session open + k·bucketMs) — the only times
    // creation can produce, since every vertex comes from coordinateToTime.
    for (const ms of [0, 500_000, 1_000_000, 10_000_000, 10_150_000]) {
      expect(dom.toReal(dom.toBar(ms))).toBe(ms);
    }
  });

  it('a boundary-crossing shift lands the vertex ON-AXIS and ON-GRID in the next session', () => {
    // Vertex on A's close, shifted right by 4 columns → B#3.
    const shifted = dom.toReal(dom.toBar(1_000_000) + 4);
    expect(axis.contains(shifted)).toBe(true);
    expect(shifted).toBe(10_150_000);
    expect((shifted - 10_000_000) % BUCKET).toBe(0);
  });

  it('a leftward boundary crossing is exactly inverse (drag back restores)', () => {
    const there = dom.toBar(1_000_000) + 4;
    expect(dom.toReal(there - 4)).toBe(1_000_000);
  });

  it('a leftward crossing walks onto the previous session grid', () => {
    // 2 columns into session B (#23), dragged 3 left: B#23 → B#22 → B#21 →
    // session A's closing column.
    expect(dom.toReal(dom.toBar(10_100_000) - 3)).toBe(1_000_000);
  });

  it('heals an off-grid on-axis realMs (persisted drag residue) on a zero-shift grab', () => {
    // 10_099_000 is contained (so the gap-heal never fires) but 1.98 bars into
    // session B — a leftover from a pre-ordinal boundary-crossing drag. The
    // round-trip rounds it onto the nearest column instead of preserving it,
    // which is what timeToCoordinate needs to resolve it at all.
    expect(dom.toReal(dom.toBar(10_099_000))).toBe(10_100_000);
  });

  it('heals a gap-stranded realMs (legacy real-ms drag leftover) to the next open', () => {
    // 5_000_000 sits in the overnight gap — the zero-shift round-trip snaps it
    // forward onto session B's open instead of leaving it invisible.
    expect(dom.toReal(dom.toBar(5_000_000))).toBe(10_000_000);
  });

  it('is seamless across the last-candle boundary (on-axis after the last bar)', () => {
    // 10_800_000 is beyond the last candle but still inside session B: the
    // on-axis toBar and the future-branch toReal must agree exactly, or the
    // branch would introduce a visible seam mid-session.
    expect(dom.toReal(dom.toBar(10_800_000))).toBe(10_800_000);
  });

  it('round-trips future-band realMs past the session close (bar-linear extension)', () => {
    // 2 bars past session B's close: creation extrapolates such anchors; the
    // drag domain must keep them draggable rather than clamping onto the close.
    const bandMs = 11_100_000;
    expect(axis.contains(bandMs)).toBe(false);
    expect(dom.toReal(dom.toBar(bandMs))).toBe(bandMs);
    // And shifting one column right moves exactly one bucket of real time.
    expect(dom.toReal(dom.toBar(bandMs) + 1)).toBe(bandMs + BUCKET);
  });

  it('exposes the axis origin for the shape-preserving left cap', () => {
    expect(dom.originBar).toBe(0);
  });

  it('degrades to virtual ms — and says so — when the bar pitch is unknown', () => {
    // No FutureBand ⇒ no bucketMs ⇒ columns cannot be counted on an intraday
    // axis. Drag still round-trips (the delta is measured and applied in the
    // same units either way), but a consumer reading the delta as a bar COUNT
    // must gate on barSized — hence the flag rather than a silent fallback.
    const noPitch = dragBarDomain(axis);
    expect(noPitch.barSized).toBe(false);
    expect(noPitch.toReal(noPitch.toBar(500_000))).toBe(500_000);
  });
});

describe('realMsToCanvasX — off-grid on-axis fallback (boundary-residue render)', () => {
  // Same two-session intraday axis as the dragBarDomain suite, but with a
  // STRICT timeToCoordinate that — like real lightweight-charts — resolves
  // only exact bar times present in the data. The original linear stub hid
  // this bug class entirely.
  const axis = createVirtualAxis([
    { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
    { date: '20260102', sessionOpenMs: 10_000_000, sessionCloseMs: 11_000_000 },
  ]);
  const BUCKET_1M = 60_000;
  const future: FutureBand = { lastRealMs: 10_500_000, bucketMs: BUCKET_1M };
  // Bars: every full bucket of each session, in virtual time.
  const barsV: number[] = [];
  for (const seg of axis.segments) {
    const len = seg.sessionCloseMs - seg.sessionOpenMs;
    for (let off = 0; off <= len; off += BUCKET_1M) {
      barsV.push(seg.virtualStart + off);
    }
  }
  const strictChart = {
    timeScale: () => ({
      timeToCoordinate: (timeSec: number) => {
        const i = barsV.indexOf(timeSec * 1000);
        return i < 0 ? null : i * PX_PER_BAR;
      },
      coordinateToTime: () => null,
      coordinateToLogical: (x: number) => x / PX_PER_BAR,
      logicalToCoordinate: stubLogicalToCoordinate,
    }),
  } as unknown as IChartApi;

  it('projects a bar-aligned realMs directly (control)', () => {
    // Session B bar #2 (10_120_000). Session A has 17 bars (0..960_000) —
    // plus its close-time bar 1_000_000? No: bars step by full buckets from
    // the open, so A contributes ceil-less floor(1_000_000/60_000)+1 = 17
    // entries (0..960_000) and one at 1_000_000 is NOT on the bucket ladder.
    const aBars = Math.floor(1_000_000 / BUCKET_1M) + 1; // 17
    const x = realMsToCanvasX(strictChart, axis, 10_120_000, future);
    expect(x).toBe((aBars + 2) * PX_PER_BAR);
  });

  it('resolves an off-grid on-axis realMs by snapping to the nearest bar', () => {
    // 10_099_000 = 1.65 bars into session B — a persisted boundary-crossing
    // drag residue. Direct lookup fails (not a bar time); the fallback snaps
    // to bar #2 instead of returning null (which the render layer would have
    // edge-pinned via `?? 0 / ?? width` — the stretched-trendline bug).
    const aBars = Math.floor(1_000_000 / BUCKET_1M) + 1;
    const x = realMsToCanvasX(strictChart, axis, 10_099_000, future);
    expect(x).toBe((aBars + 2) * PX_PER_BAR);
  });

  it('still returns null for an off-grid realMs without a future ref', () => {
    // No bucket → no grid to snap to; legacy behavior preserved.
    expect(realMsToCanvasX(strictChart, axis, 10_099_000)).toBeNull();
  });

  it('still returns null inside an inter-session gap (off-axis stays owned by callers)', () => {
    expect(realMsToCanvasX(strictChart, axis, 5_000_000, future)).toBeNull();
  });
});

describe('dragBarDomain — calendar (D/W/M)', () => {
  // Three trading days; calendar mode gives each day exactly one column
  // regardless of session length, so ordinals are just the day index.
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
  const dom = dragBarDomain(axis, future);

  it('numbers each trading day as one column', () => {
    expect(dom.toBar(0)).toBe(0);
    expect(dom.toBar(100_000)).toBe(1);
    expect(dom.toBar(200_000)).toBe(2);
    expect(dom.barSized).toBe(true);
  });

  it('shifts an anchor by whole days onto the target day open', () => {
    // Day 1 anchor + 2 columns → day 3 open, even though the real-ms
    // distance (200_000) is irregular across the days.
    expect(dom.toReal(dom.toBar(0) + 2)).toBe(200_000);
  });

  it('extends past the last bar at one bucketMs per column', () => {
    // One column past the last anchor → one bucket of real time ahead.
    const bar = dom.toBar(200_000) + 1;
    expect(dom.toReal(bar)).toBe(250_000);
    // And the forward map inverts it (round-trip through the band).
    expect(dom.toBar(250_000)).toBe(bar);
  });
});

describe('realMsToCanvasX — empty rung (a bucket with no trade, so no candle)', () => {
  // 위 STRICT 스위트와 같은 축이되, 사다리를 **빈틈없이 채우지 않는다**. 그 스위트는
  // 모든 버킷에 봉을 두어 "사다리 = 로드된 봉" 을 가정했고, 그래서 이 결함을 원리적으로
  // 재현할 수 없었다. 실제로는 체결 없는 버킷에 봉이 없다 — 005380 3분봉 실측으로
  // 사다리 9039칸 중 240칸(2.7%)이 비었고 **69/69 전 거래일**에 나타난다.
  const axis = createVirtualAxis([
    { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 600_000 },
  ]);
  const BUCKET_1M = 60_000;
  const future: FutureBand = { lastRealMs: 600_000, bucketMs: BUCKET_1M };
  // 개장 직후 두 칸(k=0,1)이 비어 있다 — 실측에서 본 모양 그대로(첫 버킷 무체결).
  const EMPTY_RUNGS = new Set([0, 1]);
  const barsV: number[] = [];
  for (let k = 0; k * BUCKET_1M <= 600_000; k++) {
    if (!EMPTY_RUNGS.has(k)) barsV.push(k * BUCKET_1M);
  }

  // lwc 를 있는 그대로: `timeToCoordinate` 는 조회(정확 매칭만),
  // `timeToIndex(t, true)` 는 **정수** 인덱스로 가장 가까운 봉을 준다.
  const chartWithGaps = {
    timeScale: () => ({
      timeToCoordinate: (timeSec: number) => {
        const i = barsV.indexOf(timeSec * 1000);
        return i < 0 ? null : i * PX_PER_BAR;
      },
      timeToIndex: (timeSec: number, findNearest?: boolean) => {
        const t = timeSec * 1000;
        const exact = barsV.indexOf(t);
        if (exact >= 0) return exact;
        if (!findNearest) return null;
        let best = 0;
        for (let i = 1; i < barsV.length; i++) {
          if (Math.abs(barsV[i] - t) < Math.abs(barsV[best] - t)) best = i;
        }
        return best;
      },
      coordinateToTime: () => null,
      coordinateToLogical: (x: number) => x / PX_PER_BAR,
      logicalToCoordinate: stubLogicalToCoordinate,
    }),
  } as unknown as IChartApi;

  it('로드된 칸은 그대로 해결한다 (대조군)', () => {
    // k=2 는 barsV 의 첫 원소 → 인덱스 0.
    expect(realMsToCanvasX(chartWithGaps, axis, 2 * BUCKET_1M, future)).toBe(0);
    expect(realMsToCanvasX(chartWithGaps, axis, 3 * BUCKET_1M, future)).toBe(PX_PER_BAR);
  });

  // 재현된 결함(2026-08-17): 정점이 빈 칸에 있으면 좌표가 null 이 되고, 호출부의
  // `?? 0 / ?? width` 가 그 정점을 캔버스 가장자리로 보내 도형이 화면을 가로질렀다.
  // 드래그가 빈 칸에 정점을 놓을 수 있는 이유는 `dragBarDomain.toReal` 이 순수 사다리
  // 계산이라 봉 존재를 안 보기 때문이다(아래 별도 단언).
  it('빈 칸 정점도 좌표를 얻는다 — 가장 가까운 로드된 봉', () => {
    const x = realMsToCanvasX(chartWithGaps, axis, 1 * BUCKET_1M, future);
    expect(x).not.toBeNull();
    // k=1 에서 가장 가까운 로드된 봉은 k=2(= barsV[0]) → x = 0.
    expect(x).toBe(0);
  });

  it('드래그 스냅은 빈 칸을 산출할 수 있다 (결함의 입구)', () => {
    const dom = dragBarDomain(axis, future);
    // 사다리 ordinal 1 → realMs 60_000. 그 칸에 봉이 없다.
    expect(dom.toReal(1)).toBe(1 * BUCKET_1M);
    expect(barsV).not.toContain(1 * BUCKET_1M);
  });

  // 폴백을 `coreRealMsToCanvasX` 안에 넣으면 이 단언이 깨진다 — 미래 밴드 시각이
  // "가장 가까운 봉" 으로 먼저 해석돼 외삽 분기가 죽고, 미래에 앵커된 도형이 전부
  // 마지막 봉에 붙는다. 폴백은 **마지막 단계**여야 한다.
  it('미래 밴드는 여전히 외삽으로 간다 (폴백 위치 가드)', () => {
    const lastIdx = barsV.length - 1;
    const twoAhead = realMsToCanvasX(chartWithGaps, axis, 600_000 + 2 * BUCKET_1M, future);
    expect(twoAhead).toBe((lastIdx + 2) * PX_PER_BAR);
    // 마지막 봉 자신보다 오른쪽이어야 한다(= 눌어붙지 않았다).
    expect(twoAhead as number).toBeGreaterThan(lastIdx * PX_PER_BAR);
  });
});

import { describe, it, expect } from 'vitest';
import { createVirtualAxis, type VirtualAxis } from './virtualAxis';
import { createKstHorzScaleBehavior } from './kstHorzScaleBehavior';

// KST 09:00 == UTC 00:00. Date.UTC(2026, 4, 27) => 2026-05-27 09:00 KST.
const SESSION_LEN = 6.5 * 3600 * 1000;
const open = (m: number, d: number) => Date.UTC(2026, m, d, 0, 0, 0);

// Four sessions: 5/27, 5/28, 5/29 (Fri), 6/1 (Mon — weekend skipped). The
// 5/29→6/1 step is the month boundary; 5/27→5/28 and 5/28→5/29 are day
// boundaries.
const RAW = [
  { date: '20260527', sessionOpenMs: open(4, 27), sessionCloseMs: open(4, 27) + SESSION_LEN },
  { date: '20260528', sessionOpenMs: open(4, 28), sessionCloseMs: open(4, 28) + SESSION_LEN },
  { date: '20260529', sessionOpenMs: open(4, 29), sessionCloseMs: open(4, 29) + SESSION_LEN },
  { date: '20260601', sessionOpenMs: open(5, 1), sessionCloseMs: open(5, 1) + SESSION_LEN },
];

// A point as lightweight-charts hands it to fillWeightsForPoints: only
// `originalTime` (the virtual seconds we fed as candle `time`) is read; we
// assert on the `timeWeight` the behavior writes back.
function point(axis: VirtualAxis, realMs: number) {
  return { originalTime: axis.toVirtual(realMs) / 1000, timeWeight: -1 };
}

// MutableRef shim — the factory only reads `.current`.
function ref<T>(value: T) {
  return { current: value };
}

describe('createKstHorzScaleBehavior — fillWeightsForPoints', () => {
  const axis = createVirtualAxis(RAW);
  const behavior = createKstHorzScaleBehavior(ref(axis));

  it('assigns Month weight (60) across a real KST month boundary', () => {
    const pts = [
      point(axis, open(4, 29)), // 5/29 09:00
      point(axis, open(5, 1)),  // 6/1 09:00  ← month changes
    ];
    behavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).toBe(60);
  });

  it('assigns Day weight (50) across a real KST day boundary', () => {
    const pts = [
      point(axis, open(4, 27)), // 5/27 09:00
      point(axis, open(4, 28)), // 5/28 09:00 ← day changes, same month
    ];
    behavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).toBe(50);
  });

  it('assigns Minute1 weight (20) within a session', () => {
    const pts = [
      point(axis, open(4, 27)),              // 5/27 09:00
      point(axis, open(4, 27) + 60_000),     // 5/27 09:01 ← 1-minute step
    ];
    behavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).toBe(20);
  });

  it('falls back to the base behavior when the axis is empty (loading)', () => {
    const emptyBehavior = createKstHorzScaleBehavior(ref(createVirtualAxis([])));
    const pts = [
      { originalTime: 0, timeWeight: -1 },
      { originalTime: 60, timeWeight: -1 },
    ];
    // Must not throw and must overwrite the sentinel via the base impl.
    emptyBehavior.fillWeightsForPoints(pts as never, 0);
    expect(pts[1].timeWeight).not.toBe(-1);
  });
});

describe('createKstHorzScaleBehavior — cacheKey axis generation', () => {
  // lwc's FormattedLabelsCache survives setData and keys label strings by
  // cacheKey(time). Two axis generations (prepend rebuilds) can place bars on
  // the SAME virtual time at different real dates, so the key must fold in an
  // axis generation: stable while the axis identity is stable, disjoint after
  // it swaps — even for identical time values.
  it('is stable for repeated calls under one axis, disjoint across axis swaps', () => {
    const axisRef = ref(createVirtualAxis(RAW));
    const behavior = createKstHorzScaleBehavior(axisRef);
    const item = behavior.convertHorzItemToInternal(12345 as never);

    const k1 = behavior.cacheKey(item);
    expect(behavior.cacheKey(item)).toBe(k1);

    // New generation — same CONTENT, new identity (what a prepend commit or
    // SSE-rebuilt axis looks like to the behavior).
    axisRef.current = createVirtualAxis(RAW);
    const k2 = behavior.cacheKey(item);
    expect(k2).not.toBe(k1);
    expect(behavior.cacheKey(item)).toBe(k2);
  });

  it('never collides across generations even for different times', () => {
    const axisRef = ref(createVirtualAxis(RAW));
    const behavior = createKstHorzScaleBehavior(axisRef);
    // Largest plausible real-anchored virtual second vs a small one: the
    // generation stride (2^41 ms) dominates any in-range time value, so a
    // gen-1 key of ANY time stays below a gen-2 key of any time.
    const big = behavior.cacheKey(behavior.convertHorzItemToInternal(2_000_000_000 as never));
    axisRef.current = createVirtualAxis(RAW);
    const small = behavior.cacheKey(behavior.convertHorzItemToInternal(0 as never));
    expect(small).toBeGreaterThan(big);
  });
});

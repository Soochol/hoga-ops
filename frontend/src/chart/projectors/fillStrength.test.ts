import { describe, it, expect } from 'vitest';
import { projectBuy, projectSell, projectCumulativeNetFill } from './fillStrength';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectBuy', () => {
  it('maps fill_strength.points to {time, buy_qty} in virtual seconds', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
          { t: sessionOpenMs + 1000, buy_qty: 40, sell_qty: 60 },
        ],
      },
    };
    expect(projectBuy(bundle, axis)).toEqual([
      { time: 0, value: 50 },
      { time: 1, value: 40 },
    ]);
  });

  it('drops pre-open points via axis.contains', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs - 30 * 60_000, buy_qty: 1, sell_qty: 1 },
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
        ],
      },
    };
    expect(projectBuy(bundle, axis)).toHaveLength(1);
    expect(projectBuy(bundle, axis)[0].value).toBe(50);
  });
});

describe('projectSell', () => {
  it('emits NEGATED sell_qty so the series mirrors below the 0 baseline', () => {
    const bundle: any = {
      fill_strength: {
        points: [
          { t: sessionOpenMs, buy_qty: 50, sell_qty: 30 },
          { t: sessionOpenMs + 1000, buy_qty: 40, sell_qty: 60 },
        ],
      },
    };
    expect(projectSell(bundle, axis)).toEqual([
      { time: 0, value: -30 },
      { time: 1, value: -60 },
    ]);
  });
});

const day1Open = 1_779_062_400_000;
const day2Open = day1Open + 24 * 3_600_000; // +1 day
const sessionDurationMs = 23_400_000; // 6h30m

describe('projectCumulativeNetFill — single-day', () => {
  const singleDayAxis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ]);

  it('runs the sum monotonically and emits per-bucket cumulative values', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },     // +70 → 70
          { t: day1Open + 1000, buy_qty: 20, sell_qty: 80 }, // -60 → 10
          { t: day1Open + 2000, buy_qty: 50, sell_qty: 50 }, //  0  → 10
        ],
      },
    };
    expect(projectCumulativeNetFill(bundle, singleDayAxis)).toEqual([
      { time: 0, value: 70 },
      { time: 1, value: 10 },
      { time: 2, value: 10 },
    ]);
  });

  it('returns [] for an empty fill_strength.points list', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: { points: [] },
    };
    expect(projectCumulativeNetFill(bundle, singleDayAxis)).toEqual([]);
  });

  it('excludes pre-open and after-session points from the running sum', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open - 60_000, buy_qty: 999, sell_qty: 0 },  // pre-open — must NOT contribute
          { t: day1Open, buy_qty: 100, sell_qty: 30 },          // +70 → 70
          { t: day1Open + sessionDurationMs + 60_000, buy_qty: 0, sell_qty: 500 }, // after — must NOT contribute
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis);
    // First in-session point lands exactly at session_open → zero anchor
    // suppressed (would collide with this point's timestamp), so only the
    // actual emit appears.
    expect(out).toHaveLength(1);
    const p0 = out[0] as { value: number };
    expect(p0.value).toBe(70); // pre-open's +999 must not show up
  });

  it('inserts a zero anchor at session_open when first in-viewport point lands later', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          // First fill 1 minute into the session — no opening-cross point.
          { t: day1Open + 60_000, buy_qty: 100, sell_qty: 30 }, // +70 → 70
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis);
    expect(out).toHaveLength(2);
    // Anchor: line visibly starts from 0 at session open.
    expect(out[0]).toEqual({ time: 0, value: 0 });
    // First actual point carries the bucket's net.
    expect(out[1]).toEqual({ time: 60, value: 70 });
  });
});

describe('projectCumulativeNetFill — multi-day', () => {
  it('resets per segment and inserts a line break between segments', () => {
    const axis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
      { date: '20260519', sessionOpenMs: day2Open, sessionCloseMs: day2Open + sessionDurationMs },
    ]);
    const bundle: any = {
      segments: [
        { date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs },
        { date: '20260519', session_open_ms: day2Open, session_close_ms: day2Open + sessionDurationMs },
      ],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },         // day1 open: +70 → 70
          { t: day1Open + 1000, buy_qty: 50, sell_qty: 200 },  // day1 +1s: -150 → -80
          { t: day2Open, buy_qty: 40, sell_qty: 10 },          // day2 open RESET: +30 → 30
          { t: day2Open + 1000, buy_qty: 100, sell_qty: 100 }, // day2 +1s: 0 → 30
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, axis);
    // 2 day1 points + 1 whitespace break + 2 day2 points = 5. Both segments'
    // first points coincide with session_open, so zero-anchor is suppressed
    // on each.
    expect(out).toHaveLength(5);

    // Day 1: actual emits, no anchor (first point at session_open).
    expect(out[0]).toMatchObject({ value: 70 });
    expect(out[1]).toMatchObject({ value: -80 });

    // Line break (whitespace point — `time` only, no `value`) sits between
    // the two segments so the renderer doesn't draw a diagonal from day1's
    // last value into day2's first value.
    const breakPoint = out[2];
    expect('value' in breakPoint).toBe(false);
    expect(typeof (breakPoint as { time: number }).time).toBe('number');

    // Day 2: running sum reset to 0, then first bucket's +30, then +0.
    expect(out[3]).toMatchObject({ value: 30 });
    expect(out[4]).toMatchObject({ value: 30 });
  });
});

describe('projectCumulativeNetFill — viewport invariant', () => {
  it('includes out-of-viewport points in the sum but does NOT emit them', () => {
    // Axis covers only the second half of day 1 (zoomed in).
    const halfDay = sessionDurationMs / 2;
    const zoomedAxis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open + halfDay, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    // The bundle's segments still describe the FULL day (the wire format never
    // narrows segments by viewport — only the axis does).
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },             // pre-viewport: +70 → 70
          { t: day1Open + halfDay - 1000, buy_qty: 50, sell_qty: 80 }, // pre-viewport: -30 → 40
          { t: day1Open + halfDay, buy_qty: 20, sell_qty: 10 },    // in-viewport: +10 → 50
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, zoomedAxis);
    // session_open is out of viewport, so the zero-anchor is suppressed —
    // the line correctly resumes from the running sum at the first
    // in-viewport point rather than visually re-zeroing at the edge.
    expect(out).toHaveLength(1);
    const p0 = out[0] as { value: number };
    // The running sum at the emitted point reflects the FULL pre-viewport
    // history (40 + 10 = 50), not a viewport-edge reset (would be 10).
    expect(p0.value).toBe(50);
  });
});

import { FILL_STRENGTH_SPEC } from './fillStrength';
import { LineSeries, HistogramSeries } from 'lightweight-charts';

describe('FILL_STRENGTH_SPEC shape', () => {
  it('has three series: two histograms then one cumulative line', () => {
    expect(FILL_STRENGTH_SPEC.series).toHaveLength(3);
    expect(FILL_STRENGTH_SPEC.series[0].type).toBe(HistogramSeries);
    expect(FILL_STRENGTH_SPEC.series[1].type).toBe(HistogramSeries);
    expect(FILL_STRENGTH_SPEC.series[2].type).toBe(LineSeries);
  });

  it('cumulative series uses invisible overlay scale (priceScaleId: "")', () => {
    const cum = FILL_STRENGTH_SPEC.series[2];
    expect(cum.options.priceScaleId).toBe('');
  });

  it('cumulative series projector returns [] when cumulativeEnabled is false', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [{ t: day1Open, buy_qty: 100, sell_qty: 30 }],
      },
    };
    const axis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    const cum = FILL_STRENGTH_SPEC.series[2];
    // ON → one point
    expect(cum.data(bundle, axis, { cumulativeEnabled: true })).toHaveLength(1);
    // OFF → []
    expect(cum.data(bundle, axis, { cumulativeEnabled: false })).toEqual([]);
  });
});

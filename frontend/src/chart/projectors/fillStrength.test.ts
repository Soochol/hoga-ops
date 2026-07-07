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
    expect(projectBuy(bundle, axis, false)).toEqual([
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
    expect(projectBuy(bundle, axis, false)).toHaveLength(1);
    expect((projectBuy(bundle, axis, false)[0] as { value: number }).value).toBe(50);
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
    expect(projectSell(bundle, axis, false)).toEqual([
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
  const singleDayCalendarAxis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ], day1Open, { mode: 'calendar' });

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
    expect(projectCumulativeNetFill(bundle, singleDayAxis, false)).toEqual([
      { time: 0, value: 70 },
      { time: 1, value: 10 },
      { time: 2, value: 10 },
    ]);
  });

  it('returns [] on calendar axes because cumulative fill is intraday-only', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },
          { t: day1Open + 1000, buy_qty: 20, sell_qty: 80 },
        ],
      },
    };
    expect(projectCumulativeNetFill(bundle, singleDayCalendarAxis, false)).toEqual([]);
  });

  it('returns [] for an empty fill_strength.points list', () => {
    const bundle: any = {
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: { points: [] },
    };
    expect(projectCumulativeNetFill(bundle, singleDayAxis, false)).toEqual([]);
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
    const out = projectCumulativeNetFill(bundle, singleDayAxis, false);
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
    const out = projectCumulativeNetFill(bundle, singleDayAxis, false);
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
    const out = projectCumulativeNetFill(bundle, axis, false);
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
    const out = projectCumulativeNetFill(bundle, zoomedAxis, false);
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
    expect(cum.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false })).toHaveLength(1);
    // OFF → []
    expect(cum.data(bundle, axis, { cumulativeEnabled: false, auctionWindowMask: false })).toEqual([]);
  });
});

describe('projectBuy/projectSell — closing-auction hide', () => {
  it('emits in-window buy/sell points as WhitespaceData when auctionWindowMask=true (Histogram skips bars for whitespace; time scale density preserved)', () => {
    const auctionStartMs = day1Open + 22_800_000; // 15:20 KST
    const bundle: any = {
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 50, sell_qty: 30 },                  // outside → kept
          { t: auctionStartMs + 60_000, buy_qty: 70, sell_qty: 70 },   // inside → whitespace
        ],
      },
    };
    const axisLocal = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    const inAuctionT = (auctionStartMs + 60_000 - day1Open) / 1000;
    expect(projectBuy(bundle, axisLocal, true)).toEqual([
      { time: 0, value: 50 },
      { time: inAuctionT },
    ]);
    expect(projectSell(bundle, axisLocal, true)).toEqual([
      { time: 0, value: -30 },
      { time: inAuctionT },
    ]);
  });

  it('keeps in-window buy/sell points when auctionWindowMask=false', () => {
    const auctionStartMs = day1Open + 22_800_000;
    const bundle: any = {
      fill_strength: {
        points: [{ t: auctionStartMs + 60_000, buy_qty: 70, sell_qty: 80 }],
      },
    };
    const axisLocal = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
    ]);
    expect(projectBuy(bundle, axisLocal, false)).toHaveLength(1);
    expect(projectSell(bundle, axisLocal, false)).toHaveLength(1);
  });
});

describe('projectCumulativeNetFill — closing-auction hide', () => {
  const singleDayAxis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ]);
  const auctionStartMs = day1Open + 22_800_000;

  it('drops the in-window point and suppresses anchors/color-patch in the last (only) segment', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },                  // +70 → 70 (kept)
          { t: auctionStartMs + 60_000, buy_qty: 0, sell_qty: 100 },    // inside → dropped (isAuctionHidden)
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis, true);

    // This is a single-segment bundle, so this segment is BOTH the only and
    // the LAST segment — both the retroactive color-patch and the future
    // auction-anchor synthesis are suppressed there (no next segment for a
    // diagonal to bleed into, and keeping them would force a per-tick
    // setData fallback on the live/today segment — see fillStrength.ts
    // projectCumulativeSegment). The in-window source point itself is still
    // dropped unconditionally (isAuctionHidden), leaving only the one
    // pre-auction emission, with its plain (unpatched) color.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ time: 0, value: 70 });
    expect((out[0] as { color?: string }).color).toBeUndefined();
  });

  it('keeps in-window cumulative emission and does NOT synthesize anchors when mask=false', () => {
    const bundle: any = {
      bucket_ms: 60_000,
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },               // 70
          { t: auctionStartMs + 60_000, buy_qty: 0, sell_qty: 100 }, // -30
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis, false);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ value: 70 });
    expect(out[1]).toMatchObject({ value: -30 });
  });

  it('does NOT patch the last pre-auction emission transparent when it is the LAST segment (no next segment to bleed into)', () => {
    // This bundle has a single segment, so it is the last segment: the
    // retroactive color-patch that hides the 15:19→15:20 outgoing connector
    // is suppressed (there's no next segment for a diagonal to visually
    // continue into, and keeping the patch active would force the live/today
    // segment onto the per-tick setData fallback — see fillStrength.ts
    // projectCumulativeSegment's isLastSegment gate). The point retains its
    // plain, unpatched color.
    const preAuctionMs = day1Open + 22_740_000; // 15:19
    const bundle: any = {
      bucket_ms: 60_000,
      segments: [
        { date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs },
      ],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 0 },        // +100 → 100
          { t: preAuctionMs, buy_qty: 0, sell_qty: 250 },    // -250 → -150 (last pre-auction)
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, singleDayAxis, true);

    // Find the last pre-auction value-bearing point (cumulative=-150 at 15:19).
    const preAuctionEntries = out.filter(
      (p) => 'value' in p && (p as { value: number }).value !== 0,
    ) as { time: number; value: number; color?: string }[];
    const last = preAuctionEntries.at(-1)!;
    expect(last.value).toBe(-150);
    expect(last.color).toBeUndefined();
  });

  it('runningSum continues to accumulate through hidden in-window points', () => {
    // Defensive invariant: even though FillStrength normally has no in-window
    // points (Auction Cross rows are filtered out backend-side), if any did
    // exist, the cumulative should treat them as data and only suppress
    // emission. We verify by extending session_close_ms past 15:30 and adding
    // a post-auction-window point; the cumulative value of that point must
    // reflect the in-auction delta.
    const extendedClose = day1Open + sessionDurationMs + 3_600_000; // +1h
    const extendedAxis = createVirtualAxis([
      { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: extendedClose },
    ]);
    const bundle: any = {
      bucket_ms: 60_000,
      segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: extendedClose }],
      fill_strength: {
        points: [
          { t: day1Open, buy_qty: 100, sell_qty: 30 },               // 70
          { t: auctionStartMs + 60_000, buy_qty: 0, sell_qty: 100 }, // hidden, but contributes -100
          { t: day1Open + sessionDurationMs + 60_000, buy_qty: 50, sell_qty: 0 }, // post-window: +50 → cum should be 20
        ],
      },
    };
    const out = projectCumulativeNetFill(bundle, extendedAxis, true);
    // The last value-bearing emission should carry the full accumulated
    // running sum. Synthesized anchors are all value=0 (and transparent),
    // and the last pre-auction emission has its color patched transparent
    // to hide its outgoing connector into the auction window — but its
    // VALUE is preserved. Filter by `value !== 0` to find the value-bearing
    // emissions regardless of color override.
    const valueBearing = out.filter(
      (p) => 'value' in p && (p as { value: number }).value !== 0,
    ) as { value: number }[];
    expect(valueBearing.at(-1)?.value).toBe(20); // 70 - 100 + 50 = 20
  });
});

describe('FILL_STRENGTH_SPEC — auctionWindowMask threading', () => {
  const axis = createVirtualAxis([
    { date: '20260518', sessionOpenMs: day1Open, sessionCloseMs: day1Open + sessionDurationMs },
  ]);
  const bundle: any = {
    bucket_ms: 60_000,
    segments: [{ date: '20260518', session_open_ms: day1Open, session_close_ms: day1Open + sessionDurationMs }],
    fill_strength: {
      points: [{ t: day1Open + 22_800_000 + 60_000, buy_qty: 99, sell_qty: 99 }], // in-auction
    },
  };

  it('buy histogram series data() emits whitespace for in-auction when ctx.auctionWindowMask=true', () => {
    const buy = FILL_STRENGTH_SPEC.series[0];
    const masked = buy.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: true });
    expect(masked).toHaveLength(1);
    expect((masked[0] as { value?: number }).value).toBeUndefined(); // whitespace
    // mask=false → 1 real bar
    const unmasked = buy.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false });
    expect(unmasked).toHaveLength(1);
    expect((unmasked[0] as { value: number }).value).toBe(99);
  });

  it('sell histogram series data() emits whitespace for in-auction when ctx.auctionWindowMask=true', () => {
    const sell = FILL_STRENGTH_SPEC.series[1];
    const masked = sell.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: true });
    expect(masked).toHaveLength(1);
    expect((masked[0] as { value?: number }).value).toBeUndefined();
    const unmasked = sell.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false });
    expect(unmasked).toHaveLength(1);
    expect((unmasked[0] as { value: number }).value).toBe(-99);
  });

  it('cumulative series data() honors ctx.auctionWindowMask in addition to ctx.cumulativeEnabled', () => {
    const cum = FILL_STRENGTH_SPEC.series[2];
    // cumulativeEnabled=false → always empty regardless of mask
    expect(cum.data(bundle, axis, { cumulativeEnabled: false, auctionWindowMask: true })).toEqual([]);
    expect(cum.data(bundle, axis, { cumulativeEnabled: false, auctionWindowMask: false })).toEqual([]);
    // mask=true → the single in-auction source point is dropped (isAuctionHidden,
    // unconditional). This bundle has a single segment, i.e. this is the LAST
    // segment, so no anchors are synthesized to fill the auction window (would
    // only matter for a diagonal bleeding into a NEXT segment, which doesn't
    // exist here — see fillStrength.ts projectCumulativeSegment's isLastSegment
    // gate). Net result: empty output.
    const masked = cum.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: true });
    expect(masked).toEqual([]);
    // mask=false → in-auction point is kept as real value. Zero-anchor is
    // suppressed because the first visible point lands inside the auction
    // window (a 6h flat-zero baseline before the only cumulative reading
    // would be misleading). 1 data point only.
    const unmasked = cum.data(bundle, axis, { cumulativeEnabled: true, auctionWindowMask: false });
    expect(unmasked).toHaveLength(1);
    expect((unmasked[0] as { value: number }).value).toBe(0); // 99 buy − 99 sell
  });
});

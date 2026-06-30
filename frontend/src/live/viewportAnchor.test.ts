import { describe, it, expect } from 'vitest';
import { createVirtualAxis } from '../util/virtualAxis';
import {
  viewportFromRanges,
  realMsToVirtualSeconds,
  computeRestoreRange,
  type TabViewport,
} from './viewportAnchor';

// Real-anchored single-session axis (origin = session open), so within the
// session toReal/toVirtual are identity in ms — keeps the expected math obvious.
const OPEN_MS = Date.UTC(2026, 4, 27, 0, 0, 0); // 09:00 KST
const CLOSE_MS = OPEN_MS + 6.5 * 3600 * 1000;
const axis = createVirtualAxis(
  [{ date: '20260527', sessionOpenMs: OPEN_MS, sessionCloseMs: CLOSE_MS }],
  OPEN_MS,
);
const emptyAxis = createVirtualAxis([]);

describe('viewportFromRanges', () => {
  it('builds a TabViewport from logical + visible ranges (mid-session, not live edge)', () => {
    const vrToSec = (OPEN_MS + 2 * 3600_000) / 1000; // 2h past open, virtual==real
    const vp = viewportFromRanges({ from: 100, to: 400 }, { to: vrToSec }, axis, OPEN_MS + 6 * 3600_000);
    expect(vp).not.toBeNull();
    expect(vp!.rightEdgeMs).toBe(OPEN_MS + 2 * 3600_000);
    expect(vp!.barSpan).toBe(300);
    expect(vp!.atLiveEdge).toBe(false); // right edge 4h before the last candle
  });

  it('captures right-offset whitespace as part of the tab viewport', () => {
    const lastMs = OPEN_MS + 2 * 3600_000;
    const rightOffset = 24;
    const vrToSec = (lastMs + rightOffset * 60_000) / 1000;
    const vp = viewportFromRanges(
      { from: 100, to: 400 + rightOffset },
      { to: vrToSec },
      axis,
      lastMs,
      rightOffset,
    );
    expect(vp).toMatchObject({
      rightEdgeMs: lastMs + rightOffset * 60_000,
      barSpan: 300 + rightOffset,
      rightOffset,
      atLiveEdge: true,
    });
  });

  it('flags atLiveEdge when the right edge is at/after the last candle (within 1s)', () => {
    const lastMs = OPEN_MS + 2 * 3600_000;
    const vrToSec = lastMs / 1000;
    const vp = viewportFromRanges({ from: 0, to: 305 }, { to: vrToSec }, axis, lastMs);
    expect(vp!.atLiveEdge).toBe(true);
  });

  it('atLiveEdge is false when lastCandleMs is null (no candles)', () => {
    const vp = viewportFromRanges({ from: 0, to: 300 }, { to: OPEN_MS / 1000 }, axis, null);
    expect(vp!.atLiveEdge).toBe(false);
  });

  it('returns null on a missing range read or empty axis', () => {
    expect(viewportFromRanges(null, { to: OPEN_MS / 1000 }, axis, null)).toBeNull();
    expect(viewportFromRanges({ from: 0, to: 300 }, null, axis, null)).toBeNull();
    expect(viewportFromRanges({ from: 0, to: 300 }, { to: OPEN_MS / 1000 }, emptyAxis, null)).toBeNull();
  });

  it('returns null on a non-positive bar span (degenerate / collapsed view)', () => {
    expect(viewportFromRanges({ from: 400, to: 400 }, { to: OPEN_MS / 1000 }, axis, null)).toBeNull();
    expect(viewportFromRanges({ from: 400, to: 100 }, { to: OPEN_MS / 1000 }, axis, null)).toBeNull();
  });
});

describe('realMsToVirtualSeconds', () => {
  it('rounds axis.toVirtual(realMs)/1000 to an integer second', () => {
    const realMs = OPEN_MS + 1234_567; // identity axis → virtual == real
    expect(realMsToVirtualSeconds(axis, realMs)).toBe(Math.round((OPEN_MS + 1234_567) / 1000));
  });
});

describe('computeRestoreRange', () => {
  const scrolledBack: TabViewport = { rightEdgeMs: OPEN_MS, barSpan: 120, atLiveEdge: false };
  const liveEdge: TabViewport = { rightEdgeMs: OPEN_MS, barSpan: 50, atLiveEdge: true };

  it('non-live-edge: pins the anchor index as the right edge, span as width', () => {
    expect(computeRestoreRange(scrolledBack, 5000, 1000)).toEqual({ from: 880, to: 1000, scrollToRight: false });
  });

  it('non-live-edge: clamps from to >= 0 so the lazy-fetch trigger cannot misfire', () => {
    const r = computeRestoreRange(scrolledBack, 5000, 50); // 50 - 120 < 0
    expect(r).toEqual({ from: 0, to: 50, scrollToRight: false });
    expect(r!.from).toBeGreaterThanOrEqual(0);
  });

  it('non-live-edge: null when the anchor index could not be resolved (anchor off-axis)', () => {
    expect(computeRestoreRange(scrolledBack, 5000, null)).toBeNull();
  });

  it('live-edge: preserves the saved zoom with right-offset whitespace, ignoring the index', () => {
    expect(computeRestoreRange(liveEdge, 200, null)).toEqual({ from: 150, to: 215, scrollToRight: false });
  });

  it('live-edge: restores the captured right-offset whitespace when present', () => {
    expect(computeRestoreRange({ ...liveEdge, rightOffset: 32 }, 200, 180)).toEqual({
      from: 163,
      to: 213,
      scrollToRight: false,
    });
  });

  it('live-edge with right-offset: falls back to candle count when latest index is unavailable', () => {
    expect(computeRestoreRange({ ...liveEdge, rightOffset: 32 }, 200, null)).toEqual({
      from: 182,
      to: 232,
      scrollToRight: false,
    });
  });

  it('user-adjusted live-edge: pins the explicit time anchor instead of the latest bar', () => {
    const adjustedLiveEdge: TabViewport = { ...liveEdge, userAdjusted: true };
    expect(computeRestoreRange(adjustedLiveEdge, 200, 120)).toEqual({ from: 70, to: 120, scrollToRight: false });
  });

  it('user-adjusted live-edge with right-offset: pins the explicit anchor and restores whitespace', () => {
    const adjustedLiveEdge: TabViewport = { ...liveEdge, barSpan: 74, rightOffset: 24, userAdjusted: true };
    expect(computeRestoreRange(adjustedLiveEdge, 200, 120)).toEqual({ from: 71, to: 145, scrollToRight: false });
  });

  it('live-edge: clamps from to >= 0 when fewer bars than the saved span', () => {
    expect(computeRestoreRange(liveEdge, 30, null)).toEqual({ from: 0, to: 45, scrollToRight: false });
  });

  it('rounds a fractional saved span', () => {
    const frac: TabViewport = { rightEdgeMs: OPEN_MS, barSpan: 119.6, atLiveEdge: false };
    expect(computeRestoreRange(frac, 5000, 1000)).toEqual({ from: 880, to: 1000, scrollToRight: false });
  });
});

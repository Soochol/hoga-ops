import { describe, expect, it } from 'vitest';
import { auctionTickPcts, sessionProgress } from './sessionProgress';

// 09:00 KST = 00:00 UTC on an arbitrary day; close = open + 6.5h.
const OPEN = Date.UTC(2026, 6, 8, 0, 0, 0);
const CLOSE = OPEN + 6.5 * 3600 * 1000;
const H = 3600 * 1000;

describe('sessionProgress', () => {
  it('pre-session → fill/head 0, phase pre', () => {
    expect(sessionProgress(OPEN - H, OPEN, CLOSE)).toEqual({ fillPct: 0, headPct: 0, phase: 'pre' });
  });

  it('post-session → fill/head 1, phase post', () => {
    expect(sessionProgress(CLOSE + H, OPEN, CLOSE)).toEqual({ fillPct: 1, headPct: 1, phase: 'post' });
  });

  it('mid-session → clamped fraction, phase in', () => {
    // 3.25h into a 6.5h session = exactly half.
    const p = sessionProgress(OPEN + 3.25 * H, OPEN, CLOSE);
    expect(p.phase).toBe('in');
    expect(p.fillPct).toBeCloseTo(0.5, 5);
    expect(p.headPct).toBe(p.fillPct);
  });

  it('exact boundaries count as in-session (inclusive)', () => {
    expect(sessionProgress(OPEN, OPEN, CLOSE)).toMatchObject({ phase: 'in', fillPct: 0 });
    expect(sessionProgress(CLOSE, OPEN, CLOSE)).toMatchObject({ phase: 'in', fillPct: 1 });
  });

  it('degenerate window (close ≤ open) → pre-session zero', () => {
    expect(sessionProgress(OPEN, OPEN, OPEN)).toEqual({ fillPct: 0, headPct: 0, phase: 'pre' });
  });
});

describe('auctionTickPcts', () => {
  it('places 09:10 and 15:20 ticks at 10min/6.5h from each edge', () => {
    const [openTick, closeTick] = auctionTickPcts(OPEN, CLOSE);
    expect(openTick).toBeCloseTo(10 / 390, 5); // 10min of 390
    expect(closeTick).toBeCloseTo(1 - 10 / 390, 5);
  });

  it('degenerate window → [0, 1]', () => {
    expect(auctionTickPcts(OPEN, OPEN)).toEqual([0, 1]);
  });
});

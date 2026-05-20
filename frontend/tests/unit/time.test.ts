import { describe, it, expect } from 'vitest';
import {
  buildSegments,
  realToVirtual,
  virtualToReal,
  findSegmentByVirtual,
  isDayBoundary,
  type Segment,
} from '../../src/util/time';

// KST 09:00 — 15:30 = 6h30m = 23_400_000 ms.
const SESSION_LEN_MS = 6.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 2026-05-18 09:00 KST (consistent with Task 1.1 reference constant).
const DAY1_OPEN = 1779062400000;
const DAY1_CLOSE = DAY1_OPEN + SESSION_LEN_MS;
const DAY2_OPEN = DAY1_OPEN + DAY_MS; // 2026-05-19 09:00 KST
const DAY2_CLOSE = DAY2_OPEN + SESSION_LEN_MS;
const DAY3_OPEN = DAY2_OPEN + DAY_MS; // 2026-05-20 09:00 KST
const DAY3_CLOSE = DAY3_OPEN + SESSION_LEN_MS;

const RAW_3 = [
  { date: '20260518', sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_CLOSE },
  { date: '20260519', sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_CLOSE },
  { date: '20260520', sessionOpenMs: DAY3_OPEN, sessionCloseMs: DAY3_CLOSE },
];

describe('buildSegments', () => {
  it('accumulates virtualStart across 3 days', () => {
    const segs = buildSegments(RAW_3);
    expect(segs).toHaveLength(3);
    expect(segs[0].virtualStart).toBe(0);
    expect(segs[1].virtualStart).toBe(SESSION_LEN_MS);
    expect(segs[2].virtualStart).toBe(2 * SESSION_LEN_MS);
    expect(segs[0].date).toBe('20260518');
    expect(segs[2].date).toBe('20260520');
  });

  it('returns [] for empty input', () => {
    expect(buildSegments([])).toEqual([]);
  });
});

describe('realToVirtual', () => {
  const segs = buildSegments(RAW_3);

  it('maps a point inside the first session', () => {
    const realMs = DAY1_OPEN + 60 * 60 * 1000; // 1 hour in
    expect(realToVirtual(segs, realMs)).toBe(60 * 60 * 1000);
  });

  it('maps a point inside the second session', () => {
    const realMs = DAY2_OPEN + 30 * 60 * 1000; // 30 min into day 2
    expect(realToVirtual(segs, realMs)).toBe(SESSION_LEN_MS + 30 * 60 * 1000);
  });

  it('exactly at sessionOpenMs returns virtualStart', () => {
    expect(realToVirtual(segs, DAY1_OPEN)).toBe(0);
    expect(realToVirtual(segs, DAY2_OPEN)).toBe(SESSION_LEN_MS);
    expect(realToVirtual(segs, DAY3_OPEN)).toBe(2 * SESSION_LEN_MS);
  });

  it('exactly at sessionCloseMs returns virtualStart + session length', () => {
    expect(realToVirtual(segs, DAY1_CLOSE)).toBe(SESSION_LEN_MS);
    expect(realToVirtual(segs, DAY2_CLOSE)).toBe(2 * SESSION_LEN_MS);
    expect(realToVirtual(segs, DAY3_CLOSE)).toBe(3 * SESSION_LEN_MS);
  });

  it('in the day-boundary gap snaps to next segment virtualStart', () => {
    // 18:00 KST on day 1 — between close and next open
    const mid = DAY1_CLOSE + 2 * 60 * 60 * 1000;
    expect(realToVirtual(segs, mid)).toBe(SESSION_LEN_MS);
    const mid2 = DAY2_CLOSE + 5 * 60 * 60 * 1000;
    expect(realToVirtual(segs, mid2)).toBe(2 * SESSION_LEN_MS);
  });

  it('before first open returns 0', () => {
    expect(realToVirtual(segs, DAY1_OPEN - 60_000)).toBe(0);
    expect(realToVirtual(segs, 0)).toBe(0);
  });

  it('after last close returns final virtual end', () => {
    expect(realToVirtual(segs, DAY3_CLOSE + 60 * 60 * 1000)).toBe(3 * SESSION_LEN_MS);
  });

  it('empty segments returns 0', () => {
    expect(realToVirtual([], 0)).toBe(0);
    expect(realToVirtual([], DAY1_OPEN)).toBe(0);
  });
});

describe('virtualToReal', () => {
  const segs = buildSegments(RAW_3);

  it('round-trips through realToVirtual inside a session', () => {
    // NB: sessionClose of day N shares its virtual offset with sessionOpen of
    // day N+1 (gaps are collapsed). For round-trip we use only opens + interior
    // points + the *final* close (no next-day open to collide with).
    const samples = [
      DAY1_OPEN,
      DAY1_OPEN + 1234567,
      DAY2_OPEN,
      DAY2_OPEN + 60_000,
      DAY3_OPEN + 7_000_000,
      DAY3_CLOSE,
    ];
    for (const realMs of samples) {
      const v = realToVirtual(segs, realMs);
      expect(virtualToReal(segs, v)).toBe(realMs);
    }
  });

  it('close-of-day-N and open-of-day-N+1 share a virtual offset (documented ambiguity)', () => {
    const vClose = realToVirtual(segs, DAY1_CLOSE);
    const vOpen = realToVirtual(segs, DAY2_OPEN);
    expect(vClose).toBe(vOpen);
    // virtualToReal resolves the tie to the *next* segment's open.
    expect(virtualToReal(segs, vClose)).toBe(DAY2_OPEN);
  });

  it('virtual exactly at next segment virtualStart maps to next.sessionOpenMs', () => {
    expect(virtualToReal(segs, SESSION_LEN_MS)).toBe(DAY2_OPEN);
    expect(virtualToReal(segs, 2 * SESSION_LEN_MS)).toBe(DAY3_OPEN);
  });

  it('virtual exactly at final virtual end snaps to last sessionCloseMs', () => {
    expect(virtualToReal(segs, 3 * SESSION_LEN_MS)).toBe(DAY3_CLOSE);
  });

  it('negative virtual clamps to first open', () => {
    expect(virtualToReal(segs, -1)).toBe(DAY1_OPEN);
    expect(virtualToReal(segs, -1_000_000)).toBe(DAY1_OPEN);
  });

  it('empty segments returns 0', () => {
    expect(virtualToReal([], 0)).toBe(0);
    expect(virtualToReal([], 1234)).toBe(0);
  });
});

describe('findSegmentByVirtual', () => {
  it('binary search across 12 segments', () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({
      date: `2026050${i}`,
      sessionOpenMs: DAY1_OPEN + i * DAY_MS,
      sessionCloseMs: DAY1_OPEN + i * DAY_MS + SESSION_LEN_MS,
    }));
    const segs = buildSegments(raw);
    expect(segs).toHaveLength(12);

    // Inside segment 0
    expect(findSegmentByVirtual(segs, 0)).toBe(0);
    expect(findSegmentByVirtual(segs, SESSION_LEN_MS - 1)).toBe(0);

    // Exactly on segment 1's start
    expect(findSegmentByVirtual(segs, SESSION_LEN_MS)).toBe(1);

    // Mid-range
    expect(findSegmentByVirtual(segs, 5 * SESSION_LEN_MS + 1000)).toBe(5);

    // Last segment
    expect(findSegmentByVirtual(segs, 11 * SESSION_LEN_MS)).toBe(11);
    expect(findSegmentByVirtual(segs, 11 * SESSION_LEN_MS + 1000)).toBe(11);

    // Before axis
    expect(findSegmentByVirtual(segs, -1)).toBe(-1);
  });

  it('returns -1 for empty segments', () => {
    expect(findSegmentByVirtual([], 0)).toBe(-1);
  });
});

describe('isDayBoundary', () => {
  const segs: Segment[] = buildSegments(RAW_3);

  it('is false inside a session', () => {
    expect(isDayBoundary(segs, DAY1_OPEN + 1000)).toBe(false);
    expect(isDayBoundary(segs, DAY2_OPEN + 60 * 60 * 1000)).toBe(false);
    expect(isDayBoundary(segs, DAY3_CLOSE - 1)).toBe(false);
  });

  it('is true in the gap between two sessions', () => {
    expect(isDayBoundary(segs, DAY1_CLOSE + 1)).toBe(true);
    expect(isDayBoundary(segs, DAY2_OPEN - 1)).toBe(true);
    expect(isDayBoundary(segs, DAY2_CLOSE + 5 * 60 * 60 * 1000)).toBe(true);
  });

  it('is true after the final close', () => {
    expect(isDayBoundary(segs, DAY3_CLOSE + 1)).toBe(true);
  });

  it('is false before the first open (pre-axis, not a gap)', () => {
    expect(isDayBoundary(segs, DAY1_OPEN - 1)).toBe(false);
  });

  it('is false for empty segments', () => {
    expect(isDayBoundary([], DAY1_OPEN)).toBe(false);
  });
});

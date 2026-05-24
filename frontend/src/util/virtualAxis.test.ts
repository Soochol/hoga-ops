import { describe, it, expect } from 'vitest';
import { createVirtualAxis } from './virtualAxis';

// KST 09:00 — 15:30 = 6h30m = 23_400_000 ms.
const SESSION_LEN_MS = 6.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Must mirror INTER_SEGMENT_GAP_MS in util/time.ts. The 1s synthetic gap
// keeps day N's 15:30 candle and day N+1's 09:00 candle on distinct virtual
// timestamps (otherwise lightweight-charts setData throws "asc ordered by
// time" on the N-1 boundary collisions for multi-day ranges).
const GAP_MS = 1000;
// Virtual step between consecutive segments' virtualStart values.
const SEG_STRIDE_MS = SESSION_LEN_MS + GAP_MS;

// 2026-05-18 09:00 KST.
const DAY1_OPEN = 1779062400000;
const DAY1_CLOSE = DAY1_OPEN + SESSION_LEN_MS;
const DAY2_OPEN = DAY1_OPEN + DAY_MS;
const DAY2_CLOSE = DAY2_OPEN + SESSION_LEN_MS;
const DAY3_OPEN = DAY2_OPEN + DAY_MS;
const DAY3_CLOSE = DAY3_OPEN + SESSION_LEN_MS;

const RAW_3 = [
  { date: '20260518', sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_CLOSE },
  { date: '20260519', sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_CLOSE },
  { date: '20260520', sessionOpenMs: DAY3_OPEN, sessionCloseMs: DAY3_CLOSE },
];

const RAW_SMALL = [
  { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
  { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
];

describe('createVirtualAxis — construction', () => {
  it('returns an axis with empty segments + empty dayBoundaries for empty input', () => {
    const axis = createVirtualAxis([]);
    expect(axis.segments).toHaveLength(0);
    expect(axis.dayBoundaries).toHaveLength(0);
  });

  it('returns N-1 dayBoundaries for N segments', () => {
    const axis1 = createVirtualAxis(RAW_3.slice(0, 1));
    expect(axis1.segments).toHaveLength(1);
    expect(axis1.dayBoundaries).toHaveLength(0);

    const axis3 = createVirtualAxis(RAW_3);
    expect(axis3.segments).toHaveLength(3);
    expect(axis3.dayBoundaries).toHaveLength(2);
  });

  it('axis.dayBoundaries[0] mirrors segments[1] date + virtualStart', () => {
    const axis = createVirtualAxis(RAW_3);
    expect(axis.dayBoundaries[0].date).toBe('20260519');
    expect(axis.dayBoundaries[0].virtualStart).toBe(axis.segments[1].virtualStart);
    expect(axis.dayBoundaries[1].date).toBe('20260520');
    expect(axis.dayBoundaries[1].virtualStart).toBe(axis.segments[2].virtualStart);
  });

  it('axis.segments and axis.dayBoundaries are frozen', () => {
    const axis = createVirtualAxis(RAW_3);
    expect(Object.isFrozen(axis)).toBe(true);
    expect(Object.isFrozen(axis.segments)).toBe(true);
    expect(Object.isFrozen(axis.dayBoundaries)).toBe(true);
    // Mutation attempts must throw in strict mode (vitest runs in strict).
    expect(() => {
      (axis.segments as unknown as { length: number }).length = 0;
    }).toThrow();
  });
});

describe('createVirtualAxis — toVirtual / toReal round-trip', () => {
  const axis = createVirtualAxis(RAW_3);

  it('round-trips inside any segment, including mid-axis session closes', () => {
    // With the 1s INTER_SEGMENT_GAP_MS, day N's sessionCloseMs no longer
    // shares a virtual offset with day N+1's sessionOpenMs, so mid-axis
    // closes round-trip too.
    const samples = [
      DAY1_OPEN,
      DAY1_OPEN + 1234567,
      DAY1_CLOSE,
      DAY2_OPEN,
      DAY2_OPEN + 60_000,
      DAY2_CLOSE,
      DAY3_OPEN + 7_000_000,
      DAY3_CLOSE,
    ];
    for (const realMs of samples) {
      expect(axis.toReal(axis.toVirtual(realMs))).toBe(realMs);
    }
  });

  it('exactly at a session open returns the segment virtualStart', () => {
    expect(axis.toVirtual(DAY1_OPEN)).toBe(0);
    expect(axis.toVirtual(DAY2_OPEN)).toBe(SEG_STRIDE_MS);
    expect(axis.toVirtual(DAY3_OPEN)).toBe(2 * SEG_STRIDE_MS);
  });

  it('day N close and day N+1 open are distinct on the virtual axis', () => {
    // Regression: without the synthetic gap these collided at SESSION_LEN_MS
    // and broke lightweight-charts setData on N>=2 ranges.
    expect(axis.toVirtual(DAY1_CLOSE)).toBe(SESSION_LEN_MS);
    expect(axis.toVirtual(DAY2_OPEN)).toBe(SESSION_LEN_MS + GAP_MS);
    expect(axis.toVirtual(DAY1_CLOSE)).not.toBe(axis.toVirtual(DAY2_OPEN));
  });

  it('gap times snap forward to next segment virtualStart', () => {
    const mid = DAY1_CLOSE + 2 * 60 * 60 * 1000;
    expect(axis.toVirtual(mid)).toBe(SEG_STRIDE_MS);
  });

  it('empty axis collapses to 0 in both directions', () => {
    const empty = createVirtualAxis([]);
    expect(empty.toVirtual(DAY1_OPEN)).toBe(0);
    expect(empty.toReal(1234)).toBe(0);
  });

  it('negative virtual clamps to first sessionOpenMs', () => {
    expect(axis.toReal(-1)).toBe(DAY1_OPEN);
  });
});

describe('createVirtualAxis — contains', () => {
  const axis = createVirtualAxis(RAW_3);

  it('false for empty axis', () => {
    expect(createVirtualAxis([]).contains(DAY1_OPEN)).toBe(false);
  });

  it('false for pre-axis realMs (before first open)', () => {
    expect(axis.contains(DAY1_OPEN - 60_000)).toBe(false);
  });

  it('true at open + interior + close boundaries', () => {
    expect(axis.contains(DAY1_OPEN)).toBe(true);
    expect(axis.contains(DAY1_OPEN + 60_000)).toBe(true);
    expect(axis.contains(DAY1_CLOSE)).toBe(true);
  });

  it('false in inter-session gaps', () => {
    expect(axis.contains(DAY1_CLOSE + 1)).toBe(false);
  });
});

describe('createVirtualAxis — isInGap', () => {
  const axis = createVirtualAxis(RAW_3);

  it('false inside any session', () => {
    expect(axis.isInGap(DAY1_OPEN + 1000)).toBe(false);
    expect(axis.isInGap(DAY2_OPEN + 60 * 60 * 1000)).toBe(false);
    expect(axis.isInGap(DAY3_CLOSE - 1)).toBe(false);
  });

  it('true in between-session gaps', () => {
    expect(axis.isInGap(DAY1_CLOSE + 1)).toBe(true);
    expect(axis.isInGap(DAY2_OPEN - 1)).toBe(true);
  });

  it('true after final close', () => {
    expect(axis.isInGap(DAY3_CLOSE + 1)).toBe(true);
  });

  it('false before first open (pre-axis, not a gap)', () => {
    expect(axis.isInGap(DAY1_OPEN - 1)).toBe(false);
  });

  it('false for empty axis', () => {
    expect(createVirtualAxis([]).isInGap(DAY1_OPEN)).toBe(false);
  });
});

describe('createVirtualAxis — inClosingAuctionWindow', () => {
  const axis = createVirtualAxis(RAW_3);
  // KST 15:20 = sessionOpenMs + 6h20m
  const AUCTION_OFFSET = (6 * 3600 + 20 * 60) * 1000;

  it('true for realMs in the auction band [open+6h20m, close]', () => {
    expect(axis.inClosingAuctionWindow(DAY1_OPEN + AUCTION_OFFSET)).toBe(true);
    expect(axis.inClosingAuctionWindow(DAY1_OPEN + AUCTION_OFFSET + 60_000)).toBe(true);
    expect(axis.inClosingAuctionWindow(DAY1_CLOSE)).toBe(true);
  });

  it('false for realMs before the auction band (in-session, continuous trading)', () => {
    expect(axis.inClosingAuctionWindow(DAY1_OPEN)).toBe(false);
    expect(axis.inClosingAuctionWindow(DAY1_OPEN + 60_000)).toBe(false);
    expect(axis.inClosingAuctionWindow(DAY1_OPEN + AUCTION_OFFSET - 1)).toBe(false);
  });

  it('false for pre-axis realMs (before first session open)', () => {
    expect(axis.inClosingAuctionWindow(DAY1_OPEN - 1)).toBe(false);
    expect(axis.inClosingAuctionWindow(DAY1_OPEN - 60 * 60 * 1000)).toBe(false);
  });

  it('false for realMs in an inter-session gap', () => {
    expect(axis.inClosingAuctionWindow(DAY1_CLOSE + 1)).toBe(false);
    expect(axis.inClosingAuctionWindow(DAY1_CLOSE + 60 * 60 * 1000)).toBe(false);
  });

  it('false for realMs after the final session close', () => {
    expect(axis.inClosingAuctionWindow(DAY3_CLOSE + 1)).toBe(false);
  });

  it('per-segment threshold — day 2 has its own auction band', () => {
    expect(axis.inClosingAuctionWindow(DAY2_OPEN + AUCTION_OFFSET)).toBe(true);
    expect(axis.inClosingAuctionWindow(DAY2_OPEN + AUCTION_OFFSET - 1)).toBe(false);
    expect(axis.inClosingAuctionWindow(DAY2_CLOSE)).toBe(true);
  });

  it('false for empty axis', () => {
    expect(createVirtualAxis([]).inClosingAuctionWindow(DAY1_OPEN + AUCTION_OFFSET)).toBe(false);
  });

  // KRX half-day sessions (year-end, lunar new year eve, etc.) close at
  // 12:30 KST — sessionLen = 3h30m. Anchoring the auction window to
  // sessionOpenMs + 6h20m would put the band PAST sessionCloseMs and the
  // predicate would never return true. The fix anchors to
  // sessionCloseMs - 10min so half-days work the same as full days.
  describe('half-day session (12:30 KST close)', () => {
    const HALF_DAY_LEN_MS = 3.5 * 60 * 60 * 1000;
    const HALF_OPEN = 1779062400000;          // 09:00 KST
    const HALF_CLOSE = HALF_OPEN + HALF_DAY_LEN_MS; // 12:30 KST
    const HALF_AUCTION_START = HALF_CLOSE - 10 * 60 * 1000; // 12:20 KST
    const axis = createVirtualAxis([
      { date: '20261231', sessionOpenMs: HALF_OPEN, sessionCloseMs: HALF_CLOSE },
    ]);

    it('true inside the last 10 minutes of a 12:30 KST close', () => {
      expect(axis.inClosingAuctionWindow(HALF_AUCTION_START)).toBe(true);
      expect(axis.inClosingAuctionWindow(HALF_AUCTION_START + 60_000)).toBe(true);
      expect(axis.inClosingAuctionWindow(HALF_CLOSE)).toBe(true);
    });

    it('false during continuous trading before the auction band', () => {
      expect(axis.inClosingAuctionWindow(HALF_OPEN)).toBe(false);
      expect(axis.inClosingAuctionWindow(HALF_OPEN + 60_000)).toBe(false);
      expect(axis.inClosingAuctionWindow(HALF_AUCTION_START - 1)).toBe(false);
    });

    it('false past the half-day close', () => {
      expect(axis.inClosingAuctionWindow(HALF_CLOSE + 1)).toBe(false);
    });
  });
});

describe('createVirtualAxis — findByReal', () => {
  const axis = createVirtualAxis(RAW_SMALL);

  it('returns -1 for empty axis', () => {
    expect(createVirtualAxis([]).findByReal(1_500_000)).toBe(-1);
  });

  it('returns -1 for realMs before first segment open', () => {
    expect(axis.findByReal(500_000)).toBe(-1);
  });

  it('returns 0 for realMs inside first segment', () => {
    expect(axis.findByReal(1_500_000)).toBe(0);
  });

  it('returns 1 for realMs inside second segment', () => {
    expect(axis.findByReal(3_500_000)).toBe(1);
  });

  it('returns previous segment idx for realMs inside a gap', () => {
    expect(axis.findByReal(2_500_000)).toBe(0);
  });

  it('returns last idx for realMs past final close', () => {
    expect(axis.findByReal(5_000_000)).toBe(1);
  });

  it('boundary: realMs exactly at sessionOpenMs belongs to that segment', () => {
    expect(axis.findByReal(3_000_000)).toBe(1);
  });

  it('boundary: realMs exactly at sessionCloseMs belongs to that segment (not the gap)', () => {
    expect(axis.findByReal(2_000_000)).toBe(0);
  });
});

describe('createVirtualAxis — findByVirtual', () => {
  it('binary search across 12 segments', () => {
    const raw = Array.from({ length: 12 }, (_, i) => ({
      date: `2026050${i}`,
      sessionOpenMs: DAY1_OPEN + i * DAY_MS,
      sessionCloseMs: DAY1_OPEN + i * DAY_MS + SESSION_LEN_MS,
    }));
    const axis = createVirtualAxis(raw);
    expect(axis.segments).toHaveLength(12);

    expect(axis.findByVirtual(0)).toBe(0);
    // SESSION_LEN_MS sits in the gap window — still owned by segment 0
    // (segment 1 starts at SESSION_LEN_MS + GAP_MS).
    expect(axis.findByVirtual(SESSION_LEN_MS - 1)).toBe(0);
    expect(axis.findByVirtual(SESSION_LEN_MS)).toBe(0);
    expect(axis.findByVirtual(SESSION_LEN_MS + GAP_MS)).toBe(1);
    expect(axis.findByVirtual(5 * SEG_STRIDE_MS + 1000)).toBe(5);
    expect(axis.findByVirtual(11 * SEG_STRIDE_MS)).toBe(11);
    expect(axis.findByVirtual(11 * SEG_STRIDE_MS + 1000)).toBe(11);
    expect(axis.findByVirtual(-1)).toBe(-1);
  });

  it('returns -1 for empty axis', () => {
    expect(createVirtualAxis([]).findByVirtual(0)).toBe(-1);
  });
});

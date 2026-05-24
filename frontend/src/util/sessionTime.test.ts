import { describe, it, expect } from 'vitest';
import {
  classifyWithinSegment,
  isClosingAuction,
  isPreOpen,
  isRegularSession,
  sessionPhaseAt,
  AUCTION_WINDOW_LENGTH_MS,
  PRE_OPEN_WINDOW_LENGTH_MS,
} from './sessionTime';

// 2026-05-18 09:00 KST = 1779062400000 ms.
const DAY1_OPEN = 1779062400000;
const FULL_SESSION_MS = 6.5 * 60 * 60 * 1000;
const DAY1_CLOSE = DAY1_OPEN + FULL_SESSION_MS;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY2_OPEN = DAY1_OPEN + DAY_MS;
const DAY2_CLOSE = DAY2_OPEN + FULL_SESSION_MS;

const FULL_DAY = { sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_CLOSE };
const HALF_DAY = { sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_OPEN + 3.5 * 60 * 60 * 1000 };

describe('classifyWithinSegment (full-day session)', () => {
  it('pre-open band immediately precedes sessionOpenMs', () => {
    expect(classifyWithinSegment(FULL_DAY, DAY1_OPEN - 1)).toBe('pre-open');
    expect(classifyWithinSegment(FULL_DAY, DAY1_OPEN - PRE_OPEN_WINDOW_LENGTH_MS)).toBe('pre-open');
  });

  it('pre-axis before the pre-open band', () => {
    expect(classifyWithinSegment(FULL_DAY, DAY1_OPEN - PRE_OPEN_WINDOW_LENGTH_MS - 1)).toBe('pre-axis');
  });

  it('regular trading from sessionOpenMs until the auction band starts', () => {
    expect(classifyWithinSegment(FULL_DAY, DAY1_OPEN)).toBe('regular');
    const justBeforeAuction = DAY1_CLOSE - AUCTION_WINDOW_LENGTH_MS - 1;
    expect(classifyWithinSegment(FULL_DAY, justBeforeAuction)).toBe('regular');
  });

  it('auction band is the last 10 minutes of the session', () => {
    expect(classifyWithinSegment(FULL_DAY, DAY1_CLOSE - AUCTION_WINDOW_LENGTH_MS)).toBe('auction');
    expect(classifyWithinSegment(FULL_DAY, DAY1_CLOSE)).toBe('auction');
  });

  it('post-axis past sessionCloseMs', () => {
    expect(classifyWithinSegment(FULL_DAY, DAY1_CLOSE + 1)).toBe('post-axis');
  });
});

describe('classifyWithinSegment (half-day session — 12:30 KST close)', () => {
  it('auction band stays anchored to sessionCloseMs, not a 6h20m offset', () => {
    // On a 3h30m half-day, fixed 6h20m offset would put the band past close.
    // The duration-based formula (sessionCloseMs - 10min) keeps the band valid.
    const halfClose = HALF_DAY.sessionCloseMs;
    expect(classifyWithinSegment(HALF_DAY, halfClose - AUCTION_WINDOW_LENGTH_MS)).toBe('auction');
    expect(classifyWithinSegment(HALF_DAY, halfClose)).toBe('auction');
    // Mid-session is still regular.
    expect(classifyWithinSegment(HALF_DAY, HALF_DAY.sessionOpenMs + 60_000)).toBe('regular');
  });
});

describe('sessionPhaseAt — multi-segment scanning', () => {
  const segments = [
    FULL_DAY,
    { sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_CLOSE },
  ];

  it('pre-axis before the first pre-open band', () => {
    expect(sessionPhaseAt(segments, DAY1_OPEN - PRE_OPEN_WINDOW_LENGTH_MS - 1)).toBe('pre-axis');
  });

  it('gap between two segments (after seg0 close, before seg1 pre-open)', () => {
    const inGap = DAY1_CLOSE + 60 * 60 * 1000; // 1 hour after close, well inside the inter-day gap
    expect(sessionPhaseAt(segments, inGap)).toBe('gap');
  });

  it('post-axis past the final segment close', () => {
    expect(sessionPhaseAt(segments, DAY2_CLOSE + 1)).toBe('post-axis');
  });

  it('routes a realMs inside the second segment to that segment', () => {
    expect(sessionPhaseAt(segments, DAY2_OPEN + 60_000)).toBe('regular');
    expect(sessionPhaseAt(segments, DAY2_CLOSE)).toBe('auction');
  });

  it('empty axis is always pre-axis', () => {
    expect(sessionPhaseAt([], DAY1_OPEN)).toBe('pre-axis');
  });
});

describe('predicates — convenience wrappers', () => {
  const segments = [FULL_DAY];

  it('isRegularSession includes both regular and auction phases', () => {
    expect(isRegularSession(segments, DAY1_OPEN)).toBe(true);
    expect(isRegularSession(segments, DAY1_CLOSE)).toBe(true);
    expect(isRegularSession(segments, DAY1_CLOSE - AUCTION_WINDOW_LENGTH_MS)).toBe(true);
    expect(isRegularSession(segments, DAY1_OPEN - 1)).toBe(false); // pre-open
    expect(isRegularSession(segments, DAY1_CLOSE + 1)).toBe(false); // post-axis
  });

  it('isClosingAuction is true only in the auction band', () => {
    expect(isClosingAuction(segments, DAY1_CLOSE - AUCTION_WINDOW_LENGTH_MS)).toBe(true);
    expect(isClosingAuction(segments, DAY1_CLOSE)).toBe(true);
    expect(isClosingAuction(segments, DAY1_CLOSE - AUCTION_WINDOW_LENGTH_MS - 1)).toBe(false);
    expect(isClosingAuction(segments, DAY1_CLOSE + 1)).toBe(false);
  });

  it('isPreOpen is true only in the pre-open band', () => {
    expect(isPreOpen(segments, DAY1_OPEN - 1)).toBe(true);
    expect(isPreOpen(segments, DAY1_OPEN - PRE_OPEN_WINDOW_LENGTH_MS)).toBe(true);
    expect(isPreOpen(segments, DAY1_OPEN)).toBe(false); // session has started
    expect(isPreOpen(segments, DAY1_OPEN - PRE_OPEN_WINDOW_LENGTH_MS - 1)).toBe(false); // pre-axis
  });
});

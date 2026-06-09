import { describe, it, expect } from 'vitest';
import {
  classifyWithinSegment,
  isClosingAuction,
  isPreOpen,
  isRegularSession,
  locateSegment,
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

// --- 항목 2a: 선형 레퍼런스 대비 등가성 ---

// Task 1 이전의 선형 sessionPhaseAt을 그대로 복제한 레퍼런스 구현.
function sessionPhaseAtLinear(
  segments: readonly { sessionOpenMs: number; sessionCloseMs: number }[],
  realMs: number,
): string {
  if (segments.length === 0) return 'pre-axis';
  const first = segments[0];
  if (realMs < first.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'pre-axis';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const preOpenStart = seg.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS;
    if (realMs < preOpenStart) return 'gap';
    if (realMs <= seg.sessionCloseMs) return classifyWithinSegment(seg, realMs);
  }
  return 'post-axis';
}

describe('sessionPhaseAt binary == linear reference', () => {
  // 5거래일치 세그먼트(full-day + half-day 혼합), 현실적 야간 갭(24h 간격).
  const DAY = 24 * 60 * 60 * 1000;
  const FULL = 6.5 * 60 * 60 * 1000;
  const HALF = 3.5 * 60 * 60 * 1000;
  const base = 1_779_062_400_000; // 2026-05-18 09:00 KST
  const segments = [
    { sessionOpenMs: base + 0 * DAY, sessionCloseMs: base + 0 * DAY + FULL },
    { sessionOpenMs: base + 1 * DAY, sessionCloseMs: base + 1 * DAY + HALF },
    { sessionOpenMs: base + 2 * DAY, sessionCloseMs: base + 2 * DAY + FULL },
    { sessionOpenMs: base + 5 * DAY, sessionCloseMs: base + 5 * DAY + FULL }, // 주말 갭
    { sessionOpenMs: base + 6 * DAY, sessionCloseMs: base + 6 * DAY + FULL },
  ];

  // 경계 정확값 + 무작위 샘플.
  const boundaries: number[] = [];
  for (const s of segments) {
    boundaries.push(
      s.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS - 1,
      s.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS,
      s.sessionOpenMs - 1,
      s.sessionOpenMs,
      s.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS - 1,
      s.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS,
      s.sessionCloseMs,
      s.sessionCloseMs + 1,
    );
  }
  const lo = segments[0].sessionOpenMs - 2 * DAY;
  const hi = segments[segments.length - 1].sessionCloseMs + 2 * DAY;
  const random: number[] = [];
  let seed = 12345;
  for (let i = 0; i < 5000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // 결정적 LCG
    random.push(lo + (seed % (hi - lo)));
  }

  it('agrees on every boundary and random sample', () => {
    for (const t of [...boundaries, ...random]) {
      expect(locateSegment(segments, t).phase).toBe(sessionPhaseAtLinear(segments, t));
    }
  });

  it('empty segments → pre-axis, idx -1', () => {
    expect(locateSegment([], 0)).toEqual({ idx: -1, phase: 'pre-axis' });
  });

  it('returns owning index for contained timestamps', () => {
    const mid = segments[2].sessionOpenMs + 60_000;
    expect(locateSegment(segments, mid)).toEqual({ idx: 2, phase: 'regular' });
  });

  it('returns idx -1 for non-empty pre-axis timestamp', () => {
    expect(locateSegment(segments, segments[0].sessionOpenMs - 2 * DAY)).toEqual({
      idx: -1,
      phase: 'pre-axis',
    });
  });

  it('returns preceding segment idx for an inter-session gap', () => {
    // seg0 닫힘(base+FULL) 이후, seg1 pre-open(base+1DAY-30m) 이전 → 갭, owning idx=0
    const inGap = segments[0].sessionCloseMs + 60 * 60 * 1000;
    expect(locateSegment(segments, inGap)).toEqual({ idx: 0, phase: 'gap' });
  });

  it('returns last segment idx for a post-axis timestamp', () => {
    const last = segments.length - 1;
    expect(locateSegment(segments, segments[last].sessionCloseMs + DAY)).toEqual({
      idx: last,
      phase: 'post-axis',
    });
  });
});

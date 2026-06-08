import { describe, it, expect } from 'vitest';
import {
  classifyWithinSegment,
  isClosingAuction,
  isPreOpen,
  isRegularSession,
  sessionPhaseAt,
  AUCTION_WINDOW_LENGTH_MS,
  PRE_OPEN_WINDOW_LENGTH_MS,
  type SessionPhase,
  type SessionSegment,
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

describe('sessionPhaseAt — O(log n) 접근 횟수 (스펙 2026-06-08)', () => {
  it('200세그먼트에서 콜당 배열 인덱스 접근 ≤ 24 (선형이면 ~200)', () => {
    const segs = Array.from({ length: 200 }, (_, i) => ({
      sessionOpenMs: DAY1_OPEN + i * DAY_MS,
      sessionCloseMs: DAY1_OPEN + i * DAY_MS + FULL_SESSION_MS,
    }));
    let reads = 0;
    const counted = new Proxy(segs, {
      get(target, prop, recv) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads += 1;
        return Reflect.get(target, prop, recv);
      },
    });
    // 마지막 세그먼트 한가운데 — 선형 워크는 전 구간을 훑는다.
    const t = segs[199].sessionOpenMs + 60 * 60 * 1000;
    reads = 0;
    expect(sessionPhaseAt(counted, t)).toBe('regular');
    expect(reads).toBeLessThanOrEqual(24);
  });
});

describe('sessionPhaseAt — 선형 reference 동치 (스펙 2026-06-08)', () => {
  // 교체 전 선형 구현의 보존 사본 — 이진 구현의 의미론 가드. 세그먼트
  // 정렬·비중첩(buildSegments 불변식) 하에서 두 구현은 동치다.
  function linearReference(
    segments: readonly SessionSegment[],
    realMs: number,
  ): SessionPhase {
    if (segments.length === 0) return 'pre-axis';
    const first = segments[0];
    if (realMs < first.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'pre-axis';
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (realMs < seg.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'gap';
      if (realMs <= seg.sessionCloseMs) return classifyWithinSegment(seg, realMs);
    }
    return 'post-axis';
  }

  it('다중 세그먼트(반장 포함) 축에서 경계 ±1ms·1분 스윕 전수 일치', () => {
    const segs = [
      { sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_CLOSE },
      { sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_OPEN + 3.5 * 60 * 60 * 1000 },
      {
        sessionOpenMs: DAY1_OPEN + 2 * DAY_MS,
        sessionCloseMs: DAY1_OPEN + 2 * DAY_MS + FULL_SESSION_MS,
      },
    ];
    const probes: number[] = [];
    for (const s of segs) {
      for (const b of [
        s.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS,
        s.sessionOpenMs,
        s.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS,
        s.sessionCloseMs,
      ]) {
        probes.push(b - 1, b, b + 1);
      }
    }
    for (let t = DAY1_OPEN - DAY_MS; t <= DAY1_OPEN + 3 * DAY_MS; t += 60_000) {
      probes.push(t);
    }
    for (const t of probes) {
      expect(sessionPhaseAt(segs, t), `t=${t}`).toBe(linearReference(segs, t));
    }
  });
});

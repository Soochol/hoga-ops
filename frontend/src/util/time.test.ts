import { describe, it, expect } from 'vitest';
import { unixMsToKSTClock, formatElapsed, findSegmentByReal, buildSegments } from './time';

describe('unixMsToKSTClock', () => {
  it('formats midnight KST as 00:00:00', () => {
    const unixMs = Date.UTC(2026, 4, 19, 15, 0, 0);
    expect(unixMsToKSTClock(unixMs)).toBe('00:00:00');
  });
  it('formats 13:24:00 KST', () => {
    const unixMs = Date.UTC(2026, 4, 20, 4, 24, 0);
    expect(unixMsToKSTClock(unixMs)).toBe('13:24:00');
  });
});

describe('formatElapsed', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatElapsed(134_000)).toBe('2:14');
  });
  it('formats over an hour as H:MM:SS', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});

describe('findSegmentByReal', () => {
  const segs = buildSegments([
    { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
    { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
  ]);

  it('returns -1 for empty segments', () => {
    expect(findSegmentByReal([], 1_500_000)).toBe(-1);
  });

  it('returns -1 for realMs before first segment open', () => {
    expect(findSegmentByReal(segs, 500_000)).toBe(-1);
  });

  it('returns 0 for realMs inside first segment', () => {
    expect(findSegmentByReal(segs, 1_500_000)).toBe(0);
  });

  it('returns 1 for realMs inside second segment', () => {
    expect(findSegmentByReal(segs, 3_500_000)).toBe(1);
  });

  it('returns previous segment idx for realMs inside a gap (after segment 0 close, before segment 1 open)', () => {
    expect(findSegmentByReal(segs, 2_500_000)).toBe(0);
  });

  it('returns last idx for realMs past final close', () => {
    expect(findSegmentByReal(segs, 5_000_000)).toBe(1);
  });

  it('boundary: realMs exactly at sessionOpenMs belongs to that segment', () => {
    expect(findSegmentByReal(segs, 3_000_000)).toBe(1);
  });

  it('boundary: realMs exactly at sessionCloseMs belongs to that segment (not the gap)', () => {
    expect(findSegmentByReal(segs, 2_000_000)).toBe(0);
  });
});

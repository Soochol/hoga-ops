import { describe, it, expect } from 'vitest';
import { unixMsToKSTClock, unixMsToKSTDate, formatElapsed } from './time';

// Segment-/axis-bound math moved to `virtualAxis.ts` and tested in
// `virtualAxis.test.ts`. This file covers the remaining Segment-agnostic
// formatting utilities.

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

describe('unixMsToKSTDate', () => {
  it('returns the YYYYMMDD of the KST calendar day at 09:00 KST (session open)', () => {
    // 2026-05-20 09:00 KST = 2026-05-20 00:00 UTC
    const unixMs = Date.UTC(2026, 4, 20, 0, 0, 0);
    expect(unixMsToKSTDate(unixMs)).toBe('20260520');
  });
  it('returns the same KST day for an after-hours timestamp (16:00 KST)', () => {
    // 2026-05-20 16:00 KST = 2026-05-20 07:00 UTC — still within the same KST day.
    const unixMs = Date.UTC(2026, 4, 20, 7, 0, 0);
    expect(unixMsToKSTDate(unixMs)).toBe('20260520');
  });
  it('uses the KST calendar boundary (UTC 15:00 of day N-1 = KST 00:00 of day N)', () => {
    // KST midnight on 2026-05-20 = UTC 15:00 on 2026-05-19. One ms earlier is
    // still 2026-05-19 in KST (23:59:59.999 KST).
    const oneMsBeforeKstMidnight = Date.UTC(2026, 4, 19, 15, 0, 0) - 1;
    expect(unixMsToKSTDate(oneMsBeforeKstMidnight)).toBe('20260519');
    // At KST midnight exactly, the date rolls to 2026-05-20.
    expect(unixMsToKSTDate(Date.UTC(2026, 4, 19, 15, 0, 0))).toBe('20260520');
  });
  it('zero-pads single-digit month and day', () => {
    // 2026-01-02 12:00 KST = 2026-01-02 03:00 UTC
    const unixMs = Date.UTC(2026, 0, 2, 3, 0, 0);
    expect(unixMsToKSTDate(unixMs)).toBe('20260102');
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

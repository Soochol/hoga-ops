import { describe, it, expect } from 'vitest';
import { unixMsToKSTClock, formatElapsed } from './time';

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

describe('formatElapsed', () => {
  it('formats under an hour as M:SS', () => {
    expect(formatElapsed(134_000)).toBe('2:14');
  });
  it('formats over an hour as H:MM:SS', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});

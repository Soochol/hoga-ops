import { describe, expect, it, vi } from 'vitest';
import {
  alignSidebarCursorMs,
  shouldPublishSidebarCursor,
  sidebarCursorPublishDelayMs,
  createSidebarCursorThrottle,
} from './sidebarCursorRateLimit';

describe('sidebar cursor rate-limit helpers', () => {
  it('aligns to the bucket floor', () => {
    expect(alignSidebarCursorMs(1_779_930_029_999, 60_000)).toBe(1_779_930_000_000);
    expect(alignSidebarCursorMs(1_779_930_060_000, 60_000)).toBe(1_779_930_060_000);
  });

  it('keeps the raw cursor when bucket is unavailable', () => {
    expect(alignSidebarCursorMs(1_779_930_029_999, null)).toBe(1_779_930_029_999);
    expect(alignSidebarCursorMs(1_779_930_029_999, 0)).toBe(1_779_930_029_999);
  });

  it('publishes only when the sidebar cursor value changes', () => {
    expect(shouldPublishSidebarCursor(null, 1)).toBe(true);
    expect(shouldPublishSidebarCursor(1, 1)).toBe(false);
    expect(shouldPublishSidebarCursor(1, 2)).toBe(true);
    expect(shouldPublishSidebarCursor(null, null)).toBe(false);
  });

  it('leading edge: zero delay when never published or the window has elapsed', () => {
    expect(sidebarCursorPublishDelayMs(1_000, null, 120)).toBe(0);
    expect(sidebarCursorPublishDelayMs(1_000, 880, 120)).toBe(0);
    expect(sidebarCursorPublishDelayMs(1_000, 500, 120)).toBe(0);
  });

  it('trailing edge: remaining window when inside it', () => {
    expect(sidebarCursorPublishDelayMs(1_000, 1_000, 120)).toBe(120);
    expect(sidebarCursorPublishDelayMs(1_000, 999, 120)).toBe(119);
    expect(sidebarCursorPublishDelayMs(1_000, 881, 120)).toBe(1);
  });
});

it('publishes leading and latest trailing positions during continuous movement and cancels pending work', () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  try {
    const publish = vi.fn((_cursorMs: number) => true);
    const throttle = createSidebarCursorThrottle(publish);
    throttle.schedule(1);
    for (let i = 2; i <= 7; i++) { vi.advanceTimersByTime(20); throttle.schedule(i); }
    expect(publish.mock.calls.map(c => c[0])).toEqual([1, 6]);
    vi.advanceTimersByTime(120);
    expect(publish.mock.calls.map(c => c[0])).toEqual([1, 6, 7]);
    throttle.schedule(8);
    throttle.cancel();
    vi.advanceTimersByTime(120);
    expect(publish).toHaveBeenCalledTimes(3);
    throttle.schedule(9);
    expect(publish).toHaveBeenLastCalledWith(9);
    throttle.cancel();
  } finally { vi.useRealTimers(); }
});

export function alignSidebarCursorMs(cursorMs: number, bucketMs: number | null): number {
  if (bucketMs === null || !(bucketMs > 0)) return cursorMs;
  return Math.floor(cursorMs / bucketMs) * bucketMs;
}

export function shouldPublishSidebarCursor(current: number | null, next: number | null): boolean {
  return current !== next;
}

/**
 * Leading+trailing throttle delay for sidebar-cursor publishes.
 * 0 → the throttle window has elapsed since the last publish: publish now
 * (leading edge). >0 → still inside the window: arm ONE trailing timer for
 * that many ms and publish the latest pending value when it fires.
 */
export function sidebarCursorPublishDelayMs(
  nowMs: number,
  lastPublishAtMs: number | null,
  intervalMs: number,
): number {
  if (lastPublishAtMs === null) return 0;
  const elapsed = nowMs - lastPublishAtMs;
  if (elapsed >= intervalMs) return 0;
  return Math.min(intervalMs, intervalMs - elapsed);
}
/** Leading+trailing throttle window for sidebarCursorMs publishes. The first
 * hover after a quiet window publishes immediately; while the pointer keeps
 * moving, the latest aligned cursor is published once per window — a trailing
 * debounce here starved the sidebar for the entire duration of a continuous
 * sweep (it only fired after the pointer stopped). */
export const LIVE_SIDEBAR_CURSOR_THROTTLE_MS = 120;

/** Local crosshair paint stays immediate; expensive linked views receive a
 * leading update and the latest trailing position, even during a long sweep. */
export function createSidebarCursorThrottle(publish: (cursorMs: number) => boolean) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: number | null = null;
  let lastPublishAt: number | null = null;
  const flush = (next: number) => {
    if (publish(next)) lastPublishAt = performance.now();
  };
  return {
    schedule(next: number) {
      pending = next;
      if (timer !== null) return;
      const delay = sidebarCursorPublishDelayMs(performance.now(), lastPublishAt, LIVE_SIDEBAR_CURSOR_THROTTLE_MS);
      if (delay === 0) { pending = null; flush(next); return; }
      timer = setTimeout(() => {
        timer = null;
        const latest = pending;
        pending = null;
        if (latest !== null) flush(latest);
      }, delay);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      lastPublishAt = null;
    },
  };
}

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

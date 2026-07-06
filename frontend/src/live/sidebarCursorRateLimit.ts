export function alignSidebarCursorMs(cursorMs: number, bucketMs: number | null): number {
  if (bucketMs === null || !(bucketMs > 0)) return cursorMs;
  return Math.floor(cursorMs / bucketMs) * bucketMs;
}

export function shouldPublishSidebarCursor(current: number | null, next: number | null): boolean {
  return current !== next;
}

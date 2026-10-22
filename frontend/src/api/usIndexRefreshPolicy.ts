/** Older servers keep their minute cadence; bound server-provided poll hints. */
export function usIndexRefreshInterval(interval?: number): number {
  return interval != null && Number.isFinite(interval) ? Math.max(2000, Math.min(60_000, interval)) : 60_000;
}

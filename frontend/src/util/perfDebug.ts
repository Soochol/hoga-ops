export function livePerfDebugEnabled(): boolean {
  if (import.meta.env.VITE_HOGA_PERF_DEBUG === '1') return true;
  try {
    return window.localStorage.getItem('hoga.perf.debug') === '1';
  } catch {
    return false;
  }
}

export function livePerfLog(event: string, payload: Record<string, unknown>): void {
  if (!livePerfDebugEnabled()) return;
  console.info(`[hoga-perf] ${event}`, {
    ts: new Date().toISOString(),
    ...payload,
  });
}

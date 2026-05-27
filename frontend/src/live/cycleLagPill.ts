/**
 * Cycle-lag pill severity classifier (Audit-driven Addendum, Design S4).
 *
 * Thresholds:
 *   < 2s   → ok    (neutral)
 *   2–10s  → warn  (amber)
 *   ≥ 10s  → error (red)
 *
 * The 10s threshold comes from spec §10's "cycle_lag_ms > 30s triggers toast";
 * we surface the pill earlier so the user notices drift before the 30s toast.
 */
export type CycleLagSeverity = 'ok' | 'warn' | 'error';

export function cycleLagSeverity(cycleLagMs: number): CycleLagSeverity {
  if (cycleLagMs >= 10_000) return 'error';
  if (cycleLagMs >= 2_000) return 'warn';
  return 'ok';
}

export function cycleLagPillColor(severity: CycleLagSeverity): {
  bg: string;
  border: string;
  fg: string;
} {
  switch (severity) {
    case 'error':
      return { bg: 'var(--tint-error)', border: 'var(--error)', fg: 'var(--error)' };
    case 'warn':
      return { bg: 'rgba(245, 158, 11, 0.10)', border: 'var(--warn)', fg: 'var(--warn)' };
    case 'ok':
      return { bg: 'transparent', border: 'var(--border)', fg: 'var(--fg-dimmer)' };
  }
}

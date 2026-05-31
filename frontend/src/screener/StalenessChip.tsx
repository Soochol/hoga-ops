import type { ScreenerStatus } from '../api/screener';

interface Props {
  status: ScreenerStatus | undefined;
}

/** Header data-freshness chip. DESIGN DECISION: neutral --fg-dim when current
 *  (days_behind === 0 or undefined-but-status-ok), amber --warn when behind
 *  (days_behind ≥ 1). `days_behind === null` means KRX outage / unknown — stay
 *  neutral, don't false-alarm. The trading-day distance comes from the wire
 *  (GET /api/screener/status), so the chip no longer derives a calendar-day
 *  proxy (which false-amber'd on weekends). Colour carries the behind state,
 *  same idiom as CaptureStatusPill. */
export function StalenessChip({ status }: Props) {
  if (!status) return null;
  const last = status.last_raw_date;
  const daysBehind = status.days_behind;
  const behind = typeof daysBehind === 'number' && daysBehind >= 1;
  const color = behind ? 'var(--warn)' : 'var(--fg-dim)';
  return (
    <span
      data-testid="staleness-chip"
      title={behind ? '최신 거래일보다 뒤처짐' : '최신'}
      className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums"
      style={{ color }}
    >
      <span className="rounded-full" style={{ width: 6, height: 6, background: color }} aria-hidden />
      마지막: {last ?? '—'}
      {behind && ` · ${daysBehind}거래일 뒤처짐`}
    </span>
  );
}

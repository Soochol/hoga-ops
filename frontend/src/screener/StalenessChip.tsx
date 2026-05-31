import type { ScreenerStatus } from '../api/screener';

interface Props {
  status: ScreenerStatus | undefined;
}

/** Trading-day distance from the latest available raw date to today (KST).
 *  The wire shape does not carry `days_behind` directly, so we derive a coarse
 *  behind-signal: any `last_raw_date` strictly before today's KST date counts
 *  as behind. This is a calendar-day proxy (weekends/holidays inflate it), so
 *  the chip wording stays "마지막: {date}" rather than an exact day count —
 *  the colour is the load-bearing signal, per the DESIGN DECISION. */
function isBehind(lastRawDate: string | undefined): boolean {
  if (!lastRawDate) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).replaceAll('-', '');
  return lastRawDate < today;
}

/** Header data-freshness chip. DESIGN DECISION: neutral --fg-dim when current
 *  (days_behind === 0), amber --warn when behind (days_behind ≥ 1). Shows the
 *  last raw date; colour carries the behind state. */
export function StalenessChip({ status }: Props) {
  if (!status) return null;
  const last = status.last_raw_date;
  const behind = isBehind(last);
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
    </span>
  );
}

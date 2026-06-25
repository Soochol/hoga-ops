import type { ScreenerStatus } from '../api/screener';

interface Props {
  status: ScreenerStatus | undefined;
}

/** Header EOD archive chip. It deliberately describes the stored confirmed
 *  daily archive, not the active scan basis: intraday scans may still overlay
 *  today's KIS quote while this archive remains on the previous trading day. */
export function StalenessChip({ status }: Props) {
  if (!status) return null;
  const last = status.last_raw_date;
  const daysBehind = status.days_behind;
  const behind = typeof daysBehind === 'number' && daysBehind >= 1;
  const color = behind ? 'var(--warn)' : 'var(--fg-dim)';
  const pendingText = behind
    ? daysBehind === 1
      ? '오늘 확정분 대기'
      : `${daysBehind}거래일 확정분 대기`
    : null;
  return (
    <span
      data-testid="staleness-chip"
      title={behind ? '확정 일봉 아카이브가 최신 거래일 확정분을 기다리는 중' : '확정 일봉 아카이브 최신'}
      className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums"
      style={{ color }}
    >
      <span className="rounded-full" style={{ width: 6, height: 6, background: color }} aria-hidden />
      EOD 아카이브: {last ?? '—'}
      {pendingText && ` · ${pendingText}`}
    </span>
  );
}

import { StatusChip } from '../ui/StatusChip';
import { formatTradingDate } from '../util/displayDate';
import type { ScreenerStatus } from '../api/screener';

interface Props {
  status: ScreenerStatus | undefined;
}

/** Header EOD archive chip. It deliberately describes the stored confirmed
 *  daily archive, not the active scan basis: intraday scans may still overlay
 *  today's Kiwoom quote while this archive remains on the previous trading day. */
export function StalenessChip({ status }: Props) {
  if (!status) return null;
  const last = status.last_raw_date;
  const daysBehind = status.days_behind;
  const behind = typeof daysBehind === 'number' && daysBehind >= 1;
  const pendingText = behind
    ? daysBehind === 1
      ? '오늘 확정분 대기'
      : `${daysBehind}거래일 확정분 대기`
    : null;
  const label = <>일봉 기준 {formatTradingDate(last)}{pendingText && ` · ${pendingText}`}</>;
  if (behind) return <StatusChip tone="warn" data-testid="staleness-chip"
    title="확정 일봉 아카이브가 최신 거래일 확정분을 기다리는 중">{label}</StatusChip>;
  return <span data-testid="staleness-chip" title="확정 일봉 아카이브 최신" className="font-data text-xs tabular-nums text-fg-dim" style={{ color: 'var(--fg-dim)' }}>{label}</span>;
}

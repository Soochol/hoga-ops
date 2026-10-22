import { useIndexHeaderQuote } from '../../api/indexHeaderQuote';
import { QuoteChange } from '../../rightrail/QuoteChange';
import type { LiveIndexId } from '../liveInstrument';
import { useMinuteClock } from '../useMinuteClock';
import { useWindowWarnings } from './windowWarningsSource';

const formatValue = (value: number | null | undefined) => value != null && Number.isFinite(value)
  ? value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
export function IndexTitleBarSymbolRow({ name, indexId, windowId }: {
  name: string | null; indexId: LiveIndexId; windowId: string;
}) {
  const now = useMinuteClock();
  const query = useIndexHeaderQuote(indexId, now);
  const data = query.data;
  const value = data?.value != null && Number.isFinite(data.value) && data.value > 0 ? data.value : null;
  const pct = value != null && data?.change_rate != null && Number.isFinite(data.change_rate) ? data.change_rate : null;
  const delayed = data?.session_status === 'open' && (
    (data.observed_at_ms != null && now - data.observed_at_ms > 180_000)
    || (data.checked_at_ms != null && now - data.checked_at_ms > 180_000));
  const failed = query.isError || data?.refresh_status === 'error' || data?.refresh_status === 'stale';
  const status = failed ? (value != null ? '조회 지연' : '조회 실패')
    : data?.refresh_status === 'unconfigured' ? '시세 설정 필요'
    : data?.refresh_status === 'bypass' ? '시세 조회 중지'
    : data?.refresh_status === 'partial' ? '시세 일부 누락'
    : delayed ? '시세 지연' : '';
  const retryable = failed || delayed || data?.refresh_status === 'partial';
  const { backfillEarliestDate } = useWindowWarnings(windowId);
  const shortDate = backfillEarliestDate ? `${backfillEarliestDate.slice(4, 6)}/${backfillEarliestDate.slice(6, 8)}` : null;
  return <span data-testid="titlebar-symbol-row" className="live-symbol-row tabular-nums">
    <span className="live-symbol-identity">
      <span className="live-symbol-name truncate text-fg" tabIndex={0}>{name ?? indexId}</span>
    </span>
    <span data-testid="titlebar-current-price" className="live-symbol-price shrink-0 font-data text-fg"
      tabIndex={0} data-direction={pct != null ? pct > 0 ? 'up' : pct < 0 ? 'down' : undefined : undefined}>
      {formatValue(value)}
    </span>
    <span data-testid="titlebar-change" className="live-symbol-change shrink-0 font-data" tabIndex={0}>
      <QuoteChange won={null} pct={pct} />
    </span>
    {status ? retryable ? <button type="button" data-testid="titlebar-index-status"
      className="live-index-quote-status text-warning" aria-label={`${name ?? indexId} 시세 다시 조회`}
      disabled={query.isFetching}
      onPointerDown={e => e.stopPropagation()} onClick={e => {
        e.stopPropagation();
        void query.retryQuote().catch(() => { /* query error state keeps the retry reachable */ });
      }}>{query.isFetching ? '조회 중…' : `${status} ↻`}</button>
      : <span data-testid="titlebar-index-status" className="live-index-quote-status text-fg-dim">{status}</span>
      : data?.session_status === 'closed' && <span data-testid="titlebar-index-status"
        className="live-index-quote-status text-fg-dim">장 종료</span>}
    {shortDate && <span data-testid="past-backfill-progress-chip" className="live-symbol-backfill font-data text-fg-dim"
      aria-label={`과거 데이터 불러오는 중 — ${shortDate}까지 로드됨`}>↻<span className="live-symbol-warning-label">{shortDate}</span></span>}
  </span>;
}

import { useIndexHeaderQuote, type IndexHeaderQuoteResponse } from '../../api/indexHeaderQuote';
import { QuoteChange } from '../../rightrail/QuoteChange';
import type { LiveIndexId } from '../liveInstrument';
import { useMinuteClock } from '../useMinuteClock';
import { useWindowWarnings } from './windowWarningsSource';

const formatValue = (value: number | null | undefined) => value != null && Number.isFinite(value)
  ? value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const formatDate = (date: string) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

function quoteTooltip(name: string, data: IndexHeaderQuoteResponse | undefined, status: string): string {
  if (!data) return `${name} · ${status || '시세 불러오는 중'} · 최신 시세 — 차트 커서와 독립`;
  const clock = (ms: number) => new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  return [name, `최신 지수 ${formatValue(data.value)}`,
    `전일 종가 ${formatValue(data.previous_close)}`,
    `전일 대비 ${data.change != null ? `${data.change > 0 ? '+' : ''}${formatValue(data.change)}pt` : '—'}`,
    `등락률 ${data.change_rate != null ? `${data.change_rate > 0 ? '+' : ''}${data.change_rate.toFixed(2)}%` : '—'}`,
    data.trading_date ? `기준 거래일 ${formatDate(data.trading_date)} (${data.market_timezone === 'America/New_York' ? '뉴욕 기준' : '국내 거래일 달력 기준'})` : '기준 거래일 미확인',
    data.session_status === 'closed' ? '장 종료 · 마지막 시세 유지' : null,
    data.observed_at_ms != null ? `시세 기준 ${clock(data.observed_at_ms)} KST` : null,
    data.checked_at_ms != null ? `마지막 정상 확인 ${clock(data.checked_at_ms)} KST` : null,
    data.source === 'kis_daily' ? '완료된 일봉 종가 기준' : data.source === 'kis_minute' ? '최신 1분봉 종가 기준' : null,
    data.delay_unverified ? '공급자 시세 지연 미확인' : null,
    status || null, '차트 커서·봉 주기와 독립',
  ].filter(Boolean).join('\n');
}

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
  const title = quoteTooltip(name ?? indexId, data, status);
  const { backfillEarliestDate } = useWindowWarnings(windowId);
  const shortDate = backfillEarliestDate ? `${backfillEarliestDate.slice(4, 6)}/${backfillEarliestDate.slice(6, 8)}` : null;
  return <span data-testid="titlebar-symbol-row" className="live-symbol-row tabular-nums">
    <span className="live-symbol-identity">
      <span className="live-symbol-name truncate text-fg" title={title} tabIndex={0}>{name ?? indexId}</span>
    </span>
    <span data-testid="titlebar-current-price" className="live-symbol-price shrink-0 font-data text-fg"
      title={title} tabIndex={0} data-direction={pct != null ? pct > 0 ? 'up' : pct < 0 ? 'down' : undefined : undefined}>
      {formatValue(value)}
    </span>
    <span data-testid="titlebar-change" className="live-symbol-change shrink-0 font-data" title={title} tabIndex={0}>
      <QuoteChange won={null} pct={pct} />
    </span>
    {status ? retryable ? <button type="button" data-testid="titlebar-index-status"
      className="live-index-quote-status text-warning" aria-label={`${name ?? indexId} 시세 다시 조회`}
      title={`${title}\n다시 조회`} disabled={query.isFetching}
      onPointerDown={e => e.stopPropagation()} onClick={e => {
        e.stopPropagation();
        void query.retryQuote().catch(() => { /* query error state keeps the retry reachable */ });
      }}>{query.isFetching ? '조회 중…' : `${status} ↻`}</button>
      : <span data-testid="titlebar-index-status" className="live-index-quote-status text-fg-dim" title={title}>{status}</span>
      : data?.session_status === 'closed' && <span data-testid="titlebar-index-status"
        className="live-index-quote-status text-fg-dim" title={title}>장 종료</span>}
    {shortDate && <span data-testid="past-backfill-progress-chip" className="live-symbol-backfill font-data text-fg-dim"
      title={`과거 데이터 불러오는 중 — ${shortDate}까지 로드됨`}>↻<span className="live-symbol-warning-label">{shortDate}</span></span>}
  </span>;
}

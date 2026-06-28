import type {
  LiveInvestorTrendEstimateResponse,
  LiveInvestorTrendEstimateRow,
} from '../api/liveInvestorTrendEstimate';
import {
  SidebarCard,
  SidebarCardFooter,
  SidebarCardHeader,
  SidebarState,
} from './SidebarSurface';

type QueryLike = {
  data?: LiveInvestorTrendEstimateResponse;
  isLoading?: boolean;
  error?: unknown;
};

type Props = {
  query: QueryLike;
};

export function InvestorTrendEstimateCard({ query }: Props) {
  const data = query.data;
  const rows = data?.rows ?? [];
  const hasRows = rows.length > 0;
  const isError = Boolean(query.error) || data?.status === 'error';
  const isLoadingFirstFetch = query.isLoading && !data;
  const stateText = getStateText({ isLoadingFirstFetch, isError, data, hasRows });

  return (
    <SidebarCard testId="investor-trend-estimate-card">
      <SidebarCardHeader
        title="외인·기관 추정"
        meta={hasRows && stateText ? stateText : undefined}
      />

      {hasRows ? (
        <div className="overflow-hidden">
          <table className="w-full table-fixed border-collapse font-mono text-sm tabular-nums">
            <thead className="text-fg-dimmer">
              <tr>
                <th className="w-[7.5rem] px-2 py-1.5 text-left font-medium">집계시간</th>
                <th className="px-2 py-1.5 text-right font-medium">외국인</th>
                <th className="px-2 py-1.5 text-right font-medium">기관</th>
                <th className="px-2 py-1.5 text-right font-medium">합산</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const isLatest = isLatestRow(row, data?.latest ?? null);
                return (
                  <tr
                    key={row.slot}
                    data-testid={isLatest ? 'investor-estimate-row-latest' : undefined}
                    className={isLatest ? 'bg-bg' : undefined}
                  >
                    <td className="px-2 py-1.5 text-left text-fg-dim">
                      {formatAggregationTime(row, index)}
                    </td>
                    <QtyCell value={row.foreign_qty} />
                    <QtyCell value={row.institution_qty} />
                    <QtyCell value={row.sum_qty} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <SidebarState className="min-h-[72px] px-3 py-4">
          {stateText}
        </SidebarState>
      )}

      <SidebarCardFooter
        left="KIS 장중 가집계 · 수량 기준"
        right={hasRows && data?.fetched_at_ms ? `최근 조회 ${formatHourMinute(data.fetched_at_ms)}` : undefined}
      />
    </SidebarCard>
  );
}

function QtyCell({ value }: { value: number | null }) {
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums ${qtyClass(value)}`}>
      {formatQtyWithCommas(value)}
    </td>
  );
}

export function formatQtyWithCommas(value: number | null): string {
  if (value === null) return '-';
  if (value === 0) return '0';

  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString('en-US')}`;
}

export function formatAggregationTime(
  row: Pick<LiveInvestorTrendEstimateRow, 'slot' | 'observed_at_ms'>,
  index: number,
): string {
  if (typeof row.observed_at_ms === 'number') {
    return `${formatAggregationOrdinal(row.slot, index)}(${formatHourMinute(row.observed_at_ms)})`;
  }
  return formatSlotFallback(row.slot);
}

function formatAggregationOrdinal(slot: string, index: number): string {
  const normalized = slot.trim();
  if (/^\d{1,2}$/.test(normalized)) return `${Number(normalized)}차`;
  return `${index + 1}차`;
}

function formatSlotFallback(slot: string): string {
  const normalized = slot.trim();
  if (/^\d{4}$/.test(normalized)) return `${normalized.slice(0, 2)}:${normalized.slice(2)}`;
  return normalized;
}

function qtyClass(value: number | null): string {
  if (value === null || value === 0) return 'text-fg-dimmer';
  return value > 0 ? 'text-price-up' : 'text-price-down';
}

function getStateText({
  isLoadingFirstFetch,
  isError,
  data,
  hasRows,
}: {
  isLoadingFirstFetch: boolean | undefined;
  isError: boolean;
  data?: LiveInvestorTrendEstimateResponse;
  hasRows: boolean;
}): string | null {
  if (isLoadingFirstFetch) return '조회 중';
  if (isError) return hasRows ? '조회 지연' : '조회 실패';
  if (data && !hasRows) return '추정 수급 없음';
  return null;
}

function isLatestRow(
  row: LiveInvestorTrendEstimateRow,
  latest: LiveInvestorTrendEstimateRow | null,
): boolean {
  return (
    latest !== null &&
    row.slot === latest.slot &&
    row.foreign_qty === latest.foreign_qty &&
    row.institution_qty === latest.institution_qty &&
    row.sum_qty === latest.sum_qty
  );
}

function formatHourMinute(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

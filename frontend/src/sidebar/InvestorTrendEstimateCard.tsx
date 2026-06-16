import type {
  LiveInvestorTrendEstimateResponse,
  LiveInvestorTrendEstimateRow,
} from '../api/liveInvestorTrendEstimate';

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
    <section
      data-testid="investor-trend-estimate-card"
      className="mx-[var(--space-sm)] mb-[var(--space-sm)] flex flex-col bg-bg-card border rounded overflow-hidden"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b text-xs">
        <h2 className="font-semibold text-fg">외인·기관 추정</h2>
        {hasRows && stateText && <span className="font-mono text-fg-dimmer">{stateText}</span>}
      </header>

      {hasRows ? (
        <div className="overflow-hidden">
          <table className="w-full table-fixed border-collapse font-mono text-[11px]">
            <thead className="text-fg-dimmer">
              <tr>
                <th className="w-[4.25rem] px-2 py-1.5 text-left font-medium">입력</th>
                <th className="px-2 py-1.5 text-right font-medium">외국인</th>
                <th className="px-2 py-1.5 text-right font-medium">기관</th>
                <th className="px-2 py-1.5 text-right font-medium">합산</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isLatest = isLatestRow(row, data?.latest ?? null);
                return (
                  <tr
                    key={row.slot}
                    data-testid={isLatest ? 'investor-estimate-row-latest' : undefined}
                    className={isLatest ? 'bg-bg' : undefined}
                  >
                    <td className="px-2 py-1.5 text-left text-fg-dim">{row.slot}</td>
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
        <div className="grid min-h-[72px] place-items-center px-3 py-4 text-xs text-fg-dimmer">
          {stateText}
        </div>
      )}

      <footer className="flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-fg-dimmer">
        <span>KIS 장중 가집계 · 수량 기준</span>
        {hasRows && data?.fetched_at_ms ? (
          <span className="font-mono">최근 조회 {formatHourMinute(data.fetched_at_ms)}</span>
        ) : null}
      </footer>
    </section>
  );
}

function QtyCell({ value }: { value: number | null }) {
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums ${qtyClass(value)}`}>
      {formatQtyCompact(value)}
    </td>
  );
}

export function formatQtyCompact(value: number | null): string {
  if (value === null) return '-';
  if (value === 0) return '0주';

  const sign = value > 0 ? '+' : '';
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const compact = trimTrailingZero((abs / 1000).toFixed(1));
    return `${sign}${value < 0 ? '-' : ''}${compact}k주`;
  }
  return `${sign}${value}주`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
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

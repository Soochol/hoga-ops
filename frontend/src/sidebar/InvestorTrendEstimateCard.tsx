import { SegmentedControl } from '../ui/SegmentedControl';
import type { LiveInvestorTrendEstimateResponse, LiveInvestorTrendEstimateRow } from '../api/liveInvestorTrendEstimate';
import { useInvestorEstimateUnitStore, type InvestorEstimateUnit } from '../state/investorEstimateUnit';
import { SidebarState } from './SidebarSurface';
import { toDescendingDisplayRows, formatQty, formatAmount, qtyClass } from './InvestorTrendEstimateCardHelpers';


type QueryLike = {
  data?: LiveInvestorTrendEstimateResponse;
  isLoading?: boolean;
  error?: unknown;
};


type Props = {
  query: QueryLike;
};


export function InvestorTrendEstimateCard({ query }: Props) {
  const unit = useInvestorEstimateUnitStore((s) => s.unit);
  const toggleUnit = useInvestorEstimateUnitStore((s) => s.toggleUnit);
  const qty = unit === 'qty';
  const data = query.data;
  const rows = data?.rows ?? [];
  const hasRows = rows.length > 0;
  const isError = Boolean(query.error) || data?.status === 'error';
  const isLoadingFirstFetch = query.isLoading && !data;
  const stateText = getStateText({ isLoadingFirstFetch, isError, data, hasRows });
  const displayRows = toDescendingDisplayRows(rows);

  if (!hasRows) {
    return (
      <div data-testid="investor-trend-estimate-card" className="h-full">
        <SidebarState className="min-h-[72px] px-3 py-4">{stateText}</SidebarState>
      </div>
    );
  }

  return (
    <div data-testid="investor-trend-estimate-card" className="flex h-full flex-col">
      {/* 상태는 평소엔 렌더하지 않는다 — "조회 중"·"조회 지연" 처럼 표가 거짓말을
          하고 있을 때만 한 줄이 생긴다. 항상 있는 크롬이면 그게 라벨이 된다. */}
      {stateText && (
        <div className="shrink-0 px-3 pt-1.5 text-right font-data text-xs text-fg-dim">
          {stateText}
        </div>
      )}

      <div className="flex shrink-0 justify-end px-2 py-1"><UnitChip unit={unit} onToggle={toggleUnit} /></div>
      <table className="w-full border-collapse font-data text-sm tabular-nums">
        {/* 헤더 배경은 창 본문(--bg-card)과 같은 값 — 밴드로 분리하지 않는다
            (2026-07-30 사용자 결정, 거래원 합계행 #961 과 동일 방침).
            sticky 는 창을 좁혀 스크롤이 생겼을 때 컬럼 이름을 붙잡아 두므로
            배경 자체는 필수다 — 투명하면 스크롤되는 행이 뒤로 비친다.
            배경을 thead/tr 이 아니라 th 마다 주는 이유: border-collapse 표에서는
            thead/tr 배경이 sticky 헤더를 따라오지 않는다. */}
        <thead className="sticky top-0 z-10 text-xs text-fg-dim">
          <tr>
            <th className="whitespace-nowrap bg-bg-card py-1.5 pl-2.5 pr-1 text-left font-medium">차수</th>
            <th className="bg-bg-card px-1 py-1.5 text-right font-medium">외국인</th>
            <th className="bg-bg-card px-1 py-1.5 text-right font-medium">기관</th>
            <th className="bg-bg-card px-1 py-1.5 text-right font-medium">합산</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map(({ row, ordinal, time }) => {
            const isLatest = isLatestRow(row, data?.latest ?? null);
            return (
              <tr
                key={row.slot}
                data-testid={isLatest ? 'investor-estimate-row-latest' : undefined}
                // 선택 행은 배경 틴트만 — 좌측 accent 바 금지(DESIGN.md list-row rule).
                className={isLatest ? 'bg-tint-selection' : undefined}
              >
                <td className="whitespace-nowrap py-1.5 pl-2.5 pr-1 text-left text-fg-dim">
                  {ordinal !== null && <span>{ordinal}차 · </span>}
                  <span>{time}</span>
                </td>
                <ValueCell unit={unit} value={qty ? row.foreign_qty : row.foreign_amt_mwon} />
                <ValueCell
                  unit={unit}
                  value={qty ? row.institution_qty : row.institution_amt_mwon}
                />
                <ValueCell unit={unit} value={qty ? row.sum_qty : row.sum_amt_mwon} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


function ValueCell({
  value,
  unit,
  className = 'px-1',
}: {
  value: number | null;
  unit: InvestorEstimateUnit;
  className?: string;
}) {
  return (
    <td className={`py-1.5 text-right tabular-nums whitespace-nowrap ${className} ${qtyClass(value)}`}>
      {unit === 'qty' ? formatQty(value) : formatAmount(value)}
    </td>
  );
}


/** 두 투자자 창은 단위 상태를 공유한다. 전체 단위 이름을 표시해 토글의 뜻을 알린다. */
function UnitChip({ unit, onToggle, compact = false }: {
  unit: InvestorEstimateUnit; onToggle: () => void; compact?: boolean;
}) {
  return <SegmentedControl label="표시 단위" value={unit}
    options={[{ value: 'qty', label: compact ? '수량(K주)' : '수량(주)' }, { value: 'amount', label: '금액(억원)' }]}
    onChange={next => { if (next !== unit) onToggle(); }} />;
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

import type {
  LiveInvestorTrendEstimateResponse,
  LiveInvestorTrendEstimateRow,
} from '../api/liveInvestorTrendEstimate';
import { SidebarState } from './SidebarSurface';

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
        <div className="shrink-0 px-3 pt-1.5 text-right font-data text-xs text-fg-dimmer">
          {stateText}
        </div>
      )}

      <table className="w-full table-fixed border-collapse font-data text-sm tabular-nums">
        {/* 헤더는 선이 아니라 톤 밴드로 분리한다(DESIGN.md "구분선 최소화").
            sticky 는 창을 좁혀 스크롤이 생겼을 때 컬럼 이름을 붙잡아 둔다. */}
        <thead className="sticky top-0 z-10 text-xs text-fg-dimmer">
          <tr>
            <th className="w-[4.6rem] bg-bg-subtle py-1.5 pl-3 pr-1.5 text-left font-medium">차수</th>
            <th className="bg-bg-subtle px-1.5 py-1.5 text-right font-medium">외국인</th>
            <th className="bg-bg-subtle px-1.5 py-1.5 text-right font-medium">기관</th>
            <th className="bg-bg-subtle py-1.5 pl-1.5 pr-3 text-right font-medium">합산</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isLatest = isLatestRow(row, data?.latest ?? null);
            const { ordinal, time } = formatAggregationSlot(row, index);
            return (
              <tr
                key={row.slot}
                data-testid={isLatest ? 'investor-estimate-row-latest' : undefined}
                // 선택 행은 배경 틴트만 — 좌측 accent 바 금지(DESIGN.md list-row rule).
                className={isLatest ? 'bg-tint-selection' : undefined}
              >
                <td className="py-1.5 pl-3 pr-1.5 text-left text-fg-dim">
                  {ordinal !== null && <span className="mr-1.5 text-fg-dimmer">{ordinal}</span>}
                  <span>{time}</span>
                </td>
                <QtyCell value={row.foreign_qty} />
                <QtyCell value={row.institution_qty} />
                <QtyCell value={row.sum_qty} className="pl-1.5 pr-3" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QtyCell({ value, className = 'px-1.5' }: { value: number | null; className?: string }) {
  return (
    <td className={`py-1.5 text-right tabular-nums whitespace-nowrap ${className} ${qtyClass(value)}`}>
      {formatQtyCompact(value)}
    </td>
  );
}

/** 추정 수급 수량 표시. |v| < 1만은 원수(콤마), 1만 이상은 만 단위로 축약해
 *  350px 패널의 외국인/기관/합산 3컬럼이 겹치거나 잘리는 것을 막는다(부호 유지).
 *  예: -4,361,000 → "-436만", -620,000 → "-62만", 1,500 → "+1,500". */
export function formatQtyCompact(value: number | null): string {
  if (value === null) return '-';
  if (value === 0) return '0';
  if (Math.abs(value) < 10_000) {
    return `${value > 0 ? '+' : ''}${value.toLocaleString('ko-KR')}`;
  }
  const man = value / 10_000;
  const abs = Math.abs(man);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const rounded = Object.is(Number(man.toFixed(digits)), -0) ? 0 : Number(man.toFixed(digits));
  const body = rounded.toLocaleString('ko-KR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${rounded > 0 ? '+' : ''}${body}만`;
}

/** 집계시간 셀을 차수와 시각 두 조각으로 나눠 준다 — 셀 안에서 차수는 한 단계
 *  더 흐리게 깔고 시각이 읽히도록. `1차(09:20)` 한 덩어리였을 땐 괄호가 폭을
 *  먹고 두 값이 같은 무게로 붙어 있었다.
 *  `observed_at_ms` 가 없으면 실제 관측 시각을 모르므로 차수도 주장하지 않고
 *  슬롯 문자열만 그대로 보여 준다(추정 차수를 붙이면 없는 사실을 만든다). */
export function formatAggregationSlot(
  row: Pick<LiveInvestorTrendEstimateRow, 'slot' | 'observed_at_ms'>,
  index: number,
): { ordinal: string | null; time: string } {
  if (typeof row.observed_at_ms === 'number') {
    return {
      ordinal: formatAggregationOrdinal(row.slot, index),
      time: formatHourMinute(row.observed_at_ms),
    };
  }
  return { ordinal: null, time: formatSlotFallback(row.slot) };
}

function formatAggregationOrdinal(slot: string, index: number): string {
  const normalized = slot.trim();
  if (/^\d{1,2}$/.test(normalized)) return String(Number(normalized));
  return String(index + 1);
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

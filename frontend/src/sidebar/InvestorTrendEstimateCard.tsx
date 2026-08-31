import type {
  LiveInvestorTrendEstimateResponse,
  LiveInvestorTrendEstimateRow,
} from '../api/liveInvestorTrendEstimate';
import {
  INVESTOR_ESTIMATE_UNIT_LABELS,
  useInvestorEstimateUnitStore,
  type InvestorEstimateUnit,
} from '../state/investorEstimateUnit';
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

      <table className="w-full table-fixed border-collapse font-data text-sm tabular-nums">
        {/* 헤더 배경은 창 본문(--bg-card)과 같은 값 — 밴드로 분리하지 않는다
            (2026-07-30 사용자 결정, 거래원 합계행 #961 과 동일 방침).
            sticky 는 창을 좁혀 스크롤이 생겼을 때 컬럼 이름을 붙잡아 두므로
            배경 자체는 필수다 — 투명하면 스크롤되는 행이 뒤로 비친다.
            배경을 thead/tr 이 아니라 th 마다 주는 이유: border-collapse 표에서는
            thead/tr 배경이 sticky 헤더를 따라오지 않는다. */}
        <thead className="sticky top-0 z-10 text-xs text-fg-dim">
          <tr>
            {/* 차수 컬럼과 값 셀 패딩은 원수 표기로 바뀌면서 좁혔다 — "6 14:36" 의
                실측 잉크 폭이 50px 인데 4.6rem(83px)을 잡고 있었고, 그 여유가 그대로
                값 컬럼의 잘림이 됐다. */}
            <th className="w-[3.8rem] bg-bg-card py-1.5 pl-2.5 pr-1 text-left font-medium">차수</th>
            <th className="bg-bg-card px-1 py-1.5 text-right font-medium">외국인</th>
            <th className="bg-bg-card px-1 py-1.5 text-right font-medium">기관</th>
            <th className="bg-bg-card px-1 py-1.5 text-right font-medium">합산</th>
            {/* 칩은 값 컬럼 밖의 제 칸에 선다 — 합산 셀 안에 끼우면 표가 넓어질 때
                칩이 숫자를 따라 흘러가고, 좁아질 때 숫자를 밀어낸다. */}
            <th className="w-[2.1rem] bg-bg-card py-1 pl-0.5 pr-2 text-right">
              <UnitChip unit={unit} onToggle={toggleUnit} />
            </th>
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
                <td className="py-1.5 pl-2.5 pr-1 text-left text-fg-dim">
                  {ordinal !== null && <span className="mr-1.5 text-fg-dimmer">{ordinal}</span>}
                  <span>{time}</span>
                </td>
                <ValueCell unit={unit} value={qty ? row.foreign_qty : row.foreign_amt_mwon} />
                <ValueCell
                  unit={unit}
                  value={qty ? row.institution_qty : row.institution_amt_mwon}
                />
                <ValueCell unit={unit} value={qty ? row.sum_qty : row.sum_amt_mwon} />
                <td />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 표시 순서를 최신 차수가 맨 위인 내림차순으로 뒤집는다(2026-08-04 사용자 결정).
 *  응답의 `rows` 는 차수 오름차순이므로 배열을 그냥 뒤집으면 되지만, **차수 라벨을
 *  먼저 확정한 뒤에** 뒤집어야 한다 — `formatAggregationSlot` 은 `slot` 이 숫자가
 *  아닐 때 `index + 1` 을 차수로 쓰므로, 뒤집힌 배열에서 계산하면 최신 행이 1차가
 *  되어 번호가 거꾸로 매겨진다. 원본 배열은 건드리지 않는다(`map` 이 새 배열). */
export function toDescendingDisplayRows(
  rows: LiveInvestorTrendEstimateRow[],
): Array<{ row: LiveInvestorTrendEstimateRow; ordinal: string | null; time: string }> {
  return rows.map((row, index) => ({ row, ...formatAggregationSlot(row, index) })).reverse();
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

/** 단위 칩 — 현재 단위를 **말하면서** 누르면 축을 바꾼다.
 *
 *  표시와 조작이 같은 픽셀을 쓰는 것이 요점이다. 별도 컨트롤 행을 만들면 6행짜리
 *  표에 크롬 한 줄이 붙지만, 단위 라벨은 어차피 있어야 하므로 비용이 0 이다.
 *  라벨이 없던 판이 금액을 만주로 그려도 아무도 눈치채지 못한 판이었다.
 *
 *  기본(수량)은 중립색이고 금액일 때만 accent 다 — 기본 상태에서 빛나는 컨트롤은
 *  시선만 먹고, 여러 창을 띄웠을 때 "얘만 금액" 이 한눈에 보이지도 않는다. */
function UnitChip({ unit, onToggle }: { unit: InvestorEstimateUnit; onToggle: () => void }) {
  const isAmount = unit === 'amount';
  const description = isAmount ? '금액(억원) — 누르면 수량(주)' : '수량(주) — 누르면 금액(억원)';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isAmount}
      aria-label={`표시 단위 ${isAmount ? '금액' : '수량'}, 누르면 ${isAmount ? '수량' : '금액'}`}
      title={description}
      className={`rounded border px-1.5 py-px text-2xs leading-normal transition-colors ${
        isAmount
          ? 'border-accent text-accent'
          : 'border-border text-fg-dim hover:border-border-strong hover:text-fg'
      }`}
    >
      {INVESTOR_ESTIMATE_UNIT_LABELS[unit]}
    </button>
  );
}

/** 추정 수급 **수량**(주) 표시 — 축약하지 않는다(2026-08-04 사용자 결정).
 *  20,000 은 "2만" 이 아니라 "20,000" 이다. 가집계가 천주 단위로 반올림돼 오므로
 *  자릿수가 길어도 뒤 세 자리는 항상 0 이고, 만 단위 축약은 그 반올림 위에 반올림을
 *  한 겹 더 얹어 -1,925,000 을 "-193만"(= -1,930,000)으로 만들었다.
 *  예: -1,925,000 → "-1,925,000", 1,500 → "+1,500". */
export function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${value.toLocaleString('ko-KR')}`;
}

/** 추정 수급 **금액** 표시 — 벤더 단위(백만원) → 억원.
 *
 *  수량처럼 원수로 두지 않는 이유는 자릿수다. 백만원을 그대로 콤마 표기하면
 *  "-451,250" 이 되어 **수량 축과 형태가 구분되지 않는다** — 이 창이 단위를
 *  잃어버린 경로가 정확히 그것이었다. 억으로 올리면 자릿수도 접미도 달라져
 *  칩을 보지 않아도 어느 축인지 읽힌다.
 *
 *  |억| < 10 일 때만 소수 1자리다. 억이 이미 큰 단위라 그 위로는 소수가 정보를
 *  주지 않고 폭만 먹는다. 예: -451,250 → "-4,513억", -21,796 → "-218억",
 *  -540 → "-5.4억". */
export function formatAmount(mwon: number | null | undefined): string {
  // `undefined` 를 따로 받는 것은 타입 방어가 아니라 **배포 순서 방어**다. 프론트가
  // 백엔드보다 먼저 나가면 응답에 금액 축이 아예 없고, 그때 `null` 만 거르면 화면이
  // "NaN억" 으로 덮인다(2026-08-04 /browse 실측). 타입이 `number | null` 이라
  // 컴파일러도 단위 테스트도 이 경로를 만들어 주지 않는다.
  if (mwon === null || mwon === undefined) return '-';
  if (mwon === 0) return '0';
  const eok = mwon / 100;
  const digits = Math.abs(eok) >= 10 ? 0 : 1;
  // -0 은 "0" 으로 접는다 — 부호만 남은 0 은 방향을 주장하지 않는다.
  const rounded = Object.is(Number(eok.toFixed(digits)), -0) ? 0 : Number(eok.toFixed(digits));
  if (rounded === 0) return '0';
  const body = rounded.toLocaleString('ko-KR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${rounded > 0 ? '+' : ''}${body}억`;
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

/** 부호색 SSOT — 일별 투자자 창(`InvestorDailyWindow`)도 이 함수를 쓴다.
 *  같은 화면에 나란히 뜨는 두 표가 같은 부호를 다른 색으로 그리면 안 된다. */
export function qtyClass(value: number | null): string {
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

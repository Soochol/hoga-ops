/**
 * 일별 투자자 창 — `ka10059` 확정 순매수를 주체 13종으로 펼친 표.
 *
 * 형제인 `잠정투자자`(`InvestorTrendEstimateCard`, `ka10064`)와 **축이 다르다**:
 * 저쪽은 장중 차수별 가집계 3주체, 이쪽은 일별 확정 13주체다. 한 창에 탭으로 묶지
 * 않은 이유가 그 차이다 — 갱신 주기(장중 폴링 ↔ 일별 캐시)까지 다르다.
 *
 * ## 벤더 콜을 늘리지 않는다
 *
 * `/api/live/past-investor-net` 은 일봉 차트의 외국인·기관 pane 이 이미 쓰던
 * 경로다. 이 창이 추가로 요구한 것은 **같은 응답에 이미 오던 필드**뿐이라
 * 새 폴러도, 새 TR 도 없다.
 *
 * ## 요청 구간이 기간 칩과 무관하게 고정인 이유
 *
 * 칩(5·20·60거래일)마다 `from` 을 바꾸면 react-query 키가 갈려 누를 때마다 새
 * 요청이 나간다. 벤더 페이지가 100행(≈5개월)이라 가장 긴 기간도 콜 1회에 들어오므로,
 * 넉넉한 달력 구간을 한 번 받고 **자르기는 클라에서** 한다(`buildInvestorDailyTable`).
 *
 * ## 단위 토글 — 축은 서버가, 표시는 응답이 정한다
 *
 * `ka10059` 는 수량·금액을 **한 응답에 주지 않는다**(별개 콜). 그래서 축이 쿼리
 * 키에 들어가고, 토글은 다시 받아 온다 — 첫 전환에만 벤더 콜 하나가 더 나고
 * 그 뒤로는 축별 캐시가 받는다.
 *
 * ⚠ **셀 포맷은 `data.unit` 이 고른다 — 저장된 토글이 아니다.** 축 전환 직후
 * `placeholderData` 가 옛 축의 값을 넘겨주는 한 프레임이 있는데, 그때 토글을
 * 따르면 1,589,169주가 "15,892억" 으로 그려진다(100배 오독). 칩의 눌림 상태만
 * 스토어를 따르고 숫자는 데이터를 따른다.
 *
 * 단위 스토어는 **잠정투자자 카드와 공유한다**(`live.investorEstimateUnit.v1`).
 * 두 창이 나란히 뜬 채 단위가 서로 다르면 비교 자체가 불가능해진다 — 그 스토어가
 * 존재하는 이유가 그것이고, 표시 단위도 주/억으로 같다(`formatAmount` 가 백만원을
 * 억으로 접는다).
 *
 * ## 가로 스크롤이 `table-fixed` 대신인 이유
 *
 * 12개 값 컬럼은 어떤 창 폭에도 다 안 들어간다. `table-fixed` 로 두면 폭이
 * 재분배되지 않고 **컬럼이 조용히 잘린다** — 스크롤바조차 안 생겨 눈으로만 잡히는
 * 실패다(`state/workspace.ts` 의 investor 폭 주석이 같은 사고를 기록한다).
 * 대신 컬럼마다 최소 폭을 주고 넘치면 가로로 흐르게 하며, 날짜 컬럼과 헤더는
 * sticky 로 붙잡는다.
 */
import { useMemo } from 'react';

import { useLivePastInvestorNet } from '../../api/livePastInvestorNet';
import type { InvestorNetUnit } from '../../api/types';
import {
  formatAmount,
  formatQty,
  qtyClass,
} from '../../sidebar/InvestorTrendEstimateCard';
import { useInvestorDailySpanStore } from '../../state/investorDailySpan';
import {
  INVESTOR_ESTIMATE_UNIT_LABELS,
  useInvestorEstimateUnitStore,
  type InvestorEstimateUnit,
} from '../../state/investorEstimateUnit';
import {
  buildInvestorDailyTable,
  INVESTOR_COLUMNS,
  INVESTOR_DAILY_SPANS,
  type InvestorDailySpan,
} from '../investorDailyRows';
import { subtractDaysKst, todayKstYyyymmdd } from '../liveDateTime';

/**
 * 요청 달력 구간(일). 최장 기간 60거래일 ≈ 84달력일이고, 연휴 여유를 얹어도
 * 100행(벤더 1페이지) 안에 든다 — 그 상한을 넘기면 walk 가 페이지를 더 돈다.
 */
const REQUEST_CALENDAR_DAYS = 130;

const TOP_COLUMN_COUNT = INVESTOR_COLUMNS.filter((c) => c.group === 'top').length;
const ORGN_COLUMN_COUNT = INVESTOR_COLUMNS.length - TOP_COLUMN_COUNT;

type Props = {
  code: string;
  /** 같은 그룹 차트 창이 호버 중인 날짜(`YYYYMMDD`). 없으면 null. */
  cursorDate: string | null;
};

export function InvestorDailyWindow({ code, cursorDate }: Props) {
  const span = useInvestorDailySpanStore((s) => s.span);
  const setSpan = useInvestorDailySpanStore((s) => s.setSpan);
  const unit = useInvestorEstimateUnitStore((s) => s.unit);
  const toggleUnit = useInvestorEstimateUnitStore((s) => s.toggleUnit);

  // 오늘을 렌더마다 새로 읽지 않는다 — 자정을 넘겨도 창이 스스로 갱신되지는 않지만,
  // 매 렌더 새 문자열이면 쿼리 키가 흔들려 캐시가 무의미해진다. 날짜 경계는
  // 어차피 폴링(정규장 60초)이 넘겨 준다.
  const today = useMemo(() => todayKstYyyymmdd(), []);
  const from = useMemo(() => subtractDaysKst(today, REQUEST_CALENDAR_DAYS), [today]);

  const query = useLivePastInvestorNet(code, from, today, unit === 'amount' ? 'amount' : 'qty');
  const points = query.data?.points;
  // **데이터가 자기 단위를 말한다.** 없으면(옛 백엔드) 수량으로 읽는다 — 그게
  // 이 라우트가 축 파라미터를 갖기 전의 유일한 축이었다.
  const dataUnit: InvestorNetUnit = query.data?.unit ?? 'qty_shares';
  const table = useMemo(
    () => buildInvestorDailyTable(points ?? [], span),
    [points, span],
  );

  const stateText = getStateText(query, table.rows.length);

  return (
    <div className="flex h-full flex-col bg-bg-card">
      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <SpanChips span={span} onSelect={setSpan} />
          <UnitChip unit={unit} onToggle={toggleUnit} />
        </div>
        {/* 상태는 표가 거짓말을 하고 있을 때만 한 줄이 생긴다 — 항상 있는 크롬이면
            그게 라벨이 된다(잠정투자자 카드와 같은 방침).
            행이 없을 때는 **본문이 같은 문구를 크게 말하므로** 여기서는 뺀다 —
            둘 다 그리면 한 화면에 같은 문장이 두 번 뜬다. */}
        {table.rows.length > 0 && stateText && (
          <span className="truncate font-data text-2xs text-fg-dim">{stateText}</span>
        )}
      </div>

      {table.rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-3 py-4 text-center font-data text-xs text-fg-dim">
          {stateText ?? '일별 투자자 데이터 없음'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse font-data text-xs tabular-nums">
            <thead className="sticky top-0 z-20 text-fg-dim">
              <tr>
                <HeadCell sticky className="text-left">날짜</HeadCell>
                {/* 그룹 라벨은 **왼쪽 정렬이다 — 가운데 정렬이면 안 보인다.**
                    기관 세부는 8컬럼(493px)을 덮는데 창은 그보다 좁아서, 가운데에
                    놓으면 라벨이 늘 스크롤 밖에 선다(실측: 중심 600px vs 가시폭
                    551px). 왼쪽에 두면 구분선 바로 뒤라 그룹이 시작하는 곳에서
                    읽힌다. 이건 단위 테스트가 원리적으로 못 보는 부류다. */}
                <th
                  colSpan={TOP_COLUMN_COUNT}
                  className="border-b border-border bg-bg-card px-1.5 py-1 text-left text-2xs font-medium text-fg-dimmer"
                >
                  상위 주체 · 합 0
                </th>
                <th
                  colSpan={ORGN_COLUMN_COUNT}
                  className="border-b border-l border-border bg-bg-card px-1.5 py-1 text-left text-2xs font-medium text-fg-dimmer"
                >
                  기관 세부 · 합 = 기관계
                </th>
              </tr>
              <tr>
                <HeadCell sticky className="text-left" />
                {INVESTOR_COLUMNS.map((column, index) => (
                  <HeadCell
                    key={column.key}
                    className={index === TOP_COLUMN_COUNT ? 'border-l border-border' : undefined}
                  >
                    {column.label}
                  </HeadCell>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => {
                const isCursor = cursorDate !== null && row.date === cursorDate;
                return (
                  <tr
                    key={row.t_ms}
                    data-testid={`investor-daily-row-${row.date}`}
                    // 선택 행은 배경 틴트만 — 좌측 accent 바 금지(DESIGN.md list-row rule).
                    className={isCursor ? 'bg-tint-selection' : undefined}
                  >
                    <DateCell date={row.date} isToday={row.date === today} />
                    {INVESTOR_COLUMNS.map((column, index) => (
                      <ValueCell
                        key={column.key}
                        value={row.values[column.key]}
                        dataUnit={dataUnit}
                        className={index === TOP_COLUMN_COUNT ? 'border-l border-border' : undefined}
                      />
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="sticky bottom-0 z-20">
              <tr>
                <HeadCell sticky foot className="text-left">
                  누적
                  {table.missingBreakdown > 0 && (
                    // 조용히 작은 합계를 보여 주지 않는다 — 분해가 빠진 날이 있으면
                    // 그 컬럼들의 누적은 그만큼 덜 더해진 값이다.
                    <span
                      className="ml-1 text-2xs text-fg-dimmer"
                      title={`${table.missingBreakdown}일치 주체 분해가 없어 세부 누적에서 빠졌습니다`}
                    >
                      −{table.missingBreakdown}일
                    </span>
                  )}
                </HeadCell>
                {INVESTOR_COLUMNS.map((column, index) => (
                  <ValueCell
                    key={column.key}
                    value={table.totals[column.key]}
                    dataUnit={dataUnit}
                    foot
                    className={index === TOP_COLUMN_COUNT ? 'border-l border-border' : undefined}
                  />
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

/** 기간 칩. 누르면 표시 구간만 바뀐다 — 서버 왕복이 없다(위 도크스트링). */
function SpanChips({
  span,
  onSelect,
}: {
  span: InvestorDailySpan;
  onSelect: (value: InvestorDailySpan) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1" role="group" aria-label="표시 기간">
      {INVESTOR_DAILY_SPANS.map((value) => {
        const active = value === span;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            aria-pressed={active}
            className={`rounded border px-1.5 py-px text-2xs leading-normal transition-colors ${
              active
                ? 'border-accent text-accent'
                : 'border-border text-fg-dim hover:border-border-strong hover:text-fg'
            }`}
          >
            {value}일
          </button>
        );
      })}
    </div>
  );
}

function HeadCell({
  children,
  className = '',
  sticky = false,
  foot = false,
}: {
  children?: React.ReactNode;
  className?: string;
  sticky?: boolean;
  foot?: boolean;
}) {
  // 배경을 tr/thead 가 아니라 셀마다 주는 이유: border-collapse 표에서는 그 배경이
  // sticky 헤더를 따라오지 않아 스크롤되는 행이 뒤로 비친다(잠정투자자 표와 동일).
  const edge = foot ? 'border-t' : 'border-b';
  return (
    <th
      scope="col"
      className={`whitespace-nowrap ${edge} border-border bg-bg-card px-1.5 py-1 text-right font-medium ${
        sticky ? 'sticky left-0 z-10' : ''
      } ${className}`}
    >
      {children}
    </th>
  );
}

function DateCell({ date, isToday }: { date: string; isToday: boolean }) {
  return (
    <th
      scope="row"
      className="sticky left-0 z-10 whitespace-nowrap bg-bg-card px-1.5 py-1 text-left font-normal text-fg-dim"
    >
      {`${date.slice(4, 6)}-${date.slice(6)}`}
      {isToday && (
        // 오늘 행은 ~15:40 까지 가집계다 — 확정치와 같은 표에 있으므로 구분한다.
        <span className="ml-1 text-2xs text-fg-dimmer" title="장중 잠정치 (확정 전)">
          잠정
        </span>
      )}
    </th>
  );
}

function ValueCell({
  value,
  dataUnit,
  className = '',
  foot = false,
}: {
  value: number | null;
  /** **응답이 말한 단위** — 토글이 아니다(위 도크스트링). */
  dataUnit: InvestorNetUnit;
  className?: string;
  foot?: boolean;
}) {
  // 값 없음(분해 부재)은 0 이 아니라 공백이다 — `formatQty` 의 '-' 를 쓰면 0 과
  // 헷갈리지 않지만, 표 전체가 '-' 로 덮이면 노이즈라 흐린 색으로 눕힌다.
  return (
    <td
      className={`whitespace-nowrap px-1.5 py-1 text-right ${
        foot ? 'border-t border-border bg-bg-card font-medium' : ''
      } ${qtyClass(value)} ${className}`}
    >
      {value === null ? '' : formatCell(value, dataUnit)}
    </td>
  );
}

/** 단위별 포맷 분기 SSOT. `amt_eok`(지수 경로)는 이 창에 오지 않지만 union 이
 *  하나라 남겨 둔다 — 억원 값을 백만원 포맷터에 넣으면 100배 작아진다. */
function formatCell(value: number, dataUnit: InvestorNetUnit): string {
  if (dataUnit === 'qty_shares') return formatQty(value);
  if (dataUnit === 'amt_mwon') return formatAmount(value);
  // amt_eok — 이미 억이므로 백만원으로 되돌린 뒤 같은 포맷터를 태운다.
  return formatAmount(value * 100);
}

/** 단위 칩 — 잠정투자자 카드와 **같은 스토어**를 쓴다(위 도크스트링).
 *  눌림 상태는 스토어를 따르고, 셀 숫자는 응답을 따른다. */
function UnitChip({
  unit,
  onToggle,
}: {
  unit: InvestorEstimateUnit;
  onToggle: () => void;
}) {
  const isAmount = unit === 'amount';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isAmount}
      aria-label={`표시 단위 ${isAmount ? '금액' : '수량'}, 누르면 ${isAmount ? '수량' : '금액'}`}
      title={isAmount ? '금액(억원) — 누르면 수량(주)' : '수량(주) — 누르면 금액(억원)'}
      className={`shrink-0 rounded border px-1.5 py-px text-2xs leading-normal transition-colors ${
        isAmount
          ? 'border-accent text-accent'
          : 'border-border text-fg-dim hover:border-border-strong hover:text-fg'
      }`}
    >
      {INVESTOR_ESTIMATE_UNIT_LABELS[unit]}
    </button>
  );
}

function getStateText(
  query: ReturnType<typeof useLivePastInvestorNet>,
  rowCount: number,
): string | null {
  if (query.isLoading && !query.data) return '조회 중';
  if (query.error) return '조회 실패';
  if (query.data && rowCount === 0) return '일별 투자자 데이터 없음';
  return null;
}

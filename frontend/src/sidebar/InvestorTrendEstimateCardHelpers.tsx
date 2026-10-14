import type { LiveInvestorTrendEstimateRow } from '../api/liveInvestorTrendEstimate';


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


export const quantityFormatter = new Intl.NumberFormat('ko-KR');

export const amountFormatters = [0, 1].map((maximumFractionDigits) =>
  new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits }));


/** 추정 수급 **수량**(주) 표시 — 축약하지 않는다(2026-08-04 사용자 결정).
 *  20,000 은 "2만" 이 아니라 "20,000" 이다. 가집계가 천주 단위로 반올림돼 오므로
 *  자릿수가 길어도 뒤 세 자리는 항상 0 이고, 만 단위 축약은 그 반올림 위에 반올림을
 *  한 겹 더 얹어 -1,925,000 을 "-193만"(= -1,930,000)으로 만들었다.
 *  예: -1,925,000 → "-1,925,000", 1,500 → "+1,500". */
export function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value === 0) return '0';
  return `${value > 0 ? '+' : ''}${quantityFormatter.format(value)}`;
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
  const body = amountFormatters[digits].format(rounded);
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


export function formatAggregationOrdinal(slot: string, index: number): string {
  const normalized = slot.trim();
  if (/^\d{1,2}$/.test(normalized)) return String(Number(normalized));
  return String(index + 1);
}


export function formatSlotFallback(slot: string): string {
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


export function formatHourMinute(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

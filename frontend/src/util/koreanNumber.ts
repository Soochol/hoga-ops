const koreanNumber = new Intl.NumberFormat('ko-KR');
const koreanFractions = [0, 1, 2].map((maximumFractionDigits) =>
  new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits }));

/** 차트 값 표시용 공유 정수 포맷터 — 거래량·순매수·Pane Legend 공통.
 *  반올림 후 ko-KR 천단위 구분(예: 311400 → "311,400", -1061741 → "-1,061,741"). */
export const formatKoreanInt = (v: number): string =>
  koreanNumber.format(Math.round(v));

/** 수량을 천 단위 K로 표시한다. 거래량 및 투자자 수량 축·레전드 공통. */
export const formatKoreanK = (v: number): string =>
  `${koreanNumber.format(Math.round(v / 1000))}K`;

/** 원화 금액을 국내 주식 UI에서 읽기 쉬운 억 단위로 표시한다.
 *  예: 169039074500 → "1,690억", -806001750 → "-8.1억". */
export function formatKoreanWonEok(value: number): string {
  if (!Number.isFinite(value)) return '0억';
  const eok = value / 100_000_000;
  const abs = Math.abs(eok);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const roundedValue = Object.is(Number(eok.toFixed(digits)), -0)
    ? 0
    : Number(eok.toFixed(digits));
  const rounded = koreanFractions[digits].format(roundedValue);
  return `${rounded}억`;
}

/** 차트 값 표시용 공유 정수 포맷터 — 거래량·순매수·Pane Legend 공통.
 *  반올림 후 ko-KR 천단위 구분(예: 311400 → "311,400", -1061741 → "-1,061,741"). */
export const formatKoreanInt = (v: number): string =>
  Math.round(v).toLocaleString('ko-KR');

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
  const rounded = roundedValue.toLocaleString('ko-KR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${rounded}억`;
}

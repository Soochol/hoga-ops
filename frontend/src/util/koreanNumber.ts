/** 차트 값 표시용 공유 정수 포맷터 — 거래량·순매수·Pane Legend 공통.
 *  반올림 후 ko-KR 천단위 구분(예: 311400 → "311,400", -1061741 → "-1,061,741"). */
export const formatKoreanInt = (v: number): string =>
  Math.round(v).toLocaleString('ko-KR');

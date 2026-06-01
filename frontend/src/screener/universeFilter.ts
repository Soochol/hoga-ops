import type { ScreenerUniverse } from '../api/screener';

// 트리거 버튼 배지 카운트 — 활성 "축" 개수(0~3). 시장은 단일 축으로 취급
// (KOSPI/KOSDAQ 둘 다 선택해도 1; 실질 제한 없음이지만 사용자가 명시 토글했으니
// 활성으로 표시 — spec §배지 카운트 승인된 단순 규칙).
export function countActiveUniverse(u: ScreenerUniverse): number {
  return (u.markets?.length ? 1 : 0) + (u.exclude_etf ? 1 : 0) + (u.exclude_halted ? 1 : 0);
}

// aria-label/title 보조 — 닫힌 모달의 활성 상태를 풀어 표기(spec 그릴 #2).
// 읽기 순서: 시장 → ETF 제외 → 거래정지 제외.
export function universeSummary(u: ScreenerUniverse): string {
  const parts: string[] = [];
  if (u.markets?.length) parts.push(u.markets.join('·'));
  if (u.exclude_etf) parts.push('ETF 제외');
  if (u.exclude_halted) parts.push('거래정지 제외');
  return parts.join(' · ');
}

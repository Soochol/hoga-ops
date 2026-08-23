import type { ScreenerUniverse } from '../api/screener';

// 트리거 버튼 배지 카운트 — 활성 "축" 개수(0~3). 시장은 단일 축으로 취급
// (KOSPI/KOSDAQ 둘 다 선택해도 1; 실질 제한 없음이지만 사용자가 명시 토글했으니
// 활성으로 표시 — spec §배지 카운트 승인된 단순 규칙).
export function countActiveUniverse(u: ScreenerUniverse): number {
  return (u.markets?.length ? 1 : 0) + (isEtfIncluded(u) ? 1 : 0) + (u.exclude_halted ? 1 : 0);
}

/**
 * ETF·ETN 이 **포함**돼 있는가 — 즉 기본에서 벗어났는가.
 *
 * 2026-08-23 부터 백엔드 기본이 `exclude_etf: true`(제외)다. 그래서 배지·요약이
 * 표시할 것이 뒤집힌다: 「ETF 제외」는 이제 기본이라 말할 것이 없고, **포함**시킨
 * 상태가 사용자가 알아야 할 일탈이다. 키 부재는 기본(제외)이므로 `?? true`.
 */
export function isEtfIncluded(u: ScreenerUniverse): boolean {
  return (u.exclude_etf ?? true) === false;
}

// aria-label/title 보조 — 닫힌 모달의 활성 상태를 풀어 표기(spec 그릴 #2).
// 읽기 순서: 시장 → ETF 포함 → 거래정지 제외.
export function universeSummary(u: ScreenerUniverse): string {
  const parts: string[] = [];
  if (u.markets?.length) parts.push(u.markets.join('·'));
  if (isEtfIncluded(u)) parts.push('ETF 포함');
  if (u.exclude_halted) parts.push('거래정지 제외');
  return parts.join(' · ');
}

/**
 * 전체 접기/펼치기 아이콘 — 그룹 목록을 한 번에 접거나 펴는 툴바 버튼용.
 * 개별 그룹 헤더의 {@link ChevronIcon} 과 짝을 이루는 "일괄" 어포던스로, 가운데 선을
 * 향해 모이는 두 겹 화살표(접기) / 바깥으로 벌어지는 두 겹 화살표(펼치기)다.
 *
 * 저장뷰 드로어 로컬 정의였으나 히트맵·관심종목 드로어가 3·4번째 소비처가 되면서
 * 중립 ui/ 로 승격했다(ChevronIcon 이 같은 경로를 밟은 선례 — 소비처 3개에서 추출).
 * 아이콘은 표현만 담당하고, "지금 전체가 접혀 있는가" 판정과 토글은 호출부가 소유한다.
 */
export function CollapseAllIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 8h10" />
      <path d="M9 4h6" />
      <path d="M9 12h6" />
      <path d="m8 17 4-4 4 4" />
      <path d="m8 20 4-4 4 4" />
    </svg>
  );
}

export function ExpandAllIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 8h10" />
      <path d="M9 4h6" />
      <path d="M9 20h6" />
      <path d="m8 13 4 4 4-4" />
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}

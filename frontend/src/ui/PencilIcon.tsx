/** 이름 변경(연필) 아이콘 — 컨텍스트 메뉴 항목용 1em 글리프.
 *  ChevronIcon·TrashIcon 과 같은 중립 ui/ 프리미티브(ADR-0110 의 이관 근거).
 *  히트맵·저장뷰·관심종목 드로어가 각자 같은 path 를 복제해 갖고 있었다 — 그 이관은
 *  한동안 미완이어서 이 파일이 생긴 뒤에도 지역 사본 3개가 남아 있었다. 지금은 네 소비처
 *  (HeatmapGroupMenu·HeatmapDrawer·StudyViewRowMenu·WatchlistDrawer)가 모두 이걸 쓴다. */
export function PencilIcon({ className = 'w-[1em] h-[1em]' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

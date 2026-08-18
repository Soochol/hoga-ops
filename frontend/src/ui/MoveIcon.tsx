/** 이동(좌우 화살표) 아이콘 — 다중 선택 항목을 다른 그룹으로 옮기는 액션용 1em 글리프.
 *  ChevronIcon·TrashIcon·PencilIcon 과 같은 중립 ui/ 프리미티브(ADR-0110 의 이관 근거).
 *  유니코드 `⇄` 를 대체한다 — 문자 글리프는 폰트마다 다르게 렌더되고 색 토큰도
 *  따르지 않는다(WatchlistDrawer 의 MenuGlyph 가 ✎▲▼ 를 SVG 로 바꾼 것과 같은 근거). */
export function MoveIcon({ className = 'w-[1em] h-[1em]' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h15" />
      <path d="M15 4l4 4-4 4" />
      <path d="M21 16H6" />
      <path d="M9 12l-4 4 4 4" />
    </svg>
  );
}

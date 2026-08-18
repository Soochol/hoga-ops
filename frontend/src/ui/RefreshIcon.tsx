/** 재수집(회전 화살표) 아이콘 — 종목 하나를 다시 수집하는 액션용 1em 글리프.
 *  ChevronIcon·TrashIcon·PencilIcon 과 같은 중립 ui/ 프리미티브(ADR-0110 의 이관 근거).
 *  유니코드 `↻` 를 대체한다.
 *
 *  **회전 애니메이션은 이 아이콘에 건다**(`className="animate-spin"`) — 감싸는 버튼에
 *  걸면 패딩까지 함께 돌고, 문자 글리프 시절엔 baseline 기준이라 회전축이 글자 아래로
 *  치우쳤다. SVG 는 viewBox 중심으로 돌아 축이 맞는다. */
export function RefreshIcon({ className = 'w-[1em] h-[1em]' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3.5V9h-5.5" />
    </svg>
  );
}

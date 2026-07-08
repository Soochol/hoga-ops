export type SortDirection = 'none' | 'asc' | 'desc';

/**
 * 우측 패널 전역 통합 정렬 아이콘 — 관심종목·스크리너·저장뷰가 공유해 시각 언어를
 * 하나로 맞춘다. 왼쪽 3-단 그래듀에이션 막대(정렬 정체성) + 오른쪽 방향 화살표.
 *
 * - none: 막대만(dim) — "정렬 가능/미적용"
 * - asc : 막대 + 위 화살표 — 오름차순
 * - desc: 막대 + 아래 화살표 — 내림차순
 *
 * 정렬 *키*(등락률/이름)는 문맥+aria/title 이 전달하므로 아이콘은 방향만 담당한다.
 * data-testid=`sort-icon-{default|asc|desc}` 는 기존 계약 유지(none→default).
 */
export function SortDirectionIcon({
  direction,
  className,
}: {
  direction: SortDirection;
  className?: string;
}) {
  const testKey = direction === 'asc' ? 'asc' : direction === 'desc' ? 'desc' : 'default';
  return (
    <svg
      data-testid={`sort-icon-${testKey}`}
      data-sort-icon={direction}
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 정렬 정체성 막대 — 길이 그래듀에이션(long→short) */}
      <path d="M4 7h9" />
      <path d="M4 12h6" />
      <path d="M4 17h3" />
      {/* 방향 화살표 — 없으면 미표시 */}
      {direction !== 'none' && (
        <>
          <path d="M18 6v12" />
          <path d={direction === 'asc' ? 'm15 9 3-3 3 3' : 'm15 15 3 3 3-3'} />
        </>
      )}
    </svg>
  );
}

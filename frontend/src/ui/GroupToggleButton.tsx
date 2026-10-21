/** 우측 패널의 전체 그룹 접기/펼치기. 상태 판정은 각 패널이 소유한다. */
export function GroupToggleButton({
  allCollapsed,
  onToggle,
  disabled = false,
  testId,
  title,
}: {
  allCollapsed: boolean;
  onToggle: () => void;
  disabled?: boolean;
  testId: string;
  title?: string;
}) {
  const label = allCollapsed ? '전체 펼치기' : '전체 접기';
  return (
    <button type="button" data-testid={testId} aria-label={label} title={title ?? label}
      onClick={onToggle} disabled={disabled}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-dim hover:bg-bg-input-hover hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-safe:transition-colors motion-safe:duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim">
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {allCollapsed ? <>
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </> : <>
          <path d="m7 20 5-5 5 5" />
          <path d="m7 4 5 5 5-5" />
        </>}
      </svg>
    </button>
  );
}

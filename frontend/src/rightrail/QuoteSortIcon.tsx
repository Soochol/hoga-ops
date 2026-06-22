import type { QuoteSortMode } from './quoteSort';

export function QuoteSortIcon({ mode }: { mode: QuoteSortMode | undefined }) {
  const iconMode = mode ?? 'default';
  return (
    <svg
      data-testid={`sort-icon-${iconMode === 'change_pct_asc' ? 'asc' : iconMode === 'change_pct_desc' ? 'desc' : 'default'}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconMode === 'default' ? (
        <>
          <path d="M5 7h14" />
          <path d="M5 12h14" />
          <path d="M5 17h14" />
        </>
      ) : (
        <>
          <path d="M4 7h10" />
          <path d="M4 12h7" />
          <path d="M4 17h4" />
          <path d="M17 6v12" />
          <path d={iconMode === 'change_pct_asc' ? 'M14 9l3-3 3 3' : 'M14 15l3 3 3-3'} />
        </>
      )}
    </svg>
  );
}

export function quoteSortModeDescription(mode: QuoteSortMode | undefined): string {
  if (mode === 'change_pct_asc') return '현재 등락률 오름차순, 클릭하면 등락률 내림차순';
  if (mode === 'change_pct_desc') return '현재 등락률 내림차순, 클릭하면 기본 정렬';
  return '현재 기본 정렬, 클릭하면 등락률 오름차순';
}

import type { QuoteSortMode } from './quoteSort';

export function quoteSortModeDescription(mode: QuoteSortMode | undefined): string {
  if (mode === 'change_pct_desc') return '현재 등락률 내림차순, 클릭하면 등락률 오름차순';
  if (mode === 'change_pct_asc') return '현재 등락률 오름차순, 클릭하면 기본 정렬';
  return '현재 기본 정렬, 클릭하면 등락률 내림차순';
}

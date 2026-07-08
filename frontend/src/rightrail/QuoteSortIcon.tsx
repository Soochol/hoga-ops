import type { QuoteSortMode } from './quoteSort';
import { SortDirectionIcon, type SortDirection } from '../ui/SortDirectionIcon';

/** QuoteSortMode(등락률 3-상태) → 통합 정렬 아이콘 방향. */
function toDirection(mode: QuoteSortMode | undefined): SortDirection {
  if (mode === 'change_pct_asc') return 'asc';
  if (mode === 'change_pct_desc') return 'desc';
  return 'none';
}

/** 관심종목·스크리너 정렬 아이콘 — 통합 SortDirectionIcon 위임(시각 언어 단일화). */
export function QuoteSortIcon({ mode, className }: { mode: QuoteSortMode | undefined; className?: string }) {
  return <SortDirectionIcon direction={toDirection(mode)} className={className} />;
}

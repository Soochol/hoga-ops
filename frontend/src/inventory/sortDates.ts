import type { StockDate } from '../api/types';
import { STATE_SEVERITY } from './DiskStateBadge';

export type SortKey =
  | 'state' | 'date' | 'captured' | 'volume' | 'pages' | 'size' | 'ohlc'
  | 'fullCaptureCount';
export type SortDir = 'asc' | 'desc';
/** null = unsorted = 기본 date desc (useStockDateGroups가 이미 적용한 순서). */
export type SortState = { key: SortKey; dir: SortDir } | null;

type Comparable = number | string;

function keyOf(row: StockDate, key: SortKey): Comparable {
  switch (key) {
    case 'state':    return STATE_SEVERITY[row.disk_state];
    case 'date':     return row.date; // YYYYMMDD — 문자열 비교가 정확
    case 'captured': return row.captured_at;
    case 'volume':   return row.total_volume;
    case 'pages':    return row.pages_collected;
    case 'size':     return row.file_size_bytes;
    case 'ohlc':     return row.today_close;
    case 'fullCaptureCount':
      // Handled by the null-last branch in sortDates(); unreachable here.
      throw new Error('fullCaptureCount handled separately');
  }
}

function compare(a: Comparable, b: Comparable): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * sort === null이면 입력 그대로 반환(useStockDateGroups가 이미 date desc로 줌).
 * 그 외엔 새 배열 반환(입력 mutation 없음). 동률(tie)은 sort.key가 'date'가 아닐 때만
 * date desc로 깬다.
 */
export function sortDates(dates: StockDate[], sort: SortState): StockDate[] {
  if (sort === null) return dates;
  const copy = [...dates];
  const mult = sort.dir === 'asc' ? 1 : -1;
  copy.sort((a, b) => {
    // Null-last special case: fullCaptureCount nulls always go to the end.
    if (sort.key === 'fullCaptureCount') {
      const av = a.full_capture_count;
      const bv = b.full_capture_count;
      if (av === null && bv === null) return compare(b.date, a.date);
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = compare(av, bv);
      if (cmp !== 0) return cmp * mult;
      return compare(b.date, a.date);
    }
    const cmp = compare(keyOf(a, sort.key), keyOf(b, sort.key));
    if (cmp !== 0) return cmp * mult;
    if (sort.key === 'date') return 0;
    // 보조 정렬: date desc
    return compare(b.date, a.date);
  });
  return copy;
}

/**
 * 3-state 토글:
 *   null + click(X)        → { X, desc }
 *   { X, desc } + click(X) → { X, asc }
 *   { X, asc }  + click(X) → null
 *   any         + click(Y) → { Y, desc }   (다른 컬럼은 desc로 점프)
 */
export function nextSortState(current: SortState, clicked: SortKey): SortState {
  if (current === null || current.key !== clicked) {
    return { key: clicked, dir: 'desc' };
  }
  if (current.dir === 'desc') return { key: clicked, dir: 'asc' };
  return null;
}

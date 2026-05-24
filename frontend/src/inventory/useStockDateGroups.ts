import { useMemo } from 'react';
import type { StockDate } from '../api/types';
import type { StockDateGroup } from './types';
import { groupStockDatesByCode } from './groupByCode';

/**
 * Inventory 페이지의 좌측 리스트 정책:
 * - 그룹 정렬: lastCapturedAt desc (최근 캡처 먼저)
 * - 자식 dates: date desc
 * - 검색: name 부분 매칭 또는 code 부분 매칭, 대소문자/공백 무시
 */
export function useStockDateGroups(rows: StockDate[], search: string): StockDateGroup[] {
  return useMemo(() => {
    const groups = groupStockDatesByCode(rows);
    for (const g of groups) g.dates.sort((a, b) => b.date.localeCompare(a.date));
    groups.sort((a, b) => b.lastCapturedAt - a.lastCapturedAt);

    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q) || g.code.includes(q));
  }, [rows, search]);
}

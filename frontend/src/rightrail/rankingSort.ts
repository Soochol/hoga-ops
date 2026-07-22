import type { SortDirection } from '../ui/SortDirectionIcon';
import type { RankingRow } from '../api/liveRankings';

/**
 * 순위 드로어의 클라이언트 정렬 — 현재 표시된 리스트를 등락률순으로 재정렬한다.
 * TR 은 자기 지표(거래량·대금·급증률)로 정렬해 내려오므로, 사용자가 그 리스트를
 * "지금 등락률이 큰 순"으로 다시 보고 싶을 때 쓴다(스크리너 sortResults 와 같은
 * 3-상태 순환이지만, 의존 방향상 screener/ 를 import 할 수 없어 rightrail-로컬로 둔다).
 *
 * 순위번호(row.rank)는 TR 고유 순위라 재정렬해도 그대로 배지에 남긴다 — 거래량 12위가
 * 등락률 정렬 최상단에 뜨는 것이 이 기능의 분석 가치(교차지표 이상치 노출).
 */
export type RankingSortMode = 'default' | { field: 'change_pct'; direction: 'asc' | 'desc' };

/** default → 등락률↓ → 등락률↑ → default 순환(스크리너와 동일). */
export function nextRankingSortMode(mode: RankingSortMode): RankingSortMode {
  if (mode === 'default') return { field: 'change_pct', direction: 'desc' };
  if (mode.direction === 'desc') return { field: 'change_pct', direction: 'asc' };
  return 'default';
}

export function rankingSortDirection(mode: RankingSortMode): SortDirection {
  return mode === 'default' ? 'none' : mode.direction;
}

export function rankingSortDescription(mode: RankingSortMode): string {
  if (mode === 'default') return '현재 순위 기본 순서, 클릭하면 등락률 높은 순';
  if (mode.direction === 'desc') return '현재 등락률 높은 순, 클릭하면 등락률 낮은 순';
  return '현재 등락률 낮은 순, 클릭하면 기본 순서';
}

/** null 등락률(파싱실패·장전)은 항상 뒤로, 동값은 원래 순서 유지(안정 정렬). */
export function sortRankingRows(rows: readonly RankingRow[], mode: RankingSortMode): RankingRow[] {
  if (mode === 'default') return [...rows];
  const dir = mode.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, order) => ({ row, order, value: row.change_pct }))
    .sort((a, b) => {
      const av = typeof a.value === 'number' && Number.isFinite(a.value) ? a.value : null;
      const bv = typeof b.value === 'number' && Number.isFinite(b.value) ? b.value : null;
      if (av == null && bv == null) return a.order - b.order;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av === bv ? a.order - b.order : (av - bv) * dir;
    })
    .map((entry) => entry.row);
}

import type { FolderGroup } from '../watchlist/grouping';
import type { HeatmapEntry } from '../api/heatmap';

/** 드로어 목록 필터. 대소문자 무시 부분일치.
 *  - 그룹명이 매칭되면 그 그룹 전체(모든 종목)를 표시한다.
 *  - 아니면 종목명 또는 코드가 매칭되는 행만 남기고, 매칭이 없는 그룹은 통째로 뺀다.
 *  - 빈 쿼리(공백 포함)면 원본 그대로 반환(참조 동일 — 재정렬/재렌더 노이즈 없음).
 *  순수 함수 — 정렬(orderFolderGroups/sortEntries)과 직교하게 그 사이 단계로 끼운다. */
export function filterGroups(
  groups: FolderGroup<HeatmapEntry>[],
  query: string,
): FolderGroup<HeatmapEntry>[] {
  const q = query.trim().toLowerCase();
  if (q === '') return groups;

  const result: FolderGroup<HeatmapEntry>[] = [];
  for (const g of groups) {
    const groupName = g.folder?.name ?? '미분류';
    if (groupName.toLowerCase().includes(q)) {
      // 그룹명 매칭 → 그룹 전체 유지(엔트리 배열 참조 그대로).
      result.push(g);
      continue;
    }
    const matched = g.entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.code.toLowerCase().includes(q),
    );
    if (matched.length > 0) result.push({ folder: g.folder, entries: matched });
  }
  return result;
}

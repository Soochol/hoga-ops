import type { HeatmapGroup } from './heat';
import type { HeatmapEntry } from '../api/heatmap';

/** 종목 하나가 쿼리에 매칭되는가 — 이름 또는 코드 부분일치(대소문자 무시).
 *  filterGroups(그룹 표시 여부)와 화면 하이라이트(매칭 행 강조)가 공유하는 단일
 *  술어. 빈 쿼리면 false(하이라이트 없음). */
export function entryMatchesQuery(entry: HeatmapEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return false;
  return entry.name.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q);
}

/** 목록 필터. 대소문자 무시 부분일치.
 *  - 그룹명이 매칭되거나, 종목이 하나라도 매칭되면 그 그룹 **전체(모든 종목)**를
 *    유지한다. 매칭 행만 남기지 않는다 — 매칭은 화면에서 하이라이트로 강조하고
 *    나머지 종목은 그룹 맥락으로 함께 보여준다(entryMatchesQuery 로 판정).
 *  - 매칭이 전혀 없는 그룹만 통째로 뺀다.
 *  - 빈 쿼리(공백 포함)면 원본 그대로 반환(참조 동일 — 재정렬/재렌더 노이즈 없음).
 *  순수 함수 — 정렬(orderFolderGroups/sortEntries)과 직교하게 그 사이 단계로 끼운다. */
export function filterGroups(
  groups: HeatmapGroup[],
  query: string,
): HeatmapGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return groups;
  return groups.filter(
    (g) =>
      g.folder.name.toLowerCase().includes(q) ||
      g.entries.some((e) => entryMatchesQuery(e, q)),
  );
}

import type { HeatmapGroup } from './heat';

/** 보드에 표시할 그룹: 비어있지 않은 모든 그룹. 헤더의 종목 수 카운트(Heatmap)와
 *  실제 렌더(HeatmapBoard)가 같은 정의를 쓰도록 하는 단일 출처 — 한쪽만 바뀌어
 *  카운트와 표시가 어긋나는 드리프트를 막는다.
 *  v3 (ADR-0112): 미분류(null 그룹)는 존재하지 않는다 — 모든 그룹이 실폴더라
 *  "빈 그룹만 제외" 규칙 하나로 충분하다.
 *  컴포넌트 파일이 아닌 별도 모듈에 둔다(react-refresh/only-export-components 준수). */
export function visibleFolderGroups(groups: HeatmapGroup[]): HeatmapGroup[] {
  return groups.filter((g) => g.entries.length > 0);
}

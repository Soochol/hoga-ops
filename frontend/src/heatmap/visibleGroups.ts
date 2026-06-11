import type { FolderGroup } from '../watchlist/grouping';

/** 보드에 표시할 그룹: 비어있지 않은 모든 그룹(미분류 포함). 헤더의 종목 수
 *  카운트(Heatmap)와 실제 렌더(HeatmapBoard)가 같은 정의를 쓰도록 하는 단일 출처 —
 *  한쪽만 바뀌어 카운트와 표시가 어긋나는 드리프트를 막는다.
 *  ADR-0068(그릴링 G3): 분리 후 히트맵은 관심종목과 독립이고, 새로 추가한 종목은 항상
 *  미분류(folder_id=null)로 먼저 들어간다. 미분류 그룹을 숨기면 "추가했는데 안 보임"
 *  사일런트 버그가 되므로, 비어있지 않은 미분류를 별도 그룹으로 표시한다(빈 그룹만 제외).
 *  컴포넌트 파일이 아닌 별도 모듈에 둔다(react-refresh/only-export-components 준수). */
export function visibleFolderGroups(groups: FolderGroup[]): FolderGroup[] {
  return groups.filter((g) => g.entries.length > 0);
}

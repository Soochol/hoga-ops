import type { FolderGroup } from '../watchlist/grouping';

/** 보드에 표시할 폴더 그룹: 빈 폴더·미분류(folder===null) 제외. 헤더의 종목 수
 *  카운트(Heatmap)와 실제 렌더(HeatmapBoard)가 같은 정의를 쓰도록 하는 단일 출처 —
 *  한쪽만 바뀌어 카운트와 표시가 어긋나는 드리프트를 막는다. 컴포넌트 파일이 아닌
 *  별도 모듈에 둔다(react-refresh/only-export-components 준수). */
export function visibleFolderGroups(groups: FolderGroup[]): FolderGroup[] {
  return groups.filter((g) => g.folder !== null && g.entries.length > 0);
}

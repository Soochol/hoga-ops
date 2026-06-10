import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapFolder } from './HeatmapFolder';
import type { SortMode } from './heat';

export interface HeatmapBoardProps {
  groups: FolderGroup[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string) => void;
}

/** 보드에 표시할 폴더 그룹: 빈 폴더·미분류(folder===null) 제외. 헤더의 종목 수
 *  카운트(Heatmap)와 실제 렌더(보드)가 같은 정의를 쓰도록 하는 단일 출처 —
 *  한쪽만 바뀌어 카운트와 표시가 어긋나는 드리프트를 막는다. */
export function visibleFolderGroups(groups: FolderGroup[]): FolderGroup[] {
  return groups.filter((g) => g.folder !== null && g.entries.length > 0);
}

/** 신문형 멀티칼럼 보드. 빈 폴더·미분류(folder===null) 제외. columnWidth 로
 *  가용 폭만큼 칼럼 수가 자동 결정된다(순수 CSS 메이슨리, 레이아웃 JS 없음). */
export function HeatmapBoard({ groups, quoteByCode, sortMode, onPick }: HeatmapBoardProps) {
  const visible = visibleFolderGroups(groups);
  return (
    // eng-review Q6: 스크롤 컨테이너(바깥, 높이 한정)와 multicol 블록(안쪽, height
    // auto)을 분리한다. 같은 요소에 overflow-y-auto + column-width 를 두면 높이
    // 고정 multicol 이 칼럼을 세로로 꽉 채우다 가로 오버플로/단일 칼럼으로 깨진다.
    // 바깥이 세로 스크롤, 안쪽이 콘텐츠 높이 기준 신문형 균형 패킹.
    <div className="flex-1 overflow-y-auto p-2">
      <div style={{ columnWidth: '228px', columnGap: '8px' }}>
        {visible.map((g) => (
          <HeatmapFolder
            key={g.folder!.id}
            folder={g.folder!}
            entries={g.entries}
            quoteByCode={quoteByCode}
            sortMode={sortMode}
            onPick={onPick}
          />
        ))}
      </div>
    </div>
  );
}

import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapFolder } from './HeatmapFolder';
import { visibleFolderGroups } from './visibleGroups';
import type { SortMode } from './heat';

export interface HeatmapBoardProps {
  groups: FolderGroup[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string) => void;
}

/** 신문형 멀티칼럼 보드. 빈 폴더·미분류(folder===null) 제외. columnWidth 로
 *  가용 폭만큼 칼럼 수가 자동 결정된다(순수 CSS 메이슨리, 레이아웃 JS 없음).
 *  columnWidth 는 행 그리드의 최소폭(이름 4rem + 현재가 3.2rem + 등락률 2.8rem +
 *  갭·패딩 ≈ 12rem)에 맞춘 rem 값 — 이보다 좁으면 행 그리드가 칼럼을 넘쳐 이름이
 *  짜부되므로 floor 역할. 화면이 넓어지면 multicol 이 칼럼 수를 늘리고, 남는 폭은
 *  각 행의 minmax(...,1fr) 종목명으로 흘러가 이름이 더 길게 보인다(반응형). */
export function HeatmapBoard({ groups, quoteByCode, sortMode, onPick }: HeatmapBoardProps) {
  const visible = visibleFolderGroups(groups);
  return (
    // eng-review Q6: 스크롤 컨테이너(바깥, 높이 한정)와 multicol 블록(안쪽, height
    // auto)을 분리한다. 같은 요소에 overflow-y-auto + column-width 를 두면 높이
    // 고정 multicol 이 칼럼을 세로로 꽉 채우다 가로 오버플로/단일 칼럼으로 깨진다.
    // 바깥이 세로 스크롤, 안쪽이 콘텐츠 높이 기준 신문형 균형 패킹.
    <div className="flex-1 overflow-y-auto p-2">
      <div style={{ columnWidth: '12rem', columnGap: '0.5rem' }}>
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

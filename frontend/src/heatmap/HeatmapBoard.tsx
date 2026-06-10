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
 *  columnWidth 는 행 그리드의 최소폭(이름 4rem + 현재가 3.2rem + 등락률 칩 4.25rem +
 *  갭·패딩, 실측 카드 min-content ≈ 12.3rem)에 맞춘 12rem floor — multicol 이 깨지지
 *  않는 카드(break-inside-avoid)를 칼럼에 맞춰 키우므로 1100~1820px 전 구간 오버플로
 *  없음(실측). 넓어지면 칼럼 수↑, 남는 폭은 minmax(...,1fr) 종목명으로(반응형). */
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

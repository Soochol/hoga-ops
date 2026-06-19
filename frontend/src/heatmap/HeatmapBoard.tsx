import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import type { LiveOpenDisposition } from '../live/liveActivation';
import type { HeatmapEntry } from '../api/heatmap';
import { HeatmapFolder, type RowMenuOpener } from './HeatmapFolder';
import { visibleFolderGroups } from './visibleGroups';
import type { SortMode } from './heat';

export interface HeatmapBoardProps {
  groups: FolderGroup<HeatmapEntry>[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string, name?: string, options?: { disposition?: LiveOpenDisposition }) => void;
  /** 그룹 내 드래그 재정렬 커밋(manual 모드). folderId=null 은 미분류 그룹.
   *  페이지에서 useReorderHeatmapEntries 로 주입. */
  onReorder?: (folderId: string | null, orderedCodes: string[]) => void;
  /** 행 우클릭 메뉴(삭제·폴더이동) 오프너. 페이지에서 주입. */
  onRowMenu?: RowMenuOpener;
  /** 행 드래그 시작/끝을 페이지로 전파(그룹순서 동결용, G1). manual 모드에서만 발화. */
  onRowDragState?: (dragging: boolean) => void;
}

/** 신문형 멀티칼럼 보드. 빈 그룹만 제외(미분류 포함 — ADR-0068 G3). columnWidth 로 가용 폭만큼
 *  칼럼 수가 자동 결정된다(순수 CSS 메이슨리, 레이아웃 JS 없음). columnWidth 는 행 그리드의 측정
 *  min-content(합성 하니스 실측 ≈314px — 이름+캔들 2.5rem+현재가+칩, :root 20px ≈15.7rem) 위로
 *  올린 16.5rem floor. multicol 은 column-width 를 '최소'로 보고 칼럼수를 올림한 뒤 칼럼을 board
 *  폭까지 늘리므로, 플로어가 행 min-content 미만이면 특정 board 밴드(칼럼수 올림→stretch폭<행min)
 *  에서 카드(overflow-hidden·break-inside-avoid)가 등락칩을 잘랐다 — v0.7.15.0 글리프 칼럼(3.5rem)
 *  이 12rem 에 미반영돼 생기던 잠재 버그. 플로어 ≥ 행 min-content 로 그 클리핑 밴드를 제거. (board
 *  자체가 ~16rem 미만 — 관심목록 패널+좁은 뷰포트 → 단일칼럼 — 이면 어떤 플로어로도 클립 불가피;
 *  레이아웃 붕괴는 아님.) 넓어지면 칼럼 수↑, 남는 폭은 minmax(...,1fr) 종목명으로(반응형). */
export function HeatmapBoard({ groups, quoteByCode, sortMode, onPick, onReorder, onRowMenu, onRowDragState }: HeatmapBoardProps) {
  const visible = visibleFolderGroups(groups);
  return (
    // eng-review Q6: 스크롤 컨테이너(바깥, 높이 한정)와 multicol 블록(안쪽, height
    // auto)을 분리한다. 같은 요소에 overflow-y-auto + column-width 를 두면 높이
    // 고정 multicol 이 칼럼을 세로로 꽉 채우다 가로 오버플로/단일 칼럼으로 깨진다.
    // 바깥이 세로 스크롤, 안쪽이 콘텐츠 높이 기준 신문형 균형 패킹.
    <div className="flex-1 overflow-y-auto p-2">
      <div style={{ columnWidth: '16.5rem', columnGap: '0.5rem' }}>
        {visible.map((g) => (
          <HeatmapFolder
            key={g.folder?.id ?? '__uncat__'}
            folder={g.folder}
            entries={g.entries}
            quoteByCode={quoteByCode}
            sortMode={sortMode}
            onPick={onPick}
            onReorder={onReorder}
            onRowMenu={onRowMenu}
            onRowDragState={onRowDragState}
          />
        ))}
      </div>
    </div>
  );
}

import { useState } from 'react';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapFolder, type RowMenuOpener } from './HeatmapFolder';
import { makePctOf, sortEntries, type HeatmapGroup, type SortMode } from './heat';
import { useCopyDragIntent } from './useCopyDragIntent';

export interface HeatmapBoardProps {
  groups: HeatmapGroup[];
  quoteByCode: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string, name?: string) => void;
  /** 그룹 내 드래그 재정렬 커밋(manual 모드). 페이지에서 useReorderHeatmapEntries 로 주입. */
  onReorder?: (folderId: string, orderedCodes: string[]) => void;
  /** 그룹 간 이동 커밋. 미전달이면 그룹 간 드래그 자체가 꺼진다. */
  onMove?: (code: string, fromFolderId: string, toFolderId: string) => void;
  /** 그룹 간 복제 커밋(Ctrl+드래그). 미전달이면 Ctrl 을 눌러도 이동으로 처리한다. */
  onCopy?: (code: string, name: string, toFolderId: string) => void;
  /** 행 우클릭 메뉴(삭제·폴더이동) 오프너. 페이지에서 주입. */
  onRowMenu?: RowMenuOpener;
  /** 그룹 이름 변경 커밋(이름 더블클릭·헤더 우클릭 메뉴). 미전달이면 두 진입점 모두 비활성. */
  onRenameFolder?: (folderId: string, name: string) => Promise<void>;
  /** 그룹 삭제(헤더 우클릭 메뉴). 파괴적이라 confirm 은 페이지가 띄운다. */
  onDeleteFolder?: (folderId: string, name: string) => void;
  /** 행 드래그 시작/끝을 페이지로 전파(그룹순서 동결용, G1). */
  onRowDragState?: (dragging: boolean) => void;
  /** folder_id → 당일 흐름 시계열(%). 미전달이면 헤더 그래프 숨김. */
  flowByFolder?: Map<string, number[]>;
  /** 검색 쿼리 — 매칭 종목 행 하이라이트용(폴더로 통과). */
  query?: string;
  /** 이 그룹의 '＋종목' 팝오버를 자동으로 연다(새 그룹 생성 직후). null=없음. */
  autoAddFolderId?: string | null;
  /** 위 자동 열기가 소비됐음을 페이지에 알린다(표식 1회성 소각). */
  onAutoAddOpened?: () => void;
}

/** 행(entry) 드래그는 형제 행과 그룹 드롭존만 본다. 드로어의 typeAwareCollision 과 같은
 *  계약이되, 보드엔 폴더(그룹 순서) 드래그가 없어 entry 계열만 남는다. */
const entryCollision: CollisionDetection = (args) => {
  const same = args.droppableContainers.filter((c) => {
    const t = c.data.current?.type;
    return t === 'entry' || t === 'entry-target';
  });
  return closestCenter({ ...args, droppableContainers: same });
};

/** 신문형 멀티칼럼 보드. **빈 그룹도 렌더한다** — 예전엔 visibleFolderGroups 가 걸러냈는데,
 *  종목을 넣는 표면(그룹 헤더의 ＋종목·그룹 드롭존)이 그 그룹 카드 안에만 있어 갓 만든
 *  그룹이 화면에서 사라지고 채울 길이 없는 데드엔드가 됐다(드로어만 빈 그룹을 보여주던
 *  비대칭). 빈 카드는 헤더 + 한 줄 안내로 끝나 밀도 비용도 낮다. columnWidth 로 가용 폭만큼
 *  칼럼 수가 자동 결정된다(순수 CSS 메이슨리, 레이아웃 JS 없음). columnWidth 는 행 그리드의 측정
 *  min-content(합성 하니스 실측 ≈15.7rem — 이름+캔들 2.5rem+현재가+칩; 20px root 시절 ≈314px 실측을
 *  rem 환산, rem 기준이라 root 크기와 무관) 위로
 *  올린 16.5rem floor. multicol 은 column-width 를 '최소'로 보고 칼럼수를 올림한 뒤 칼럼을 board
 *  폭까지 늘리므로, 플로어가 행 min-content 미만이면 특정 board 밴드(칼럼수 올림→stretch폭<행min)
 *  에서 카드(overflow-hidden·break-inside-avoid)가 등락칩을 잘랐다 — v0.7.15.0 글리프 칼럼(3.5rem)
 *  이 12rem 에 미반영돼 생기던 잠재 버그. 플로어 ≥ 행 min-content 로 그 클리핑 밴드를 제거. (board
 *  자체가 ~16rem 미만 — 관심목록 패널+좁은 뷰포트 → 단일칼럼 — 이면 어떤 플로어로도 클립 불가피;
 *  레이아웃 붕괴는 아님.) 넓어지면 칼럼 수↑, 남는 폭은 minmax(...,1fr) 종목명으로(반응형).
 *
 *  **DndContext 는 여기 하나뿐이다** — 예전엔 폴더(HeatmapFolder)마다 독립 컨텍스트였고,
 *  그래서 드래그가 구조적으로 "그룹 내"에 갇혀 있었다. 그룹 간 이동/복제를 드래그로 하려면
 *  컨텍스트가 하나여야 한다. multicol 이 블록을 칼럼에 흩뿌려도 폴더 블록은 break-inside-avoid
 *  라 한 칼럼 안에 온전히 있고, dnd-kit 은 좌표로 충돌을 재므로 칼럼을 넘는 드래그도 동작한다. */
export function HeatmapBoard({ groups, quoteByCode, sortMode, onPick, onReorder, onMove, onCopy, onRowMenu, onRenameFolder, onDeleteFolder, onRowDragState, flowByFolder, query, autoAddFolderId, onAutoAddOpened }: HeatmapBoardProps) {
  // distance:5 — 클릭(차트 이동)과 드래그(재정렬/이동)를 가르는 임계. drawer 와 동일 계약.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragging, setDragging] = useState(false);
  const { copyIntent, isCopy, seed } = useCopyDragIntent(dragging);
  // 그룹 간 드래그는 onMove 가 있을 때만. 그룹 내 재정렬은 manual 정렬일 때만(검색 중엔
  // 페이지가 onReorder 를 안 넘긴다 — 부분집합 순서가 서버 순서를 손상시키므로).
  const sortEnabled = sortMode === 'manual' && !!onReorder;
  const dragEnabled = !!onMove || sortEnabled;

  const finish = () => { setDragging(false); onRowDragState?.(false); };
  const onDragStart = (ev: DragStartEvent) => {
    seed(ev.activatorEvent);
    setDragging(true);
    onRowDragState?.(true);
  };
  const onDragEnd = (ev: DragEndEvent) => {
    finish();
    const over = ev.over?.data.current;
    if (!over) return;
    const from = String(ev.active.data.current?.folderId ?? '');
    const code = String(ev.active.data.current?.code ?? '');
    if (from === '' || code === '') return;
    const to = String(over.folderId ?? '');
    // 같은 그룹 형제 행 위 = 그룹 내 재정렬. ordered 는 현재 화면 순서(manual=entry.order).
    if (over.type === 'entry' && to === from) {
      if (!onReorder) return;
      const group = groups.find((g) => g.folder.id === from);
      if (!group) return;
      const ordered = sortEntries(group.entries, sortMode, makePctOf(quoteByCode)).map((e) => e.code);
      const fromIdx = ordered.indexOf(code);
      const toIdx = ordered.indexOf(String(over.code));
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      onReorder(from, arrayMove(ordered, fromIdx, toIdx));
      return;
    }
    if (to === '' || to === from) return;
    // Ctrl 유지 = 복제(원본 그룹 등록 유지), 아니면 이동. onCopy 미주입이면 이동으로 강등한다
    // — 복제를 지원하지 않는 호출자에서 Ctrl 이 드래그를 조용히 삼키는 것보다 낫다.
    if (isCopy() && onCopy) onCopy(code, String(ev.active.data.current?.name ?? code), to);
    else onMove?.(code, from, to);
  };

  const board = (
    <div style={{ columnWidth: '16.5rem', columnGap: '0.5rem' }}>
      {groups.map((g) => (
        <HeatmapFolder
          key={g.folder.id}
          folder={g.folder}
          entries={g.entries}
          quoteByCode={quoteByCode}
          sortMode={sortMode}
          onPick={onPick}
          onRowMenu={onRowMenu}
          flowSeries={flowByFolder ? (flowByFolder.get(g.folder.id) ?? []) : undefined}
          query={query}
          dragEnabled={dragEnabled}
          sortEnabled={sortEnabled}
          copyIntent={copyIntent}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          autoOpenAdd={autoAddFolderId === g.folder.id}
          onAutoOpenAdd={onAutoAddOpened}
        />
      ))}
    </div>
  );

  return (
    // eng-review Q6: 스크롤 컨테이너(바깥, 높이 한정)와 multicol 블록(안쪽, height
    // auto)을 분리한다. 같은 요소에 overflow-y-auto + column-width 를 두면 높이
    // 고정 multicol 이 칼럼을 세로로 꽉 채우다 가로 오버플로/단일 칼럼으로 깨진다.
    // 바깥이 세로 스크롤, 안쪽이 콘텐츠 높이 기준 신문형 균형 패킹.
    <div data-testid="heatmap-board" className="flex-1 overflow-y-auto p-2">
      {dragEnabled ? (
        <DndContext sensors={sensors} collisionDetection={entryCollision}
          onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={finish}>
          {board}
        </DndContext>
      ) : board}
    </div>
  );
}

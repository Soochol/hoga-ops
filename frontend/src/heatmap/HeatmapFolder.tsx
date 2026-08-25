import { useRef, useState } from 'react';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { HeatmapEntry, HeatmapFolder as HeatmapFolderModel } from '../api/heatmap';
import type { LiveQuote } from '../api/liveQuotes';
import { HeatmapRow } from './HeatmapRow';
import { entryMatchesQuery } from './filterGroups';
import { captureLagTitle } from './captureLag';
import { sortEntries, avgPct, heatHeaderBg, makePctOf, type SortMode } from './heat';
import { folderDroppableId, entrySortableId } from '../watchlist/dragHandlers';
import type { JumpModifiers } from '../live/useJumpToLive';
import { FolderAddButton } from './FolderAddButton';
import { GroupFlowSparkline } from './GroupFlowSparkline';
import { HeatmapGroupMenu } from './HeatmapGroupMenu';

/** 행 우클릭 메뉴 열기 — (이벤트, 코드, 이름, 이 행이 속한 폴더 id). */
export type RowMenuOpener = (
  e: React.MouseEvent, code: string, name: string, folderId: string,
) => void;

export interface HeatmapFolderProps {
  folder: HeatmapFolderModel;
  entries: HeatmapEntry[];
  quoteByCode: Map<string, LiveQuote>;
  /** **행 정렬 키 전용** 시세(SORT_THROTTLE_MS 스로틀). 표시값(셀 시세·헤더 틴트)은
   *  quoteByCode 를 그대로 쓴다 — 숫자는 실시간이고 자리만 정돈되는 게 이 분리의 목적이다.
   *  미전달이면 quoteByCode 로 폴백(정렬 시세 = 표시 시세) — 단독 렌더/테스트용. */
  sortQuoteByCode?: Map<string, LiveQuote>;
  sortMode: SortMode;
  onPick: (code: string, name?: string, e?: JumpModifiers) => void;
  /** 행 우클릭 메뉴(삭제·폴더이동) 오프너. 미전달이면 메뉴 비활성. */
  onRowMenu?: RowMenuOpener;
  /** 그룹 당일 흐름(버킷별 평균 등락률%, 무데이터 제거). 미전달=그래프 숨김(테스트 등). */
  flowSeries?: number[];
  /** 검색 쿼리 — 매칭 종목 행을 하이라이트한다(그룹 전체는 filterGroups 가 유지).
   *  빈 문자열/미전달이면 하이라이트 없음. */
  query?: string;
  /** 행을 드래그 가능하게 한다(그룹 간 이동·복제). 보드가 DndContext 를 제공할 때만 true —
   *  단독 렌더(테스트 등)에서는 false 여서 dnd 훅이 컨텍스트 없이 도는 일이 없다. */
  dragEnabled?: boolean;
  /** 그룹 **내** 드래그 재정렬(useSortable + SortableContext). manual 정렬 + 비검색일 때만.
   *  false 여도 dragEnabled 면 행은 여전히 그룹 밖으로 끌 수 있다(이동/복제). */
  sortEnabled?: boolean;
  /** 드롭 하이라이트를 복제(success)로 칠할지 — Ctrl 유지 중. */
  copyIntent?: boolean;
  /** 그룹 이름 변경 커밋. 미전달이면 더블클릭·메뉴의 '이름 변경'이 비활성.
   *  reject 하면 입력이 열린 채 에러를 보여 재시도할 수 있게 한다. */
  onRenameFolder?: (folderId: string, name: string) => Promise<void>;
  /** 그룹 삭제. 미전달이면 메뉴의 '그룹 삭제'가 빠진다. 파괴적이므로(멤버 종목 동반 삭제)
   *  confirm 은 호출측 책임. */
  onDeleteFolder?: (folderId: string, name: string) => void;
  /** code → 마지막 캡처 성공일(YYYYMMDD). 헤더의 '미수집 N' 칩과 행 툴팁이 쓴다
   *  (ADR-0142). 미전달이면 캡처 표시가 통째로 빠진다 — 단독 렌더/테스트용. */
  captureMarkers?: Record<string, string>;
  /** 이 그룹에서 캡처가 뒤처진 코드(보드가 전체 마커로 한 번 계산해 내려준다) —
   *  헤더 '미수집 N' 칩 집계 전용. 그룹마다 재계산하지 않는 이유: 기준일은 **보드
   *  전체 마커의 최댓값**이라 그룹 안에서만 보면 기준이 그룹마다 달라진다. */
  laggingCodes?: ReadonlySet<string>;
  /** 헤더의 '＋종목' 팝오버를 자동으로 연다(새 그룹 생성 직후 — 보드가 지정). */
  autoOpenAdd?: boolean;
  /** 위 자동 열기 소비 통지(보드 → 페이지로 되돌아가 표식을 태운다). */
  onAutoOpenAdd?: () => void;
}

/** 그룹 블록: 헤더(폴더명 + 평균 등락률 칩) + 정렬된 행들. break-inside-avoid
 *  로 CSS multi-column 패킹 시 블록이 칼럼 경계에서 쪼개지지 않게 한다.
 *
 *  **DndContext 는 이 컴포넌트가 아니라 보드(HeatmapBoard)가 소유한다.** 예전엔 폴더마다
 *  독립 컨텍스트였고 그래서 드래그가 구조적으로 "그룹 내"에 갇혔다 — 그룹 간 이동/복제를
 *  드래그로 하려면 컨텍스트가 하나여야 한다. 폴더 블록 전체가 드롭 타깃(useDroppable)이고,
 *  manual 정렬일 때만 안쪽에 SortableContext 를 둬 그룹 내 재정렬을 켠다. 행 id 는
 *  entrySortableId(folderId, code) — 한 종목이 여러 그룹에 등록될 수 있어 code 만으로는
 *  컨텍스트 안에서 충돌한다.
 *
 *  간격: 그룹 간 mb-xs(4.5px, 밀도 우선). 그룹 내부는 헤더-첫행·행간 모두 0으로 붙여
 *  관심종목 패널 리스트와 같은 촘촘한 연속 리스트를 이룬다(구분은 border-b). */
export function HeatmapFolder({ folder, entries, quoteByCode, sortQuoteByCode, sortMode, onPick, onRowMenu, flowSeries, query, dragEnabled, sortEnabled, copyIntent, onRenameFolder, onDeleteFolder, captureMarkers, laggingCodes, autoOpenAdd, onAutoOpenAdd }: HeatmapFolderProps) {
  const pctOf = makePctOf(quoteByCode);
  // 정렬 키만 스로틀된 시세에서 읽는다 — 헤더 틴트(avg)와 행 표시값은 라이브 pctOf 유지.
  const sorted = sortEntries(entries, sortMode, makePctOf(sortQuoteByCode ?? quoteByCode));
  const avg = avgPct(entries, pctOf);
  const folderId = folder.id;
  const canSort = !!dragEnabled && !!sortEnabled;
  // 검색 중에도 그룹 전체 기준으로 센다(entries 는 필터되지 않고 행 하이라이트만
  // 바뀌므로 sorted 가 아니라 entries 를 세도 같지만, 의도를 명시해 둔다).
  const laggingInGroup = laggingCodes
    ? entries.reduce((n, e) => n + (laggingCodes.has(e.code) ? 1 : 0), 0)
    : 0;
  const [renaming, setRenaming] = useState<{ value: string; error: string | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasGroupMenu = !!onRenameFolder || !!onDeleteFolder;

  const ctxFor = onRowMenu
    ? (code: string, name: string) => (e: React.MouseEvent) => onRowMenu(e, code, name, folderId)
    : undefined;

  const rows = sorted.map((e) => {
    const q = quoteByCode.get(e.code);
    const matched = query ? entryMatchesQuery(e, query) : false;
    const common = {
      name: e.name,
      price: q?.price ?? null, pct: q?.change_pct ?? null,
      open: q?.open ?? null, high: q?.high ?? null, low: q?.low ?? null,
      expectedPrice: q?.expected_price ?? null, expectedPct: q?.expected_change_pct ?? null,
      matched,
      ariaLabel: `${e.name} ${e.code} 차트 열기`,
      testId: `heatmap-row-${e.code}`,
      onContextMenu: ctxFor?.(e.code, e.name),
      // 캡처 상태는 행에 자리를 만들지 않고 툴팁으로만 싣는다 — 히트맵 행은 밀도가
      // 1차 정책이라(HeatmapRow 주석) 271행 × 날짜 배지는 칼럼을 못 낸다. 그룹 헤더
      // 칩이 "몇 개 뒤처졌나"를, 이 툴팁이 "이 종목은 언제였나"를 답한다.
      // (2026-08-25: 뒤처진 행의 종목명 --error 강조는 사용자 요청으로 제거 —
      // laggingCodes 는 이제 헤더 칩 집계에만 쓰인다.)
      captureTitle: captureMarkers ? captureLagTitle(captureMarkers, e.code) : undefined,
    };
    if (!dragEnabled) {
      return <HeatmapRow key={e.code} {...common} onClick={(ev) => onPick(e.code, e.name, ev)} />;
    }
    return (
      <DragHeatmapRow key={e.code} code={e.code} name={e.name} folderId={folderId} sortable={canSort}
        row={common} onPick={(ev) => onPick(e.code, e.name, ev)} />
    );
  });

  const body = entries.length === 0 ? <EmptyGroupHint /> : canSort ? (
    <SortableContext items={sorted.map((e) => entrySortableId(folderId, e.code))}
      strategy={verticalListSortingStrategy}>
      {rows}
    </SortableContext>
  ) : rows;

  return (
    <FolderDropZone folderId={folderId} enabled={!!dragEnabled} copy={!!copyIntent}>
      {/* 그룹 헤더 밴드 = heatHeaderBg(avg) — 평균 등락 비례 히트 틴트(섹터 온도). 폴더 본문은
          투명·평면이고 좌측 border-strong 스파인 + 이 틴트 밴드로 그룹을 구분한다. 평균 % 는
          평면 text-fg-dim 텍스트(색=밴드가 짊어짐, 숫자=보조; G4). */}
      {/* 헤더 우클릭 = 그룹 메뉴(이름 변경·삭제). ⋯ 버튼을 얹지 않는 이유는
          HeatmapGroupMenu 주석 참조(헤더 밀도). 이름 편집 중엔 메뉴를 막는다. */}
      <div className="flex justify-between items-center gap-2 px-2 py-1 min-h-list-group-header"
        style={{ background: heatHeaderBg(avg) }}
        onContextMenu={hasGroupMenu && !renaming
          ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }
          : undefined}>
        {/* 폴더(섹터)명 = 보드의 1차 앵커. 글자 크기 text-xs(가독성, origin/main).
            그룹 당일 흐름 미니 그래프는 이름 옆(기준선 면적형, GroupFlowSparkline). */}
        <span className="flex items-center gap-2 min-w-0">
          {renaming && onRenameFolder ? (
            <GroupNameInput
              state={renaming}
              onChange={(value) => setRenaming({ value, error: null })}
              onCancel={() => setRenaming(null)}
              onCommit={async (value) => {
                const next = value.trim();
                if (next === '' || next === folder.name) { setRenaming(null); return; }
                try {
                  await onRenameFolder(folderId, next);
                  setRenaming(null);
                } catch (e) {
                  // 입력을 열어 둔 채 사유를 보여 재시도시킨다 — 조용히 닫으면 이름이
                  // 안 바뀐 이유를 알 길이 없다(StudyViewsDrawer.commitRename 과 동일 계약).
                  setRenaming({
                    value,
                    error: e instanceof Error ? e.message : '이름 변경에 실패했습니다',
                  });
                }
              }}
            />
          ) : (
            /* 더블클릭 = 제자리 이름 변경. select-none 은 더블클릭이 텍스트를 선택해
               입력 위에 파란 하이라이트가 남는 것을 막는다. */
            <span
              className={`text-xs font-semibold truncate text-fg${onRenameFolder ? ' select-none' : ''}`}
              data-testid={`heatmap-folder-name-${folderId}`}
              title={onRenameFolder ? '더블클릭하면 이름을 바꿉니다' : undefined}
              onDoubleClick={onRenameFolder
                ? (e) => { e.preventDefault(); setRenaming({ value: folder.name, error: null }); }
                : undefined}
            >
              {folder.name}
            </span>
          )}
          {flowSeries !== undefined && <GroupFlowSparkline series={flowSeries} />}
        </span>
        <span className="flex items-center gap-2 flex-none">
          {laggingInGroup > 0 && (
            /* 캡처 결손 칩 — 결손이 있을 때만 존재한다(정상은 아무것도 그리지 않는다).
               색은 --error 계열: DESIGN.md 색 규율에서 캡처 성공/실패는 상태 semantic 이고,
               시세 색(적/청)과 절대 섞이면 안 되는 축이다. 그래서 등락률 칩 옆에 서도
               의미가 뒤섞이지 않는다. */
            <span
              className="text-2xs font-data tabular-nums text-error"
              data-testid={`heatmap-folder-lag-${folderId}`}
              title={`이 그룹에서 ${laggingInGroup}종목이 최신 수집일보다 뒤처졌습니다`}
            >
              미수집 {laggingInGroup}
            </span>
          )}
          {avg !== null && (
            <span className="text-xs font-data tabular-nums text-fg-dim">
              {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
            </span>
          )}
          <FolderAddButton folderId={folder.id} autoOpen={autoOpenAdd} onAutoOpened={onAutoOpenAdd} />
        </span>
      </div>
      {body}
      {menu && (
        <HeatmapGroupMenu x={menu.x} y={menu.y} name={folder.name}
          onRename={onRenameFolder
            ? () => setRenaming({ value: folder.name, error: null })
            : undefined}
          onDelete={onDeleteFolder ? () => onDeleteFolder(folderId, folder.name) : undefined}
          onClose={() => setMenu(null)} />
      )}
    </FolderDropZone>
  );
}

/** 빈 그룹의 본문 한 줄 — 보드가 빈 그룹도 렌더하게 되면서(HeatmapBoard 주석) 헤더만 남아
 *  카드가 정체불명으로 납작해지는 것을 막고, 채우는 두 경로(헤더 ＋종목 · 다른 그룹에서
 *  드래그)를 그 자리에서 알린다. 표시 전용이라 클릭 표적을 새로 만들지 않는다 — 실제
 *  진입점은 바로 위 헤더 버튼 하나로 유지(중복 트리거 = 팝오버 2개). */
function EmptyGroupHint() {
  return (
    <div data-testid="heatmap-folder-empty" className="px-2 py-1 text-xs text-fg-dimmer">
      종목 없음 · ＋종목 또는 드래그로 추가
    </div>
  );
}

/** 그룹명 제자리 편집 입력 — Enter 확정 / Escape 취소 / blur 확정(StudyViewsDrawer 의
 *  저장뷰 이름 변경과 동일 계약). 마운트 시 전체 선택해 곧바로 덮어쓸 수 있게 한다.
 *
 *  `committing` 가드가 필요한 이유: Enter 로 커밋하면 입력이 언마운트되며 blur 가 한 번 더
 *  터져 같은 커밋이 두 번 나간다. 커밋이 async(서버 왕복)라 그 사이 창이 열려 있다. */
function GroupNameInput({ state, onChange, onCommit, onCancel }: {
  state: { value: string; error: string | null };
  onChange: (value: string) => void;
  onCommit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const committing = useRef(false);
  const commit = async () => {
    if (committing.current) return;
    committing.current = true;
    try {
      await onCommit(state.value);
    } finally {
      committing.current = false;
    }
  };
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <input
        aria-label="그룹 이름 수정"
        autoFocus
        value={state.value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        // 헤더 밴드 위에 얹히므로 bg-bg-input 으로 편집 중임을 분명히 한다.
        className="w-full min-w-0 rounded border border-border bg-bg-input px-1 py-0.5 text-xs font-semibold text-fg"
      />
      {state.error && <span className="truncate text-badge text-error">{state.error}</span>}
    </span>
  );
}

/** 폴더 블록 = 그룹 루트 + (드래그 활성 시) 종목 드롭 타깃. 드롭 타깃과 그룹 루트를 같은
 *  요소에 두면 스크롤 앵커 id(#heatmap-folder-*)와 rect 가 하나로 맞아, 헤더든 행 사이든
 *  블록 어디에 떨궈도 이 그룹으로 들어온다. dragEnabled=false 면 useDroppable 을 아예
 *  등록하지 않는다 — DndContext 없는 단독 렌더에서 dnd 훅이 도는 것을 피한다. */
function FolderDropZone({ folderId, enabled, copy, children }: {
  folderId: string; enabled: boolean; copy: boolean; children: React.ReactNode;
}) {
  const cls = 'break-inside-avoid border-l-2 border-border-strong mb-xs overflow-hidden';
  if (!enabled) return <div id={`heatmap-folder-${folderId}`} className={cls}>{children}</div>;
  return <ActiveFolderDropZone folderId={folderId} copy={copy} cls={cls}>{children}</ActiveFolderDropZone>;
}

function ActiveFolderDropZone({ folderId, copy, cls, children }: {
  folderId: string; copy: boolean; cls: string; children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: folderDroppableId(folderId),
    data: { type: 'entry-target', folderId },
  });
  const isOver = useIsDropTarget(folderId);
  const ring = isOver
    ? ` ring-1 ring-inset ${copy ? 'ring-success bg-tint-success' : 'ring-accent bg-tint-selection'}`
    : '';
  return (
    <div ref={setNodeRef} id={`heatmap-folder-${folderId}`}
      data-drop-intent={isOver ? (copy ? 'copy' : 'move') : undefined}
      className={cls + ring}>
      {children}
    </div>
  );
}

/** 이 폴더가 **지금 드롭 대상인가**. useDroppable 의 isOver 를 쓰면 안 된다 — manual 정렬일
 *  때 행 자체가 droppable(type 'entry')이라, 대상 그룹의 행 위를 지나는 동안 폴더 존의
 *  isOver 는 꺼져 있고 하이라이트가 사라진다(정작 그 상태로 놓으면 이 그룹에 들어간다).
 *  컨텍스트의 현재 over 가 어느 폴더에 속하는지로 판정하면 행 위든 그룹 여백이든 일관된다.
 *  출발 그룹 자신은 제외 — 같은 그룹 내 드롭은 이동이 아니라 재정렬이다.
 *  비용은 없다: useDroppable 도 같은 컨텍스트를 구독하므로 리렌더 횟수는 그대로다. */
function useIsDropTarget(folderId: string): boolean {
  const { active, over } = useDndContext();
  if (!active || !over) return false;
  return over.data.current?.folderId === folderId
    && active.data.current?.folderId !== folderId;
}

type RowProps = Omit<React.ComponentProps<typeof HeatmapRow>, 'onClick' | 'sortableRef' | 'sortableStyle' | 'dragListeners' | 'dragging'>;

/** 드래그 가능한 행. manual 정렬이면 useSortable(형제 위 드롭=그룹 내 재정렬 + 다른 그룹으로
 *  끌기 가능), 아니면 useDraggable(그룹 밖으로 끌기 전용 — 라이브 정렬 모드에선 그룹 내
 *  순서가 매 폴링 시세로 덮여 재정렬이 무의미하다). 드로어의 SortableEntryRow/DraggableRow
 *  와 같은 계약이고, data 에 code·name·folderId 를 실어 보드의 onDragEnd 가 id 를 파싱하지
 *  않게 한다(name 은 복제 시 낙관적 행의 표시명). */
function DragHeatmapRow({ code, name, folderId, sortable, row, onPick }: {
  code: string; name: string; folderId: string; sortable: boolean;
  row: RowProps;
  onPick: (e?: JumpModifiers) => void;
}) {
  return sortable
    ? <SortableDragRow code={code} name={name} folderId={folderId} row={row} onPick={onPick} />
    : <PlainDragRow code={code} name={name} folderId={folderId} row={row} onPick={onPick} />;
}

function SortableDragRow({ code, name, folderId, row, onPick }: {
  code: string; name: string; folderId: string; row: RowProps; onPick: (e?: JumpModifiers) => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: entrySortableId(folderId, code), data: { type: 'entry', code, name, folderId } });
  return (
    <HeatmapRow {...row} onClick={onPick} sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners} dragging={isDragging} />
  );
}

function PlainDragRow({ code, name, folderId, row, onPick }: {
  code: string; name: string; folderId: string; row: RowProps; onPick: (e?: JumpModifiers) => void;
}) {
  const { setNodeRef, listeners, transform, isDragging } =
    useDraggable({ id: entrySortableId(folderId, code), data: { type: 'entry', code, name, folderId } });
  return (
    <HeatmapRow {...row} onClick={onPick} sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Translate.toString(transform) }}
      dragListeners={listeners} dragging={isDragging} />
  );
}

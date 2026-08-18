import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useJumpToLive, type JumpModifiers } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { makeChangePctOf, sortEntriesByChangePct, type QuoteSortMode } from '../rightrail/quoteSort';
import { QuoteSortIcon } from '../rightrail/QuoteSortIcon';
import { CollapseAllIcon, ExpandAllIcon } from '../ui/CollapseAllIcon';
import { quoteSortModeDescription } from '../rightrail/quoteSortDescription';
import { useLivePageStore } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';
import { deriveCollectionView, type DisplayStatus } from '../live/collectionStatus';
import { CollectionDot } from '../live/CollectionDot';
import {
  useWatchlist, useCatchupAll, useRemoveFromWatchlist,
  useCreateFolder, useRenameFolder, useDeleteFolder, useReorderFolders,
  useReorderItems, useAddMemo, useUpdateMemo, useRemoveMemo,
} from './useWatchlist';
import { persistJson, readJsonObject } from '../state/persist';
import { ChevronIcon } from '../ui/ChevronIcon';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { groupByFolder, swapFolderOrder, countOrphansIfFolderDeleted } from './grouping';
import { Countdown } from './Countdown';
import { Banner } from './Banner';
import { WatchlistEditModal } from './WatchlistEditModal';
import { GroupNameModal } from './GroupNameModal';
import { WatchlistRowMenu, WatchlistMemoRowMenu } from './WatchlistRowMenu';
import { WatchlistGroupPicker } from './WatchlistGroupPicker';
import { WatchlistAddForm } from './WatchlistAddForm';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { TrashIcon } from '../ui/TrashIcon';
import { FolderDeleteConfirm } from './FolderDeleteConfirm';
import { QuoteRow } from '../rightrail/QuoteRow';
import { summarizeCaughtUpAll, formatCaughtUpAllHeader } from './banners';
import { useLiveVenueStore } from '../state/liveVenue';
import {
  DndContext, PointerSensor, useSensor, useSensors,
  type DragStartEvent, type DragMoveEvent, type DragEndEvent,
  type DraggableAttributes, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { typeAwareCollision } from './panelDragCollision';
import { RailDragOverlay } from '../rightrail/RailDragOverlay';
import { useDragPointPublisher } from '../state/useDragPointPublisher';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WatchlistEntry, WatchlistMemo } from '../api/watchlist';
import { WATCHLIST_MEMO_MAX_LEN } from '../api/watchlist';
import { MemoRow } from './MemoRow';
import {
  mergePanelRows, memosOfFolder, panelRowKey, toItemRefs, type PanelRow,
} from './panelRows';
// resolveDrag(코드 전용 재배열)는 이제 편집 모달만 쓴다 — 패널은 메모를 함께 옮기므로
// mergePanelRows + toItemRefs 로 표시 순서 전체를 만든다.
import {
  resolveFolderDrag, entrySortableId, memoSortableId, parseItemSortableId,
} from './dragHandlers';
import { useEntryDragStore, isPointOnChart, dropPoint, resolveDropOnChart } from '../state/entryDrag';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailDrawerSection, RailState } from '../ui/RailShell';
// 히트맵이 먼저 쓰던 훅(HeatmapDrawer·pages/Heatmap). 드래그 중 입력을 얼려 리렌더를
// **싸게** 만든다 — 리렌더 자체를 막지는 못한다(WS 틱의 setTick 은 그대로 발생).
import { useFrozenWhileDragging } from '../heatmap/useFrozenWhileDragging';

// v1는 기존 전역 정렬 값 마이그레이션 입력으로만 유지.
const LEGACY_SORT_MODE_STORAGE_KEY = 'watchlist.sortMode.v1';
// 실폴더 정렬 모드는 폴더 단위 map으로 보관.
const FOLDER_SORT_MODE_STORAGE_KEY = 'watchlist.folderSortMode.v1';
type FolderSortModeMap = Record<string, QuoteSortMode>;

function isQuoteSortMode(raw: unknown): raw is QuoteSortMode {
  return raw === 'default' || raw === 'change_pct_asc' || raw === 'change_pct_desc';
}

function readSortModeFromStorage(): QuoteSortMode {
  const saved = readJsonObject(LEGACY_SORT_MODE_STORAGE_KEY);
  const raw = saved?.sortMode;
  if (isQuoteSortMode(raw)) return raw;
  return 'default';
}

function readFolderSortModeMapFromStorage(): FolderSortModeMap {
  const saved = readJsonObject(FOLDER_SORT_MODE_STORAGE_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const validEntries = Object.entries(saved).filter(([, value]) => isQuoteSortMode(value));
  return Object.fromEntries(validEntries) as FolderSortModeMap;
}

/** 우측 정렬 앵커드 메뉴 셸 — dim 라벨 헤더 + menuitem children. 패널의 두 메뉴
 *  (헤더 편집 메뉴, 그룹 ⋯ 메뉴)가 공유해 컨테이너/헤더 스타일 드리프트를 막는다. */
function AnchoredMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="menu" aria-label={label}
      className="absolute right-0 z-30 mt-1 bg-bg-card border border-border rounded shadow-lg py-1 min-w-[150px]">
      <div className="px-3 py-1 text-xs text-fg-dim">{label}</div>
      {children}
    </div>
  );
}

/** 그룹 ⋯ 메뉴 아이콘 — 유니코드 글리프(✎▲▼) 대신 SVG 로 통일(chevron·Trash 와 동일
 *  근거: 폰트별 렌더 불일치 회피). 1em 스케일이라 텍스트 크기를 따른다. */
function MenuGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const PencilIcon = () => <MenuGlyph><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></MenuGlyph>;
const ArrowUpIcon = () => <MenuGlyph><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></MenuGlyph>;
const ArrowDownIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></MenuGlyph>;
const PlusIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M5 12h14" /></MenuGlyph>;
/** 빈칸(메모) 행 — 실선 위에 점선 한 줄로 "빈 자리"를 표현. */
const BlankRowIcon = () => <MenuGlyph><path d="M4 8h16" /><path d="M4 16h16" strokeDasharray="3 3" /></MenuGlyph>;

const ADD_POPOVER_W = 280;

/**
 * 그룹 ⋯ 메뉴 "종목 추가" 팝오버 — anchorRef(⋯ 버튼) 우하단 기준 우측정렬 후
 * useClampedFixedPosition 으로 뷰포트 보정, createPortal 로 body 에 fixed(드로어
 * overflow 탈출). 내부는 기존 WatchlistAddForm(SymbolSearch + useAddMember)을 그대로
 * 재사용해 add 로직 중복을 없앤다 — 그룹은 이미 특정돼 있으므로 folderId 로 고정
 * (히트맵 헤더 버튼과 달리 그룹 선택 셀렉트 없음). 바깥 클릭·Escape·추가 완료 시 onClose.
 * 히트맵 SymbolAddPopover 와 동일 셸/레이어링(메뉴와 별개 portal 레이어).
 */
function WatchlistSymbolAddPopover({ anchorRef, point, folderId, resolveAt, onAdded, onClose }: {
  /** ⋯ 메뉴 경로 — 이 버튼의 우하단에 정렬한다. `point` 와 배타적이다. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** 행 우클릭 경로 — 커서 좌표에 그대로 띄운다(컨텍스트 메뉴가 있던 자리). */
  point?: { x: number; y: number };
  folderId: string;
  /** 삽입 위치(WatchlistAddForm 참조) — 미전달이면 폴더 맨 아래. */
  resolveAt?: () => number | undefined;
  /** 추가 성공 후. 미전달이면 닫기만 한다(⋯ 메뉴 경로의 기존 동작). */
  onAdded?: () => void;
  onClose: () => void;
}) {
  const [anchor, setAnchor] = useState(
    point ? { left: point.x, top: point.y } : { left: 0, top: 0 });
  useLayoutEffect(() => {
    if (point) return;   // 커서 좌표 경로 — 실측할 앵커가 없다(초기 state 가 곧 위치)
    const r = anchorRef?.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.right - ADD_POPOVER_W, top: r.bottom + 4 });
  }, [anchorRef, point]);
  const { ref: popRef, left, top } = useClampedFixedPosition<HTMLDivElement>(anchor.left, anchor.top);
  useLayoutEffect(() => { popRef.current?.querySelector('input')?.focus(); }, [popRef]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef?.current?.contains(t) || popRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, popRef, onClose]);
  return createPortal(
    <div ref={popRef} role="dialog" aria-label="종목 추가"
      data-testid="watchlist-group-add-popover"
      style={{ position: 'fixed', left, top, width: ADD_POPOVER_W }}
      className="z-30 bg-bg-card border border-border-strong rounded p-2 shadow-lg">
      <WatchlistAddForm folderId={folderId} resolveAt={resolveAt}
        onAdded={() => (onAdded ? onAdded() : onClose())} />
    </div>,
    document.body,
  );
}

/**
 * 그룹 헤더 행 — 라벨/chevron 클릭 = 접기 토글, 호버 시 ⋯ 메뉴(이름 변경/삭제;
 * 실폴더만 — 미분류는 onRename/onDelete 미전달 → ⋯ 메뉴 없이 chevron+라벨 버튼만).
 * FolderRow(편집 모달)
 * 처럼 button-in-button을 피해 div + 형제 버튼 구조이고, 메뉴 state/dismiss 훅을
 * 루프 밖에서 쓰기 위해 module-scope 컴포넌트로 분리했다(react-hooks 규칙).
 */
function GroupHeader(props: {
  label: string; count: number; collapsed: boolean;
  onToggle: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** "빈칸 추가" — 그룹 맨 아래에 메모 행을 넣는다(v4, 실폴더만). */
  onAddMemo?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  sortMode?: QuoteSortMode;
  onSort?: (mode: QuoteSortMode) => void;
  /** 실폴더 id — 있으면 ⋯ 메뉴에 "종목 추가"가 붙는다(미분류는 미전달). */
  folderId?: string;
  dragHandle?: GroupDragHandle;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // "종목 추가" 팝오버 — 메뉴와 별개 레이어라 메뉴 언마운트에 딸려 사라지지 않는다(히트맵과 동일).
  const [addOpen, setAddOpen] = useState(false);
  const sortDescriptionId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(menuOpen, menuRef, () => setMenuOpen(false));
  const itemClass =
    'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent';
  const cycleSortMode = () => {
    if (!props.onSort || !props.sortMode) return;
    if (props.sortMode === 'default') {
      props.onSort('change_pct_desc');
    } else if (props.sortMode === 'change_pct_desc') {
      props.onSort('change_pct_asc');
    } else {
      props.onSort('default');
    }
  };
  return (
    // sticky + bg-bg: 패널(RailDrawer) 배경과 동일색이라 평시엔 투명처럼 보이고,
    // 스크롤 시에만 불투명이 드러나 행을 가린다(스펙 §1). 각 그룹 div가 컨테이닝 블록이라
    // 헤더는 자기 그룹 범위에서만 고정된다. 메뉴가 열리면 z를 올려 다음 sticky
    // 헤더(z-10)가 이 헤더의 메뉴(z-30, 헤더 스태킹 컨텍스트 내부)를 덮지 않게 한다.
    //
    // 별도 핸들 아이콘 없이 헤더 전체가 드래그 활성 영역(dragHandle 있을 때). dnd-kit
    // PointerSensor(distance 5)가 클릭과 드래그를 구분하므로 chevron/정렬/⋯/라벨 클릭은
    // 그대로 동작하고, 헤더를 5px 이상 끌면 그룹 드래그가 시작된다. attributes(role=button/
    // tabindex)는 헤더 안 버튼들과 중첩 a11y 충돌을 피해 spread 하지 않는다(포인터 전용).
    <div
      ref={props.dragHandle?.setActivatorNodeRef}
      {...(props.dragHandle?.listeners ?? {})}
      data-testid="watchlist-group-header"
      data-draggable={props.dragHandle ? '' : undefined}
      className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 min-h-list-group-header text-sm font-semibold text-fg-dim bg-bg hover:bg-bg-input-hover ${
        props.dragHandle ? 'cursor-grab select-none touch-none' : ''
      }`}>
      <button type="button" aria-label={`${props.label} ${props.collapsed ? '펼치기' : '접기'}`}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle} className="px-1 leading-none text-fg-dimmer hover:text-fg">
        <ChevronIcon collapsed={props.collapsed} />
      </button>
      {/* 개수를 라벨 버튼 안에 — 우측 정렬 mono 개수가 가격 컬럼과 같은 x에 떨어져
          종목 행처럼 읽히던 충돌을 해소하고(스펙 §문제 1), 클릭 타깃도 키운다.
          aria-label 명시 — 콘텐츠 합성에 맡기면 인접 span 사이 공백 처리가
          엔진(accname 구현)마다 갈려 "스윙1"로 붙을 수 있다(가시 텍스트와 동일 문구). */}
      <button type="button" onClick={props.onToggle}
        aria-label={`${props.label} ${props.count}`} aria-expanded={!props.collapsed}
        className="flex-1 min-w-0 text-left flex items-baseline gap-1.5">
        <span className="truncate">{props.label}</span>
        <span className="flex-none text-xs font-normal text-fg-dim">{props.count}</span>
      </button>
      {props.onSort && (
        <button type="button" aria-label={`${props.label} 정렬`}
          aria-describedby={sortDescriptionId}
          // 마우스 툴팁 — 아이콘만으론 현재 정렬 상태·다음 동작이 불투명했다(sr-only
          // 설명은 있으나 포인터 사용자엔 안 보임). aria-describedby 와 같은 문구.
          title={quoteSortModeDescription(props.sortMode)}
          onClick={cycleSortMode}
          className={`px-1 leading-none hover:text-fg ${props.sortMode === 'default' ? 'text-fg-dimmer' : 'text-accent'}`}>
          <QuoteSortIcon mode={props.sortMode} />
          <span id={sortDescriptionId}
            style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
            {quoteSortModeDescription(props.sortMode)}
          </span>
        </button>
      )}
      {props.onRename && (
        <div className="relative" ref={menuRef}>
          {/* 그룹 헤더 도구(드래그·정렬·⋯)는 호버 없이 항시 표시(사용자 요청) —
              dim(text-fg-dimmer)으로 밀도는 유지하되 발견성을 높인다. */}
          <button type="button" aria-label={`${props.label} 그룹 메뉴`}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="px-1 leading-none text-fg-dimmer hover:text-fg">
            ⋯
          </button>
          {menuOpen && (
            <AnchoredMenu label={props.label}>
              {props.folderId && (
                <button type="button" role="menuitem"
                  onClick={() => { setMenuOpen(false); setAddOpen(true); }}
                  className={itemClass}>
                  <span className="w-4 grid place-items-center"><PlusIcon /></span> 종목 추가
                </button>
              )}
              {props.onAddMemo && (
                <button type="button" role="menuitem"
                  onClick={() => { setMenuOpen(false); props.onAddMemo?.(); }}
                  className={itemClass}>
                  <span className="w-4 grid place-items-center"><BlankRowIcon /></span> 빈칸 추가
                </button>
              )}
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onRename?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><PencilIcon /></span> 그룹 이름 변경
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveUp}
                onClick={() => { setMenuOpen(false); props.onMoveUp?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><ArrowUpIcon /></span> 위로 이동
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveDown}
                onClick={() => { setMenuOpen(false); props.onMoveDown?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><ArrowDownIcon /></span> 아래로 이동
              </button>
              {/* 파괴적 액션 — 디바이더 + --error 로 인접 항목과 시각 거리를 벌려
                  오클릭(→ confirm) 을 줄이는 모터 가드. text-fg 와 충돌하지 않게
                  itemClass 대신 전용 danger 클래스(같은 레이아웃, 색만 --error). */}
              <div role="separator" className="my-1 border-t border-border" />
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onDelete?.(); }}
                className="w-full text-left px-3 py-1.5 text-sm text-error hover:bg-tint-error flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent">
                <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 그룹 삭제
              </button>
            </AnchoredMenu>
          )}
          {addOpen && props.folderId && (
            <WatchlistSymbolAddPopover anchorRef={menuRef} folderId={props.folderId}
              onClose={() => setAddOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 행 우측 트레일링 슬롯 — 평시엔 수집상태 점(예외만), 호버/포커스 시엔 ⋯ 행 메뉴 버튼.
 *
 * 두 관용구를 한 슬롯에 겹친다(grid 오버레이): (1) 정상 실시간(realtime)은 점을 숨겨
 * "정상=무표시" 예외-기반 신호로 만들고 — 33행 전부 초록 점이던 노이즈를 없앤다
 * (LiveStatusBar의 종목 앞 점은 CollectionDot 그대로 유지, 여기서만 게이트). (2) 그간
 * 우클릭으로만 닿던 행 메뉴(관심 해제/그룹 편집)를 호버 ⋯ 버튼으로 발견 가능하게 한다.
 *
 * ⋯ 는 평시 opacity-0 + pointer-events-none 이라 슬롯 위 클릭이 행(차트 이동)으로
 * 통과하고, 호버/포커스 시에만 보이며 클릭 가능해진다. opacity(=DOM 유지)라 Tab 포커스가
 * 닿는다(group 헤더 ⋯ 와 동일 계약). 정상 행은 점이 없어 ⋯ 만 이 슬롯을 쓴다.
 */
function RowTrailing(props: {
  status: DisplayStatus;
  name: string;
  onOpenMenu: (e: React.MouseEvent) => void;
}) {
  const showDot = props.status !== 'realtime';
  return (
    <span className="relative grid place-items-center" style={{ minWidth: '1.25rem', minHeight: '1.25rem' }}>
      {showDot && (
        <span className="col-start-1 row-start-1 group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">
          {/* 라벨은 끈다 — 이 슬롯은 `minWidth: 1.25rem` 이고 `⋯` 와 겹쳐 있어,
              라벨이 들어오면 종목명을 52 → 13px 로 뭉갠다(2026-08-10 실측).
              문구는 `title`·`aria-label` 이 그대로 전달한다. */}
          <CollectionDot status={props.status} showLabel={false} />
        </span>
      )}
      <button
        type="button"
        aria-label={`${props.name} 행 메뉴`}
        aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); props.onOpenMenu(e); }}
        className="col-start-1 row-start-1 grid place-items-center px-1 leading-none text-fg-dimmer hover:text-fg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
      >
        ⋯
      </button>
    </span>
  );
}

/** 그룹 헤더에 부착할 드래그 핸들 — listeners만(포인터 전용; KeyboardSensor 미도입,
 *  편집 모달 ⠿ 핸들과 동일 계약). */
type GroupDragHandle = {
  listeners: DraggableSyntheticListeners;
  attributes: DraggableAttributes;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
};

/** 폴더(그룹)의 sortable 단위 = 그룹 블록 전체(헤더 + 종목들). setNodeRef/transform은
 *  컨테이너 div에, listeners는 children render-prop으로 헤더 ⠿ 핸들에 전달한다 —
 *  핸들을 잡으면 그룹이 통째로 움직인다. data.type='folder'로 태깅. */
function SortableGroup({ folderId, children }: {
  folderId: string;
  children: (handle: GroupDragHandle) => React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, listeners, attributes, isDragging } =
    useSortable({ id: folderId, data: { type: 'folder' } });
  return (
    <div ref={setNodeRef} data-testid={`watchlist-group-${folderId}`}
      style={{
        transform: CSS.Transform.toString(transform), transition,
        ...(isDragging ? { opacity: 0.6, position: 'relative', zIndex: 1 } : {}),
      }}>
      {children({ listeners, attributes, setActivatorNodeRef })}
    </div>
  );
}

/** 패널 종목 행 — dnd transform/ref는 행에 두고, listeners는 종목명 왼쪽 핸들에만 둔다.
 *  행 클릭(차트 이동)·우클릭 메뉴와 드래그 시작 표면이 섞이지 않게 분리한다.
 *
 *  **`memo` 인 이유와 그 조건**: WS 체결 틱이 150ms 마다 드로어를 리렌더한다
 *  (`api/liveTickOverlay.ts` LIVE_FLUSH_MS). 그때마다 이 행까지 리렌더되면 dnd-kit 의
 *  transform transition 이 진행 중에 재시작돼 드래그가 뚝뚝 끊긴다. 그래서 props 를
 *  **전부 스칼라 아니면 안정 참조**로 좁혔다 — 트레일링 슬롯을 `ReactNode` 로 주입받거나
 *  콜백을 행마다 새로 만들면 memo 는 그냥 무효다. 콜백은 `entry` 를 인자로 받는 폴더
 *  단위 안정 참조이고, 트레일링은 여기서 조립한다. 이 계약을 깨는 prop 을 추가하지 말 것. */
const SortableQuoteRow = memo(function SortableQuoteRow(props: {
  entry: WatchlistEntry;
  price: number | null; pct: number | null; changeWon: number | null;
  expectedPrice?: number | null; expectedPct?: number | null;
  active: boolean;
  status: DisplayStatus;
  collectionLabel?: string;
  onPick: (entry: WatchlistEntry, e?: JumpModifiers) => void;
  onOpenMenu: (e: React.MouseEvent, entry: WatchlistEntry) => void;
  onDelete: (entry: WatchlistEntry) => void;
  dragEnabled?: boolean;
}) {
  const { entry, onPick, onOpenMenu, onDelete } = props;
  const handlePick = useCallback((e?: JumpModifiers) => onPick(entry, e), [onPick, entry]);
  const handleOpenMenu = useCallback((e: React.MouseEvent) => onOpenMenu(e, entry), [onOpenMenu, entry]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => onOpenMenu(e, entry), [onOpenMenu, entry]);
  const handleDelete = useCallback(() => onDelete(entry), [onDelete, entry]);
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging, activeIndex, overIndex, index } =
    useSortable({ id: entrySortableId(entry.folder_id, entry.code), data: { type: 'entry', folderId: entry.folder_id, code: entry.code, name: entry.name } });
  const dropIndicator = activeIndex !== -1 && overIndex !== -1 && index === overIndex && index !== activeIndex
    ? (activeIndex < overIndex ? 'after' : 'before')
    : undefined;
  return (
    <QuoteRow
      name={entry.name}
      price={props.price}
      pct={props.pct}
      changeWon={props.changeWon}
      expectedPrice={props.expectedPrice}
      expectedPct={props.expectedPct}
      active={props.active}
      ariaLabel={[entry.name, entry.code, props.collectionLabel, '차트 열기'].filter(Boolean).join(' ')}
      testId={`watchlist-row-${entry.code}`}
      onClick={handlePick}
      onContextMenu={handleContextMenu}
      onDelete={handleDelete}
      indented
      sortableRef={props.dragEnabled === false ? undefined : setNodeRef}
      sortableStyle={props.dragEnabled === false ? undefined : { transform: CSS.Transform.toString(transform), transition }}
      dragListeners={props.dragEnabled === false ? undefined : listeners}
      dragAttributes={props.dragEnabled === false ? undefined : attributes}
      dragActivatorRef={props.dragEnabled === false ? undefined : setActivatorNodeRef}
      dragging={props.dragEnabled === false ? false : isDragging}
      // DragOverlay 고스트가 커서에 들려 있으므로 원본 행은 빈 자리로 비운다.
      draggingAppearance="placeholder"
      dropIndicator={props.dragEnabled === false ? undefined : dropIndicator}
      trailingAction={<RowTrailing status={props.status} name={entry.name} onOpenMenu={handleOpenMenu} />}
    />
  );
});

/** 메모("빈칸") 행의 sortable 래퍼 — SortableQuoteRow 와 같은 계약(행 전체가 핸들).
 *  data.type='entry' 를 쓰지 **않는다**: 차트로 드롭·종목 교체 분기가 그 타입을 보고
 *  도는데 메모는 그 대상이 아니다. 대신 'memo' 로 태깅해 재배열에만 참여시킨다. */
const SortableMemoRow = memo(function SortableMemoRow(props: {
  folderId: string;
  memo: WatchlistMemo;
  autoEdit: boolean;
  onAutoEditConsumed: () => void;
  /** memoId 를 인자로 받는 **안정 참조** — SortableQuoteRow 와 같은 memo 계약이다. */
  onSave: (memoId: string, text: string) => void;
  onDelete: (memoId: string) => void;
  onOpenMenu: (e: React.MouseEvent, folderId: string, memo: WatchlistMemo) => void;
  dragEnabled: boolean;
}) {
  const { memo: row, onSave, onDelete, onOpenMenu, folderId } = props;
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging, activeIndex, overIndex, index } =
    useSortable({ id: memoSortableId(props.folderId, props.memo.id), data: { type: 'memo', folderId: props.folderId, memoId: props.memo.id } });
  const dropIndicator = activeIndex !== -1 && overIndex !== -1 && index === overIndex && index !== activeIndex
    ? (activeIndex < overIndex ? 'after' : 'before')
    : undefined;
  const off = !props.dragEnabled;
  const handleSave = useCallback((text: string) => onSave(row.id, text), [onSave, row.id]);
  const handleDelete = useCallback(() => onDelete(row.id), [onDelete, row.id]);
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onOpenMenu(e, folderId, row), [onOpenMenu, folderId, row]);
  return (
    <MemoRow
      text={props.memo.text}
      onSave={handleSave}
      onDelete={handleDelete}
      maxLength={WATCHLIST_MEMO_MAX_LEN}
      autoEdit={props.autoEdit}
      onAutoEditConsumed={props.onAutoEditConsumed}
      onContextMenu={handleContextMenu}
      testId={`watchlist-memo-${props.memo.id}`}
      sortableRef={off ? undefined : setNodeRef}
      sortableStyle={off ? undefined : { transform: CSS.Transform.toString(transform), transition }}
      dragListeners={off ? undefined : listeners}
      dragActivatorRef={off ? undefined : setActivatorNodeRef}
      dragging={off ? false : isDragging}
      draggingAppearance="placeholder"
      dropIndicator={off ? undefined : dropIndicator}
    />
  );
});

/** 드래그 고스트에 그릴 스냅샷. `onDragStart` 에서 한 번 찍고 드래그 내내 갱신하지
 *  않는다 — 데이터 동결과 같은 규율이고, 손에 든 것이 도중에 바뀌면 오히려 산만하다. */
type DragGhost =
  | {
      kind: 'entry'; name: string; status: DisplayStatus;
      price: number | null; pct: number | null;
      expectedPrice: number | null; expectedPct: number | null;
    }
  | { kind: 'memo'; text: string };

const GHOST_NOOP = () => {};

/**
 * 커서를 따라오는 드래그 고스트(P1).
 *
 * **없으면 어떤 문제인가**: 원본 행에 transform 을 걸어 움직이는 방식은 스크롤 컨테이너
 * (`RailDrawerBody` = `overflow-auto`) 경계에서 잘린다. 그래서 패널을 벗어나 차트 창으로
 * 끌고 가는 동안 손에 아무것도 없었다 — 목적지(창 하이라이트) 피드백만 있고 커서 쪽
 * 피드백이 비어 있었다.
 *
 * 폴더(그룹) 드래그는 고스트를 만들지 않는다. 이동이 패널 안에서만 일어나고 그룹 블록
 * 전체 클론은 크기만 크지 정보가 없다 — 기존 transform 방식이 이미 적절하다.
 */
function WatchlistDragGhost({ ghost }: { ghost: DragGhost }) {
  if (ghost.kind === 'memo') {
    return (
      <MemoRow
        text={ghost.text}
        onSave={GHOST_NOOP}
        onDelete={GHOST_NOOP}
        maxLength={WATCHLIST_MEMO_MAX_LEN}
        testId="watchlist-drag-ghost"
      />
    );
  }
  return (
    <QuoteRow
      name={ghost.name}
      price={ghost.price}
      pct={ghost.pct}
      changeWon={null}
      expectedPrice={ghost.expectedPrice}
      expectedPct={ghost.expectedPct}
      active={false}
      ariaLabel={ghost.name}
      testId="watchlist-drag-ghost"
      onClick={GHOST_NOOP}
      indented
      trailingAction={<RowTrailing status={ghost.status} name={ghost.name} onOpenMenu={GHOST_NOOP} />}
    />
  );
}

/**
 * Watchlist Panel (CONTEXT.md), app-wide via the Right Rail (ADR-0052).
 * Folder-grouped read+navigate: rows show the KIS live quote overlay (ADR-0056)
 * and click → activeCode + /live jump. The 편집 control opens a small menu
 * (관심 편집 → WatchlistEditModal, 새 그룹 만들기 → GroupNameModal); group
 * headers carry a hover ⋯ menu (이름 변경/순서/삭제), and the row context menu
 * does quick-remove + 그룹으로 이동. Entry add/multi-delete and cross-folder
 * move live in the edit modal; quick within-group reorder (drag a row) and
 * folder reorder (drag a group via its ⠿ handle) happen in-panel via dnd-kit
 * (ADR-0066). Collapse state persists via localStorage.
 */
export function WatchlistDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  const { data: liveData, isLoading, error } = useWatchlist();
  // --- 드래그 중 입력 동결(P2) ---
  // 드래그가 시작되면 서버 데이터·시세·수집상태를 freeze 시점 값으로 고정한다. WS 체결
  // 틱은 150ms 마다 계속 리렌더를 걸지만(liveTickOverlay 의 setTick — 이건 못 막는다),
  // **입력 참조가 그대로면** 아래 useMemo 들이 전부 캐시 히트라 rows·sortableIds·행 props
  // 가 동일해지고, memo 된 행이 리렌더를 건너뛰어 dnd-kit transform transition 이 진행
  // 중에 재시작되지 않는다. 동결은 리렌더를 없애는 게 아니라 **싸게** 만드는 장치다.
  // 60초 refetch 가 드래그 도중 착지해 순서를 뒤흔드는 것도 같이 막힌다. 대가는 드래그
  // 하는 몇 초 동안 가격이 멈추는 것이고, 히트맵이 이미 같은 거래를 했다(같은 훅).
  const [isDragging, setIsDragging] = useState(false);
  const data = useFrozenWhileDragging(liveData, isDragging);
  const catchupAllM = useCatchupAll();
  const removeM = useRemoveFromWatchlist();
  const createM = useCreateFolder();
  const renameM = useRenameFolder();
  const deleteM = useDeleteFolder();
  const reorderFoldersM = useReorderFolders();
  const { recentAction, setRecentAction } = useWatchlistFeedback();
  // 접기 상태는 localStorage 영속 — 패널을 닫았다 열어도(언마운트) 유지된다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const saved = readJsonObject('watchlist.collapsed');
    const keys = Array.isArray(saved.keys) ? saved.keys.filter((k): k is string => typeof k === 'string') : [];
    return new Set(keys);
  });
  const [editOpen, setEditOpen] = useState(false);
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [groupSortModes, setGroupSortModes] = useState<FolderSortModeMap>(() => readFolderSortModeMapFromStorage());
  const [menu, setMenu] =
    useState<{ x: number; y: number; code: string; name: string; folderId: string | null } | null>(null);
  // v3 "그룹 편집" — 행 메뉴/하트가 여는 멤버십 피커(ADR-0070 P5).
  const [groupPicker, setGroupPicker] =
    useState<{ code: string; name: string; x: number; y: number } | null>(null);
  // 메모("빈칸") 행 우클릭 메뉴(v5). 종목 행 메뉴와 항목이 달라 state 를 따로 둔다 —
  // 하나로 합치면 두 메뉴의 필드가 서로 optional 이 되어 어느 쪽이 열렸는지 흐려진다.
  const [memoMenu, setMemoMenu] = useState<
    { x: number; y: number; folderId: string; memoId: string; text: string } | null>(null);
  // 행 우클릭이 여는 종목 검색 팝오버(v5). **앵커를 인덱스가 아니라 id 로 들고 있는다** —
  // 팝오버가 열려 있는 동안 60초 폴링이 order 를 바꿀 수 있어, 열 때 얼린 숫자는
  // 엉뚱한 자리를 가리킨다. 실제 인덱스는 submit 시점에 resolveInsertAt 이 다시 읽는다.
  const [symbolInsert, setSymbolInsert] = useState<{
    x: number; y: number; folderId: string;
    anchor: { kind: 'entry'; code: string } | { kind: 'memo'; id: string };
  } | null>(null);

  // 메모("빈칸") 행 — entries 와 같은 order 축(폴더 items 인덱스)이라 렌더 직전에 병합한다.
  // `?? []` 를 useMemo 로 감싸는 이유: 매 렌더 새 빈 배열이면 아래 파생 memo 가 전부
  // 무효화돼 동결이 무의미해진다.
  const memos = useMemo(() => data?.memos ?? [], [data]);
  const addMemoM = useAddMemo();
  const updateMemoM = useUpdateMemo();
  const removeMemoM = useRemoveMemo();
  // 갓 만든 빈칸은 즉시 편집 모드로 연다(추가 → 바로 입력). 서버가 준 id 를 한 번만
  // 쓰고 지운다 — 남겨 두면 폴링 리페치마다 그 행이 다시 편집 모드로 열린다.
  const [justAddedMemoId, setJustAddedMemoId] = useState<string | null>(null);
  // effect dep 로 들어가므로 참조가 매 렌더 바뀌면 안 된다.
  const clearJustAddedMemo = useCallback(() => setJustAddedMemoId(null), []);
  const addMemoAt = (folderId: string, at?: number) => {
    addMemoM.mutate({ folderId, at }, { onSuccess: (m) => setJustAddedMemoId(m.id) });
  };

  // 다중 소속이라 한 코드가 여러 폴더 행으로 등장 → quote 폴링용 코드는 dedup.
  const codes = useMemo(() => [...new Set(data?.entries.map((e) => e.code) ?? [])], [data]);
  const venue = useLiveVenueStore((s) => s.venue);
  const liveQuoteByCode = useQuoteByCode(codes, venue);
  const quoteByCode = useFrozenWhileDragging(liveQuoteByCode, isDragging);

  // ADR-0067: 행별 수집상태 배지 — live_set을 한 번 읽어 공유 (행마다 재계산 없음).
  const { data: liveStatusRaw } = useLiveStatus();
  const liveStatusData = useFrozenWhileDragging(liveStatusRaw, isDragging);

  // 행별 수집상태를 **한 번에** 계산해 스칼라로 넘긴다 — 행에 배열(live_set 등)을
  // 넘기면 `?? []` 가 매 렌더 새 identity 라 memo 가 뚫린다. 키가 code 가 아니라
  // composite id 인 이유: 같은 코드가 여러 폴더에 있을 수 있고 `capture_candidate` 는
  // 폴더별 엔트리 속성이라 결과가 갈릴 수 있다.
  const collectionByRow = useMemo(() => {
    const liveSet = liveStatusData?.live_set ?? [];
    const kiwoomCodes = liveStatusData?.kiwoom?.subscribed_codes ?? [];
    const viewedCodes = activeCode ? [activeCode] : [];
    const map = new Map<string, { displayStatus: DisplayStatus; ariaLabel: string }>();
    for (const entry of data?.entries ?? []) {
      const view = deriveCollectionView({
        code: entry.code,
        liveSet,
        watchlistCodes: codes,
        viewedCodes,
        kiwoomCodes,
        captureCandidate: entry.capture_candidate !== false,
      });
      map.set(entrySortableId(entry.folder_id, entry.code), {
        displayStatus: view.displayStatus,
        ariaLabel: view.ariaLabel,
      });
    }
    return map;
  }, [data, liveStatusData, codes, activeCode]);

  // 함수형 업데이터 — 같은 배치의 다중 toggle도 최신 Set 위에서 계산된다.
  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // 영속화는 상태 변화에 반응. 기록 시점에 실존 그룹 키만 남겨 삭제된 그룹의
  // 키가 localStorage에 누적되지 않게 한다(메모리의 inert 키는 다음 마운트에서 소멸).
  useEffect(() => {
    const valid = data ? new Set([...data.folders.map((f) => f.id), '__uncat__']) : null;
    persistJson('watchlist.collapsed', { keys: [...collapsed].filter((k) => !valid || valid.has(k)) });
  }, [collapsed, data]);
  const openMenu = useCallback(
    (e: React.MouseEvent, code: string, name: string, folderId: string | null) => {
      e.preventDefault();                                 // 네이티브 우클릭 메뉴 억제
      setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });  // raw 좌표 — 클램프는 메뉴가 실측
    },
    [],
  );

  // 폴더별 정렬 모드가 아직 없을 때 쓰는 이월값(구 전역 설정). 아래 renderGroups 가
  // 읽으므로 그보다 먼저 선언한다.
  const migrationSortMode = readSortModeFromStorage();
  // 폴더의 유효 정렬 모드. renderGroups(아래)·onDragEnd·행 메뉴가 **같은 하나**를 쓴다 —
  // 렌더용 사본을 따로 두면 게이트가 조용히 갈린다. useCallback 인 이유는 renderGroups
  // 의 dep 이라서다: 매 렌더 새 함수면 그 memo 가 매번 무효화돼 동결이 무의미해진다.
  const getFolderSortMode = useCallback((folderId: string | null): QuoteSortMode => {
    if (folderId === null) return 'default';
    return groupSortModes[folderId] ?? migrationSortMode;
  }, [groupSortModes, migrationSortMode]);

  // 그룹 → 표시 행 → sortable id 까지를 **한 memo 안에서** 만든다.
  //
  // `sortableIds` 가 특히 중요하다: 이 배열 identity 가 매 렌더 바뀌면 SortableContext 의
  // context value 가 새로 생기고, **context 구독은 React.memo 를 뚫는다** — 행을 memo 로
  // 감싸도 모든 useSortable 이 리렌더되는 경로라 행 최적화만으로는 못 막는다.
  //
  // 접힘 여부(`collapsed`)는 여기 넣지 않는다 — 행 계산과 무관하고, deps 에 넣으면 접기
  // 토글마다 전 그룹이 재계산된다(원본도 접힌 그룹의 rows 를 계산해 두고 렌더만 걸렀다).
  const renderGroups = useMemo(() => {
    if (!data) return [];
    const pctOf = makeChangePctOf(quoteByCode);
    return data ? groupByFolder(data.folders, data.entries).map((g) => {
      const folder = g.folder;
      const sortMode = getFolderSortMode(folder?.id ?? null);
      const rowDragEnabled = sortMode === 'default';
      const displayEntries = sortEntriesByChangePct(g.entries, pctOf, sortMode);
      // 정렬 모드(등락률)면 메모를 **숨긴다** — 위치가 의미를 잃기 때문이다(행 드래그가
      // 이미 같은 조건에서 꺼지는 것과 같은 게이트). 게이트를 병합 **전에** 두는 것이
      // 중요하다: 병합 후 필터링하면 sortEntriesByChangePct(rightrail 공유 유틸)가
      // PanelRow 유니온을 알게 된다.
      const rows: PanelRow[] = rowDragEnabled && folder
        ? mergePanelRows(displayEntries, memosOfFolder(memos, folder.id))
        : displayEntries.map((entry) => ({ kind: 'entry', entry }));
      return {
        key: folder?.id ?? '__uncat__',
        label: folder?.name ?? '미분류',
        folder,
        count: g.entries.length,
        sortMode,
        rowDragEnabled,
        rows,
        sortableIds: rows.map((r) => (r.kind === 'entry'
          ? entrySortableId(r.entry.folder_id, r.entry.code)
          : memoSortableId(folder!.id, r.memo.id))),
      };
    }) : [];
  }, [data, quoteByCode, getFolderSortMode, memos]);
  const folderCount = data?.folders.length ?? 0;
  const realFolderIds = useMemo(
    () => renderGroups.filter((g) => g.folder).map((g) => g.folder!.id),
    [renderGroups],
  );

  // 전체 접기/펼치기 — 대상은 **화면에 실제로 렌더되는 그룹**이다(아래 렌더에서 빈 미분류는
  // 숨기므로 제외). collapsed.size 로 "모두 접힘"을 판정하면 삭제된 그룹의 inert 키(위 persist
  // 주석 참조 — 메모리 Set 은 다음 마운트까지 정리되지 않는다)에 걸려 거짓 양성이 난다.
  const visibleGroupKeys = renderGroups
    .filter((g) => !(g.count === 0 && g.folder === null))
    .map((g) => g.key);
  const allCollapsed =
    visibleGroupKeys.length > 0 && visibleGroupKeys.every((k) => collapsed.has(k));
  const toggleAll = () =>
    setCollapsed((s) => {
      const n = new Set(s);
      for (const k of visibleGroupKeys) {
        if (allCollapsed) n.delete(k);
        else n.add(k);
      }
      return n;
    });
  useEffect(() => {
    if (!data) return;
    const folderIds = data?.folders.map((f) => f.id) ?? [];
    const seen = new Set(folderIds);
    const next: FolderSortModeMap = {};
    let changed = false;
    folderIds.forEach((id) => {
      const prev = groupSortModes[id];
      if (isQuoteSortMode(prev)) {
        next[id] = prev;
      } else {
        next[id] = migrationSortMode;
        changed = true;
      }
    });
    Object.keys(groupSortModes).forEach((id) => {
      if (!seen.has(id)) changed = true;
    });
    if (!changed && folderIds.every((id) => groupSortModes[id] === next[id])) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time storage migration prunes deleted folder keys after server data loads.
    setGroupSortModes(next);
  }, [data, groupSortModes, migrationSortMode]);

  useEffect(() => {
    persistJson(FOLDER_SORT_MODE_STORAGE_KEY, groupSortModes);
  }, [groupSortModes]);

  const setFolderSortMode = (folderId: string, mode: QuoteSortMode) => {
    setGroupSortModes((prev) => {
      if (prev[folderId] === mode) return prev;
      return { ...prev, [folderId]: mode };
    });
  };

  const moveFolder = (folderId: string, dir: -1 | 1) => {
    const ids = swapFolderOrder(data?.folders ?? [], folderId, dir);
    if (ids) reorderFoldersM.mutate(ids);
  };

  // v3 폴더 삭제는 파괴적(ADR-0070 P6): 이 폴더에만 있는 코드는 관심종목에서 빠진다.
  // 고아가 생기면 명시적으로 확인(ADR-0065 정신 — 조용한 유실 금지).
  // 고아 수는 **확인을 띄우는 시점에 얼려서** state 에 담는다 — 모달이 떠 있는 동안
  // 폴링으로 `data` 가 갱신되면 다시 센 값이 흔들려 사용자가 읽은 숫자와 어긋난다.
  const [deleteConfirm, setDeleteConfirm] = useState<{ folderId: string; orphanCount: number } | null>(null);
  const deleteFolderWithConfirm = (folderId: string) => {
    const orphanCount = countOrphansIfFolderDeleted(data?.entries ?? [], folderId);
    if (orphanCount > 0) {
      setDeleteConfirm({ folderId, orphanCount });
      return;
    }
    deleteM.mutate(folderId);
  };

  const reorderItemsM = useReorderItems();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // --- 행에 넘길 안정 콜백(P2) ---
  // 행을 memo 로 감싸도 콜백이 매 렌더 새로 생기면 props 비교가 실패해 그냥 무효다.
  // `useJumpToLive()` 는 **매 렌더 새 함수를 반환**하므로(navigate/pathname 클로저) 그대로
  // 넘길 수 없다 — latest ref 로 받아 호출 시점에 최신 것을 쓴다. 나머지는 mutation 의
  // `mutate`(react-query 가 안정 참조로 보장)와 useCallback 으로 고정한다.
  const onPickRef = useRef(onPick);
  useEffect(() => { onPickRef.current = onPick; });
  const removeMutate = removeM.mutate;
  const updateMemoMutate = updateMemoM.mutate;
  const removeMemoMutate = removeMemoM.mutate;
  const handleRowPick = useCallback((entry: WatchlistEntry, e?: JumpModifiers) => {
    onPickRef.current(entry.code, entry.name, e);
  }, []);
  const handleRowMenu = useCallback((e: React.MouseEvent, entry: WatchlistEntry) => {
    openMenu(e, entry.code, entry.name, entry.folder_id);
  }, [openMenu]);
  const handleRowDelete = useCallback((entry: WatchlistEntry) => {
    removeMutate(entry.code);
  }, [removeMutate]);
  const handleMemoSave = useCallback((memoId: string, text: string) => {
    updateMemoMutate({ memoId, text });
  }, [updateMemoMutate]);
  const handleMemoDelete = useCallback((memoId: string) => {
    removeMemoMutate(memoId);
  }, [removeMemoMutate]);
  const handleMemoMenu = useCallback((e: React.MouseEvent, folderId: string, memo: WatchlistMemo) => {
    e.preventDefault();                                  // 네이티브 우클릭 메뉴 억제
    setMemoMenu({ x: e.clientX, y: e.clientY, folderId, memoId: memo.id, text: memo.text });
  }, []);

  /** 열려 있는 삽입 팝오버의 items 인덱스를 **지금** 다시 읽는다(submit 시점 호출).
   *  앵커 행이 그 사이 사라졌으면 undefined → 백엔드가 맨 아래로 클램프한다. */
  const resolveInsertAt = useCallback((): number | undefined => {
    if (!symbolInsert) return undefined;
    const { folderId, anchor } = symbolInsert;
    return anchor.kind === 'entry'
      ? data?.entries.find((e) => e.folder_id === folderId && e.code === anchor.code)?.order
      : data?.memos.find((m) => m.folder_id === folderId && m.id === anchor.id)?.order;
  }, [symbolInsert, data]);

  // "차트로 드롭" 공유 상태 — WorkspaceCanvas가 구독해 드롭 타깃 오버레이를 띄운다.
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);

  // 드래그 좌표는 프레임당 한 번만 발행한다(P3) — 우측 레일 세 드로어 공용 훅.
  const { publishDragPoint, cancelDragPointFlush } = useDragPointPublisher();

  // 커서를 따라오는 고스트의 스냅샷(P1). null = 고스트 없음(폴더 드래그 포함).
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  // 직전 드롭이 차트 위였는가 — true 면 낙하 애니메이션을 끈다(onDragEnd 주석 참조).
  // 취소(onDragCancel)는 false 로 남겨 둔다: 취소는 원위치로 돌아가는 게 맞다.
  const [ghostDroppedOnChart, setGhostDroppedOnChart] = useState(false);

  const onDragStart = (ev: DragStartEvent) => {
    setIsDragging(true);
    setGhostDroppedOnChart(false);   // 직전 드래그의 판정이 새 드래그로 새지 않게
    const d = ev.active.data.current;
    if (d?.type === 'entry') {
      startEntryDrag(String(ev.active.id));
      const code = String(d.code ?? '');
      const q = quoteByCode.get(code);
      setDragGhost({
        kind: 'entry',
        name: String(d.name ?? code),
        status: collectionByRow.get(String(ev.active.id))?.displayStatus ?? 'realtime',
        price: q?.price ?? null,
        pct: q?.change_pct ?? null,
        expectedPrice: q?.expected_price ?? null,
        expectedPct: q?.expected_change_pct ?? null,
      });
      return;
    }
    if (d?.type === 'memo') {
      const parsed = parseItemSortableId(String(ev.active.id));
      const text = parsed.kind === 'memo'
        ? (memos.find((m) => m.id === parsed.memoId)?.text ?? '')
        : '';
      setDragGhost({ kind: 'memo', text });
      return;
    }
    setDragGhost(null);   // 폴더는 그룹 블록 transform 이 이미 적절하다
  };
  const onDragMove = (ev: DragMoveEvent) => {
    // 메모 행은 차트 드롭 대상이 아니다 — 'entry' 타입만 오버레이를 띄운다.
    if (ev.active.data.current?.type !== 'entry') return;
    publishDragPoint(dropPoint(ev)); // 창별 어포던스: 캔버스가 좌표로 호버 창을 계산한다.
  };
  const finishDrag = () => {
    cancelDragPointFlush();
    setIsDragging(false);
    setDragGhost(null);
    endEntryDrag();
  };
  const onDragCancel = () => finishDrag();

  const onDragEnd = (ev: DragEndEvent) => {
    const activeType = ev.active.data.current?.type;
    const wasEntry = activeType === 'entry';
    const wasMemo = activeType === 'memo';
    // 낙하 애니메이션 여부를 **지우기 전에** 확정한다. finishDrag() 안의 endEntryDrag()
    // 가 store 의 overChart 를 false 로 되돌리는데, 그 갱신은 dnd-kit 의 active→null 과
    // 같은 커밋에 착지한다 — store 를 그대로 읽으면 차트에 성공적으로 떨궈도 항상
    // "되돌아가는 비행"이 재생돼 성공이 실패로 읽힌다. 판정식은 아래 드롭 분기와
    // **같은 술어**라 둘이 갈릴 수 없다.
    setGhostDroppedOnChart(wasEntry && isPointOnChart(dropPoint(ev)));
    // 낙하 애니메이션 여부를 **지우기 전에** 확정한다. finishDrag() 안의 endEntryDrag()
    // 가 store 의 overChart 를 false 로 되돌리는데, 그 갱신은 dnd-kit 의 active→null 과
    // 같은 커밋에 착지한다 — store 를 그대로 읽으면 차트에 성공적으로 떨궈도 항상
    // "되돌아가는 비행"이 재생돼 성공이 실패로 읽힌다. 판정식은 아래 드롭 분기와
    // **같은 술어**라 둘이 갈릴 수 없다.
    finishDrag();
    if ((wasEntry || wasMemo)
        && getFolderSortMode(parseItemSortableId(String(ev.active.id)).folderId) !== 'default') return;
    // 종목 행을 차트 위에 드롭 → 종목 교체(재정렬 대신). 창 위 드롭이면 그 창 그룹 교체
    // (정밀 드롭, #711), 창 밖(캔버스 여백)이면 활성 그룹 교체(onPick, /live 위라 navigate no-op).
    // 메모는 이 분기를 타지 않는다 — 차트에 실을 종목이 없다.
    if (wasEntry && isPointOnChart(dropPoint(ev))) {
      const d = ev.active.data.current as { code?: string; name?: string } | undefined;
      const parsed = parseItemSortableId(String(ev.active.id));
      const code = d?.code ?? (parsed.kind === 'code' ? parsed.code : '');
      if (!code) return;
      if (resolveDropOnChart(dropPoint(ev), { code, name: d?.name })) return;
      onPick(code, d?.name);
      return;
    }
    if (!ev.over) return;
    if (ev.active.data.current?.type === 'folder') {
      // 현재 typeAwareCollision이 폴더 드래그의 over를 항상 폴더 컨테이너로 보장하므로
      // 정상 경로에선 over가 폴더 id다. over.folderId fallback과 null 가드는 collision
      // 전략이 바뀔 때를 대비한 defense-in-depth(미분류는 useSortable 노드가 아니라
      // over로 등장하지 않음).
      const over = ev.over.data.current;
      const overFolderId = over?.type === 'folder'
        ? String(ev.over.id)
        : ((over?.folderId ?? null) as string | null);
      if (overFolderId == null) return;
      const fr = resolveFolderDrag(realFolderIds, String(ev.active.id), overFolderId);
      if (fr.kind === 'reorder') reorderFoldersM.mutate(fr.orderedIds);
      return;
    }
    // v4 composite id: `${folderId}:${code|memoId}` — 같은 코드가 N폴더면 N행이라
    // 폴더 스코프로 파싱하고, 키 모양으로 종목/메모를 가른다.
    const active = parseItemSortableId(String(ev.active.id));
    const over = parseItemSortableId(String(ev.over.id));
    const folderId = active.folderId;
    if (folderId === null) return;   // 미분류엔 메모가 없고 재정렬 대상도 아니다
    // 화면에 보이는 순서(종목+메모)를 그대로 옮긴다 — 서버 계약이 items 전체 집합
    // 일치를 요구하므로 한쪽만 보내면 409 다.
    const rows = mergePanelRows(
      (data?.entries ?? []).filter((e) => e.folder_id === folderId).sort((a, b) => a.order - b.order),
      memosOfFolder(memos, folderId),
    );
    const keyOf = (p: typeof active) => (p.kind === 'code' ? p.code : p.memoId);
    const from = rows.findIndex((r) => panelRowKey(r) === keyOf(active));
    const to = rows.findIndex((r) => panelRowKey(r) === keyOf(over));
    if (from < 0 || to < 0 || from === to) return;
    const moved = [...rows];
    moved.splice(to, 0, ...moved.splice(from, 1));
    reorderItemsM.mutate({ folderId, orderedItems: toItemRefs(moved) });
  };

  return (
    <RailDrawer id="right-rail-watchlist-panel" testId="watchlist-panel" ariaLabel="관심종목">
      <RailDrawerHeader
        title="관심종목"
        actions={(
          // 생성(새 그룹)은 편집 메뉴에 숨어 2클릭이던 것을 헤더 직접 + 버튼으로 승격
          // (히트맵 보드의 "+ 새 그룹" 과 표면 일치). 남은 편집은 항목 하나뿐이라
          // 메뉴를 없애고 "편집"이 관심 편집 모달을 바로 연다.
          <div className="flex items-center gap-2">
            {/* 히트맵 드로어는 검색 툴바가 있어 거기에, 여기는 툴바가 없어 헤더에 둔다.
                두 드로어 모두 "그룹 일괄 접기"라는 같은 문법·같은 aria 문구를 쓴다. */}
            <button type="button" data-testid="watchlist-toggle-all"
                    aria-label={allCollapsed ? '전체 펼치기' : '전체 접기'}
                    title={allCollapsed ? '전체 펼치기' : '전체 접기'}
                    onClick={toggleAll}
                    disabled={visibleGroupKeys.length === 0}
                    className="grid h-5 w-5 place-items-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim">
              {allCollapsed ? <ExpandAllIcon className="h-3.5 w-3.5" /> : <CollapseAllIcon className="h-3.5 w-3.5" />}
            </button>
            <button type="button" aria-label="새 그룹 만들기" title="새 그룹 만들기"
                    onClick={() => setAddGroupOpen(true)}
                    className="grid h-5 w-5 place-items-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg">
              <PlusIcon />
            </button>
            <button type="button" aria-label="관심종목 편집"
                    onClick={() => setEditOpen(true)}
                    className="text-xs text-fg-dim hover:text-accent">
              편집
            </button>
          </div>
        )}
      />

      <RailDrawerBody testId="watchlist-scroll" quoteNav>
        {isLoading && <RailState>불러오는 중</RailState>}
        {error && <RailState tone="error">관심종목을 불러올 수 없습니다</RailState>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <RailState>관심종목이 없습니다</RailState>
        )}
        <DndContext sensors={sensors} collisionDetection={typeAwareCollision}
          onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          <SortableContext items={realFolderIds} strategy={verticalListSortingStrategy}>
            {renderGroups.map((g, gi) => {
              const { key, label, folder, rows, rowDragEnabled } = g;
              if (g.count === 0 && folder === null) return null; // 빈 미분류는 숨김
              const isCollapsed = collapsed.has(key);
              const entriesList = !isCollapsed && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  <SortableContext items={g.sortableIds} strategy={verticalListSortingStrategy}>
                    {rows.map((row) => {
                      if (row.kind === 'memo') {
                        return (
                          <SortableMemoRow
                            key={memoSortableId(folder!.id, row.memo.id)}
                            folderId={folder!.id}
                            memo={row.memo}
                            autoEdit={row.memo.id === justAddedMemoId}
                            onAutoEditConsumed={clearJustAddedMemo}
                            onSave={handleMemoSave}
                            onDelete={handleMemoDelete}
                            onOpenMenu={handleMemoMenu}
                            dragEnabled={rowDragEnabled}
                          />
                        );
                      }
                      const entry = row.entry;
                      const rowId = entrySortableId(entry.folder_id, entry.code);
                      const q = quoteByCode.get(entry.code);
                      const collection = collectionByRow.get(rowId);
                      return (
                        <SortableQuoteRow
                          key={rowId}
                          entry={entry}
                          price={q?.price ?? null}
                          pct={q?.change_pct ?? null}
                          changeWon={q?.change_won ?? null}
                          expectedPrice={q?.expected_price ?? null}
                          expectedPct={q?.expected_change_pct ?? null}
                          active={entry.code === activeCode}
                          status={collection?.displayStatus ?? 'realtime'}
                          collectionLabel={collection?.ariaLabel}
                          onPick={handleRowPick}
                          onOpenMenu={handleRowMenu}
                          onDelete={handleRowDelete}
                          dragEnabled={rowDragEnabled}
                        />
                      );
                    })}
                  </SortableContext>
                </ul>
              );
              const renderHeader = (dragHandle?: GroupDragHandle) => (
                <GroupHeader label={label} count={g.count} collapsed={isCollapsed}
                  onToggle={() => toggle(key)}
                  onRename={folder ? () => setRenameTarget({ id: folder.id, name: folder.name }) : undefined}
                  onDelete={folder ? () => deleteFolderWithConfirm(folder.id) : undefined}
                  onMoveUp={folder ? () => moveFolder(folder.id, -1) : undefined}
                  onMoveDown={folder ? () => moveFolder(folder.id, +1) : undefined}
                  onAddMemo={folder ? () => addMemoAt(folder.id) : undefined}
                  canMoveUp={gi > 0}
                  canMoveDown={gi < folderCount - 1}
                  sortMode={g.sortMode}
                  onSort={folder ? (mode) => setFolderSortMode(folder.id, mode) : undefined}
                  folderId={folder?.id}
                  dragHandle={dragHandle} />
              );
              return folder ? (
                <SortableGroup key={key} folderId={folder.id}>
                  {(dragHandle) => (<>{renderHeader(dragHandle)}{entriesList}</>)}
                </SortableGroup>
              ) : (
                <div key={key}>{renderHeader()}{entriesList}</div>
              );
            })}
          </SortableContext>
          {/* 커서를 따라오는 고스트(P1) — 포털·낙하 애니메이션 결정은 공용 껍데기가 갖는다. */}
          <RailDragOverlay droppedOnChart={ghostDroppedOnChart}>
            {dragGhost && <WatchlistDragGhost ghost={dragGhost} />}
          </RailDragOverlay>
        </DndContext>
      </RailDrawerBody>

      {/* 푸터: 전체수집 결과 배너 + 다음 수집 카운트다운 + 전체 수집 */}
      <RailDrawerSection className="border-b-0 border-t p-0">
        {recentAction?.kind === 'caught_up_all' && (() => {
          const s = summarizeCaughtUpAll(recentAction.summary);
          return (
            <div className="px-3 py-2">
              <Banner kind={s.failed.length > 0 ? 'error' : 'success'}>
                <div>{formatCaughtUpAllHeader(s)}</div>
                {s.failed.length > 0 && (
                  <ul className="mt-1 text-xs">
                    {s.failed.map((r) => (
                      <li key={r.code}>{r.code} {r.name}: {r.error?.code ?? 'failed'}</li>
                    ))}
                  </ul>
                )}
              </Banner>
            </div>
          );
        })()}
        <div className="flex items-center justify-between gap-2 px-md py-sm text-xs text-fg-dim">
          <span className="flex items-center gap-1">다음 수집{' '}
            {data && <span className="text-accent"><Countdown targetMs={data.next_run_at_ms} /></span>}</span>
          <button type="button"
            onClick={() => catchupAllM.mutate(undefined, {
              onSuccess: (r) => setRecentAction({ kind: 'caught_up_all', summary: r.results }),
            })}
            disabled={catchupAllM.isPending || (data?.entries.length ?? 0) === 0}
            className="px-2 py-0.5 rounded border border-border hover:text-accent hover:border-accent disabled:opacity-40">
            {/* spin only the glyph, not the text label (DESIGN.md motion) */}
            <span className={`inline-block ${catchupAllM.isPending ? 'animate-spin' : ''}`}>↻</span> 전체 수집
          </button>
        </div>
      </RailDrawerSection>

      {menu && (
        <WatchlistRowMenu x={menu.x} y={menu.y} name={menu.name}
          onEditGroups={() => setGroupPicker({ code: menu.code, name: menu.name, x: menu.x, y: menu.y })}
          onRemove={() => removeM.mutate(menu.code)}
          // 이 행이 차지한 items 인덱스에 삽입 → 기존 행은 한 칸 밀린다("위에" 삽입).
          //
          // 두 경우에 항목을 아예 띄우지 않는다:
          // 1. 미분류 행 — 담을 폴더가 없다.
          // 2. 등락률 정렬이 켜진 그룹 — 화면 순서(등락률)와 `order`(저장 순서)가
          //    다르므로 "위에" 가 사용자가 본 자리를 가리키지 않는다. 게다가 정렬
          //    모드에선 메모행이 숨겨져 결과도 안 보인다 → "눌렀는데 아무 일도 안
          //    일어났고, 정렬을 풀면 엉뚱한 자리에 빈칸이 있다" 가 된다.
          //    드래그·메모 표시와 같은 게이트다.
          onInsertMemoAbove={menu.folderId && getFolderSortMode(menu.folderId) === 'default' ? () => {
            const row = data?.entries.find((e) => e.folder_id === menu.folderId && e.code === menu.code);
            addMemoAt(menu.folderId!, row?.order);
          } : undefined}
          // "위에 종목 추가" — 빈칸 삽입과 **같은 게이트**를 쓴다(위 주석의 두 경우).
          // 여기선 인덱스를 계산하지 않고 앵커 코드만 넘긴다: 검색 팝오버가 떠 있는
          // 동안 순서가 바뀔 수 있어 submit 시점에 resolveInsertAt 이 다시 읽는다.
          onAddSymbolAbove={menu.folderId && getFolderSortMode(menu.folderId) === 'default' ? () => {
            setSymbolInsert({
              x: menu.x, y: menu.y, folderId: menu.folderId!,
              anchor: { kind: 'entry', code: menu.code },
            });
          } : undefined}
          onClose={() => setMenu(null)} />
      )}
      {memoMenu && (
        <WatchlistMemoRowMenu x={memoMenu.x} y={memoMenu.y} text={memoMenu.text}
          onFillWithSymbol={() => setSymbolInsert({
            x: memoMenu.x, y: memoMenu.y, folderId: memoMenu.folderId,
            anchor: { kind: 'memo', id: memoMenu.memoId },
          })}
          onInsertMemoAbove={() => {
            const row = data?.memos.find((m) => m.id === memoMenu.memoId);
            addMemoAt(memoMenu.folderId, row?.order);
          }}
          onDelete={() => removeMemoMutate(memoMenu.memoId)}
          onClose={() => setMemoMenu(null)} />
      )}
      {symbolInsert && (
        <WatchlistSymbolAddPopover
          point={{ x: symbolInsert.x, y: symbolInsert.y }}
          folderId={symbolInsert.folderId}
          resolveAt={resolveInsertAt}
          // 빈칸 경로는 **추가 성공 후에** 그 빈칸을 지운다 = "교체". 순서가 중요하다:
          // 먼저 지우면 추가가 실패했을 때 자리도 내용도 사라진다(되돌릴 근거가 없다).
          // 반대 순서의 실패는 "종목은 들어갔고 빈칸이 남았다" 라 눈에 보이고 지울 수 있다.
          onAdded={() => {
            if (symbolInsert.anchor.kind === 'memo') removeMemoMutate(symbolInsert.anchor.id);
            setSymbolInsert(null);
          }}
          onClose={() => setSymbolInsert(null)} />
      )}
      {groupPicker && (
        <WatchlistGroupPicker code={groupPicker.code} name={groupPicker.name}
          x={groupPicker.x} y={groupPicker.y} onClose={() => setGroupPicker(null)} />
      )}
      {editOpen && <WatchlistEditModal onClose={() => setEditOpen(false)} />}
      {addGroupOpen && (
        <GroupNameModal title="그룹 추가하기" submitLabel="추가" busy={createM.isPending}
          onSubmit={async (name) => { await createM.mutateAsync(name); }}
          onClose={() => setAddGroupOpen(false)} />
      )}
      {renameTarget && (
        <GroupNameModal title="그룹 이름 변경" submitLabel="변경"
          initialName={renameTarget.name} busy={renameM.isPending}
          onSubmit={async (name) => { await renameM.mutateAsync({ folderId: renameTarget.id, name }); }}
          onClose={() => setRenameTarget(null)} />
      )}
      {deleteConfirm && (
        <FolderDeleteConfirm
          orphanCount={deleteConfirm.orphanCount}
          onConfirm={() => { deleteM.mutate(deleteConfirm.folderId); setDeleteConfirm(null); }}
          onClose={() => setDeleteConfirm(null)} />
      )}
    </RailDrawer>
  );
}

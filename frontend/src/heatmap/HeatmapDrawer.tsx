import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  useDraggable, useDroppable,
  type DragEndEvent, type CollisionDetection, type DraggableAttributes, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { resolveFolderDrag, folderDroppableId } from '../watchlist/dragHandlers';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { persistJson, readJsonObject } from '../state/persist';
import { swapFolderOrder } from '../watchlist/grouping';
import { GroupNameModal } from '../watchlist/GroupNameModal';
import { QuoteRow } from '../rightrail/QuoteRow';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailState } from '../ui/RailShell';
import { TrashIcon } from '../ui/TrashIcon';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { HeatmapRowMenu } from './HeatmapRowMenu';
import { useAddToFolder } from './useAddToFolder';
import { SortCycleButton } from './SortCycleButton';
import { HeatmapSearchInput } from './HeatmapSearchInput';
import { priceDirClass } from '../ui/priceDir';
import { ChevronIcon } from '../ui/ChevronIcon';
import { filterGroups } from './filterGroups';
import { sortEntries, avgPct, groupHeatmapEntries, orderFolderGroups, makePctOf, nextSort } from './heat';
import {
  useHeatmap, useRemoveFromHeatmap, useMoveHeatmapEntries,
  useCreateHeatmapFolder, useRenameHeatmapFolder, useDeleteHeatmapFolder,
  useReorderHeatmapFolders,
} from './useHeatmap';

const COLLAPSE_STORAGE_KEY = 'heatmapDrawer.collapsed';

// --- 아이콘 (WatchlistDrawer 의 module-private glyph 들과 동일 계약: SVG 로 통일해
//     폰트별 유니코드 렌더 불일치를 피한다). chevron 은 ui/ChevronIcon 공유 프리미티브
//     (ADR-0110)로 이관 — 과거 "watchlist 를 건드리지 않으려는" 사본 근거는 중립
//     ui/ 모듈이 생기며 소멸했다. ---
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

/** 우측 정렬 앵커드 메뉴 셸 — WatchlistDrawer.AnchoredMenu 사본(독립 표면). */
function AnchoredMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="menu" aria-label={label}
      className="absolute right-0 z-30 mt-1 bg-bg-card border border-border rounded shadow-lg py-1 min-w-[150px]">
      <div className="px-3 py-1 text-xs text-fg-dimmer">{label}</div>
      {children}
    </div>
  );
}

/** 그룹 헤더에 부착할 드래그 핸들 — listeners만(포인터 전용; 관심종목과 동일 계약). */
type GroupDragHandle = {
  listeners: DraggableSyntheticListeners;
  attributes: DraggableAttributes;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
};

/** 폴더(그룹)의 sortable 단위 = 그룹 블록 전체(헤더 + 종목들). setNodeRef/transform 은
 *  컨테이너 div, listeners 는 children render-prop 으로 헤더에 전달 — 헤더를 잡으면 그룹이
 *  통째로 움직인다. data.type='folder' 태깅으로 행(entry) 드래그와 충돌을 분리한다. */
function SortableGroup({ folderId, children }: {
  folderId: string;
  children: (handle: GroupDragHandle) => React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, listeners, attributes, isDragging } =
    useSortable({ id: folderId, data: { type: 'folder' } });
  return (
    <div ref={setNodeRef} data-testid={`heatmap-drawer-group-${folderId}`}
      style={{
        transform: CSS.Transform.toString(transform), transition,
        ...(isDragging ? { opacity: 0.6, position: 'relative', zIndex: 1 } : {}),
      }}>
      {children({ listeners, attributes, setActivatorNodeRef })}
    </div>
  );
}

/** 한 그룹 블록을 종목 이동의 드롭 타깃으로 감싼다(id=folderDroppableId).
 *  data.folderId 를 실어 onDragEnd 가 id 디코딩 없이 대상 그룹을 읽는다. 드래그 중 종목이
 *  이 그룹 위면 isOver 하이라이트. 헤더 그룹 드래그(type='folder')는 typeAwareCollision 이
 *  걸러 여기로 오지 않는다. */
function GroupDropZone({ folderId, children }: {
  folderId: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: folderDroppableId(folderId),
    data: { type: 'entry-target', folderId },
  });
  return (
    <div ref={setNodeRef}
      data-testid={`heatmap-drawer-dropzone-${folderId}`}
      className={isOver ? 'rounded ring-1 ring-inset ring-accent bg-tint-selection' : ''}>
      {children}
    </div>
  );
}

/** 종목 행 드래그(이동 전용, 재정렬 아님). useDraggable — 잡으면 커서를 따라 뜨고(transform),
 *  다른 그룹 GroupDropZone 에 드롭하면 소속 이동. PointerSensor(distance 5)가 클릭(차트 이동)
 *  과 드래그를 구분한다. children 에 drag 소품을 넘겨 QuoteRow 에 그대로 스레드. */
function DraggableRow({ code, folderId, children }: {
  code: string;
  folderId: string;
  children: (drag: {
    setNodeRef: (n: HTMLElement | null) => void;
    listeners: DraggableSyntheticListeners;
    transform: string | undefined;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, isDragging } =
    useDraggable({ id: code, data: { type: 'entry', code, folderId } });
  return <>{children({ setNodeRef, listeners, transform: CSS.Translate.toString(transform), isDragging })}</>;
}

/** active 타입과 같은 계열의 droppable 만 충돌 검사에 넘긴다 — 헤더 그룹 드래그(folder)는
 *  folder sortable 만, 행 드래그(entry)는 entry-target(그룹 드롭존)만 본다(한 DndContext 공존). */
const typeAwareCollision: CollisionDetection = (args) => {
  const activeType = args.active.data.current?.type;
  const wanted = activeType === 'entry' ? 'entry-target' : 'folder';
  const same = args.droppableContainers.filter((c) => c.data.current?.type === wanted);
  return closestCenter({ ...args, droppableContainers: same });
};

/**
 * 그룹 헤더 행 — ⠿ 드래그 핸들(수동 정렬 시) + chevron 접기 + 라벨/개수 + 평균 등락률 + ⋯ 메뉴
 * (종목 추가/이름 변경/순서/삭제). WatchlistDrawer.GroupHeader
 * 미러(폴더별 행 정렬 토글은 드로어 툴바로 승격돼 헤더엔 없음).
 */
function GroupHeader(props: {
  label: string; count: number; collapsed: boolean;
  avg?: number | null;
  onToggle: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onAddSymbol?: (code: string) => Promise<void>;
  addPending?: boolean;
  dragHandle?: GroupDragHandle;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(menuOpen, menuRef, () => setMenuOpen(false));
  const itemClass =
    'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    // 별도 핸들 아이콘 없이 헤더 전체가 드래그 활성 영역(dragHandle 있을 때). dnd-kit
    // PointerSensor(distance 5)가 클릭과 드래그를 구분하므로 chevron/⋯/라벨 클릭은 그대로
    // 동작하고, 헤더를 5px 이상 끌면 그룹 드래그가 시작된다. attributes(role=button/tabindex)는
    // 헤더 안 버튼들과 중첩 a11y 충돌을 피해 spread 하지 않는다(PointerSensor 전용, 키보드
    // 드래그 미도입 — WatchlistDrawer 와 동일 포인터 전용 계약). data-testid 는 헤더에 둔다.
    <div
      ref={props.dragHandle?.setActivatorNodeRef}
      {...(props.dragHandle?.listeners ?? {})}
      data-testid="heatmap-group-header"
      data-draggable={props.dragHandle ? '' : undefined}
      className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-fg-dim bg-bg-subtle hover:bg-bg-input-hover ${
        props.dragHandle ? 'cursor-grab select-none touch-none' : ''
      }`}>
      <button type="button" aria-label={`${props.label} ${props.collapsed ? '펼치기' : '접기'}`}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle} className="px-1 leading-none text-fg-dimmer hover:text-fg">
        <ChevronIcon collapsed={props.collapsed} />
      </button>
      <button type="button" onClick={props.onToggle}
        aria-label={`${props.label} ${props.count}`} aria-expanded={!props.collapsed}
        className="flex-1 min-w-0 text-left flex items-baseline gap-1.5">
        <span className="truncate">{props.label}</span>
        <span className="flex-none text-xs font-normal text-fg-dimmer">{props.count}</span>
      </button>
      {/* 그룹 평균 등락률(비가중, 시세 도착 종목만; 전부 결측이면 미표시). 방향색만 —
          배경 틴트는 없다(섹터 스트립과 달리 드로어는 숫자만). 정렬키(avgPct)와 동일값. */}
      {props.avg != null && (
        <span className={`flex-none text-xs font-normal font-mono tabular-nums ${priceDirClass(props.avg)}`}>
          {`${props.avg > 0 ? '+' : ''}${props.avg.toFixed(2)}%`}
        </span>
      )}
      {props.onRename && (
        <div className="relative" ref={menuRef}>
          <button type="button" aria-label={`${props.label} 그룹 메뉴`}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="px-1 leading-none text-fg-dimmer hover:text-fg">
            ⋯
          </button>
          {menuOpen && (
            <AnchoredMenu label={props.label}>
              {/* 종목 추가 — 클릭 시 메뉴를 닫고 검색 팝오버를 연다(팝오버는 메뉴와 별개 레이어라
                  메뉴 언마운트에 딸려 사라지지 않는다). 예전 헤더의 ＋종목 버튼을 이 항목으로 이동. */}
              {props.onAddSymbol && (
                <button type="button" role="menuitem"
                  onClick={() => { setMenuOpen(false); setAddOpen(true); }}
                  className={itemClass}>
                  <span className="w-4 grid place-items-center"><PlusIcon /></span> 종목 추가
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
              <div role="separator" className="my-1 border-t border-border" />
              {/* v3 (ADR-0112): 그룹 삭제는 파괴적(멤버 종목도 함께 삭제) — watchlist 와
                  동일하게 호출측(deleteFolderWithConfirm)이 멤버가 있으면 confirm 을 띄운다. */}
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onDelete?.(); }}
                className="w-full text-left px-3 py-1.5 text-sm text-error hover:bg-tint-error flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent">
                <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 그룹 삭제
              </button>
            </AnchoredMenu>
          )}
          {addOpen && props.onAddSymbol && (
            <SymbolAddPopover anchorRef={menuRef} onClose={() => setAddOpen(false)}
              onAdd={props.onAddSymbol} pending={!!props.addPending} />
          )}
        </div>
      )}
    </div>
  );
}

/** 행 우측 ⋯ 버튼 — 평시 opacity-0(호버/포커스 시 등장), 클릭이 행(차트 이동)으로
 *  통과하지 않게 stopPropagation. WatchlistDrawer.RowTrailing 의 수집상태 점을 뺀 최소판. */
function RowTrailing({ name, onOpenMenu }: { name: string; onOpenMenu: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      aria-label={`${name} 행 메뉴`}
      aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); onOpenMenu(e); }}
      className="grid place-items-center px-1 leading-none text-fg-dimmer hover:text-fg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
    >
      ⋯
    </button>
  );
}

// w-64 = 288px @ 18px root. FolderAddButton 과 동일한 우측정렬 초기추정폭.
const POP_W = 320;

/** 종목 검색 팝오버 (controlled) — 마운트되면 열린 상태. anchorRef 우하단 기준 우측정렬 후
 *  useClampedFixedPosition 으로 뷰포트 보정, createPortal 로 body 에 fixed(드로어 overflow
 *  탈출). 선택+추가 시 onAdd(code, folderId) 후 onClose; 바깥 클릭·Escape 로도 onClose.
 *  헤더 "종목 추가"(folders 전달 → 그룹 선택 셀렉트 표시, v3 는 그룹 필수 — ADR-0112)와
 *  그룹 ⋯ 메뉴 "종목 추가"(folders 미전달 — 그 그룹으로 고정)가 공유. */
function SymbolAddPopover({ anchorRef, onClose, onAdd, pending, folders }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onAdd: (code: string, folderId?: string) => Promise<void>;
  pending: boolean;
  /** 전달되면 대상 그룹 셀렉트를 보인다(기본값=첫 그룹). 빈 배열이면 추가 불가 안내. */
  folders?: { id: string; name: string }[];
}) {
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const [folderId, setFolderId] = useState<string>(() => folders?.[0]?.id ?? '');
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.right - POP_W, top: r.bottom + 4 });
  }, [anchorRef]);
  const { ref: popRef, left, top } = useClampedFixedPosition<HTMLDivElement>(anchor.left, anchor.top);
  useLayoutEffect(() => { popRef.current?.querySelector('input')?.focus(); }, [popRef]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || popRef.current?.contains(t)) return;
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
  // folders 모드에서 그룹 미선택(빈 배열)이면 추가 불가 — v3 는 그룹 필수(ADR-0112).
  const needsFolder = folders !== undefined;
  const canSubmit = !!picked && !pending && (!needsFolder || folderId !== '');
  const submit = async () => {
    if (!canSubmit || !picked) return;
    try {
      await onAdd(picked.code, needsFolder ? folderId : undefined);
    } catch {
      return; // 실패 시 팝오버 유지(재시도) — fire-and-forget rejection 삼킴.
    }
    onClose();
  };
  return createPortal(
    <div ref={popRef} role="dialog" aria-label="종목 추가"
      style={{ position: 'fixed', left, top, width: POP_W }}
      className="z-30 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2 shadow-lg">
      <SymbolSearch value={picked} onChange={setPicked} />
      {needsFolder && (folders.length > 0 ? (
        <label className="flex items-center gap-2 text-xs text-fg-dim">
          <span className="flex-none">그룹</span>
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}
            aria-label="추가할 그룹"
            className="flex-1 min-w-0 bg-bg-input border border-border rounded px-1.5 py-1 text-fg">
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      ) : (
        <div className="text-xs text-fg-dimmer">그룹이 없습니다 — 먼저 ＋ 버튼으로 그룹을 만들어 주세요.</div>
      ))}
      <div className="flex justify-end gap-2">
        <button type="button" className="text-xs px-2 py-1 text-fg-dim" onClick={onClose}>닫기</button>
        <button type="button" className="text-xs px-2 py-1 rounded bg-accent text-accent-fg disabled:opacity-40"
          disabled={!canSubmit} onClick={submit}>추가</button>
      </div>
    </div>,
    document.body,
  );
}

/** 드로어 헤더 "종목 추가" — SymbolAddPopover(그룹 셀렉트 포함) → 지정 그룹으로 추가.
 *  v3 (ADR-0112): 미분류가 없으므로 헤더 추가도 그룹을 고른다(기본=첫 그룹). */
function HeaderAddButton({ folders }: { folders: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const { addToFolder, isPending } = useAddToFolder();
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btnRef} type="button" title="종목 추가" data-testid="heatmap-header-add"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-fg-dim hover:text-accent">
        종목 추가
      </button>
      {open && (
        <SymbolAddPopover anchorRef={btnRef} onClose={() => setOpen(false)} pending={isPending}
          folders={folders}
          onAdd={async (code, folderId) => { if (folderId) await addToFolder(code, folderId); }} />
      )}
    </>
  );
}

/**
 * 드로어 툴바 — 목록 필터 검색창 + 행/그룹 등락률 정렬 토글. 정렬은 useHeatmapPrefsStore
 * (localStorage heatmap.sortMode.v1 / groupSort.v1)를 구독·기록하므로 /heatmap 페이지와
 * 단일 진실(양방향 동기화)이다. 검색 query 는 드로어 로컬 상태(패널을 닫으면 리셋 — 필터는
 * 일시적 조회 보조이지 저장 설정이 아니다).
 */
function DrawerToolbar({ query, onQuery }: { query: string; onQuery: (v: string) => void }) {
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const setSortMode = useHeatmapPrefsStore((s) => s.setSortMode);
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-md py-sm">
      <HeatmapSearchInput query={query} onQuery={onQuery} testId="heatmap-drawer-search" />
      <div className="flex items-center gap-2">
        <SortCycleButton label="종목" mode={sortMode} onCycle={() => setSortMode(nextSort(sortMode))} />
        <SortCycleButton label="그룹" mode={groupSort} onCycle={() => setGroupSort(nextSort(groupSort))} />
      </div>
    </div>
  );
}

/**
 * Heatmap Panel — /live 우측 레일에서 히트맵(/heatmap 페이지)의 그룹-종목을 관심종목
 * 드로어와 같은 문법으로 보고 편집한다. 데이터는 useHeatmap(['heatmap']) 공유 — 드로어의
 * 변경(추가/삭제/그룹 CRUD)은 HEATMAP_KEY invalidate 를 타고 페이지에도 즉시 반영되고,
 * 페이지의 변경도 여기로 반영된다(같은 QueryClient, ADR-0068 독립 스토어).
 *
 * 툴바: 목록 필터 검색창(종목명·코드·그룹명) + 행/그룹 등락률 정렬 토글(heatmapPrefs 공유 →
 * /heatmap 페이지와 양방향). 렌더 파이프라인은
 *   groupByFolder → orderFolderGroups(그룹간) → filterGroups(검색) → sortEntries(그룹내).
 * 종목/그룹 추가·삭제, 그룹 이름변경·순서변경(⋯), 행 클릭 차트 점프, Delete/⋯ 제거·이동.
 * 그룹 순서 변경(⋯ 위/아래)은 수동 정렬 + 비검색 상태에서만 활성(정렬/필터 중엔 화면 순서와
 * folder.order 가 어긋나므로 비활성). 드래그 재정렬은 /heatmap 페이지가 담당한다.
 */
export function HeatmapDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  const { data, isLoading, error } = useHeatmap();
  const removeM = useRemoveFromHeatmap();
  const moveM = useMoveHeatmapEntries();
  const createM = useCreateHeatmapFolder();
  const renameM = useRenameHeatmapFolder();
  const deleteM = useDeleteHeatmapFolder();
  const reorderFoldersM = useReorderHeatmapFolders();
  // 그룹 지정 종목 추가(⋯ 메뉴의 "종목 추가"). 훅 1회, folderId 는 호출 시 바인딩.
  const { addToFolder, isPending: addingToFolder } = useAddToFolder();

  // 접기 상태는 localStorage 영속 — 패널을 닫았다 열어도(언마운트) 유지된다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const saved = readJsonObject(COLLAPSE_STORAGE_KEY);
    const keys = Array.isArray(saved.keys) ? saved.keys.filter((k): k is string => typeof k === 'string') : [];
    return new Set(keys);
  });
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] =
    useState<{ x: number; y: number; code: string; name: string; folderId: string } | null>(null);

  // 정렬 취향은 페이지와 공유(heatmapPrefs). 행=sortMode, 그룹=groupSort.
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);

  // 히트맵 엔트리는 code 유일(단일 folder_id)이지만 방어적으로 dedup.
  const codes = useMemo(() => [...new Set(data?.entries.map((e) => e.code) ?? [])], [data]);
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(codes, venue);

  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // 영속화는 상태 변화에 반응. 기록 시점에 실존 그룹 키만 남겨 삭제된 그룹 키가 누적되지
  // 않게 한다(WatchlistDrawer.collapsed 와 동일 패턴).
  useEffect(() => {
    const valid = data ? new Set(data.folders.map((f) => f.id)) : null;
    persistJson(COLLAPSE_STORAGE_KEY, { keys: [...collapsed].filter((k) => !valid || valid.has(k)) });
  }, [collapsed, data]);

  const openMenu = (e: React.MouseEvent, code: string, name: string, folderId: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });
  };

  // v3 (ADR-0112): 그룹 삭제는 멤버 종목까지 지운다 — 멤버가 있으면 watchlist 와 같은
  // 문법으로 confirm(빈 그룹은 즉시 삭제). 종목 수는 반드시 **필터 전 원본**(data.entries)
  // 에서 센다 — 화면 그룹(visibleGroups)은 검색 중 filterGroups 가 매칭 행만 남긴 부분집합이라
  // 그 length 를 쓰면 confirm 이 실제보다 적은 수를 알리고도 전체를 지운다.
  const deleteFolderWithConfirm = (folderId: string, name: string) => {
    const memberCount = data?.entries.filter((e) => e.folder_id === folderId).length ?? 0;
    if (memberCount > 0 &&
        !window.confirm(`'${name}' 그룹과 종목 ${memberCount}개가 함께 삭제됩니다. 계속할까요?`)) {
      return;
    }
    deleteM.mutate(folderId);
  };

  // 렌더 파이프라인: groupByFolder → orderFolderGroups(그룹간 정렬) → filterGroups(검색)
  //   → (렌더 시) sortEntries(그룹내 정렬). pctOf 는 시세 Map 파생이라 change/desc/asc 모드는
  // 매 폴링 라이브 재정렬(페이지와 동일). 드로어는 행 드래그가 없어 재정렬이 안전하다
  // (페이지의 useFrozenWhileDragging 텔레포트 가드 불필요).
  const pctOf = useMemo(() => makePctOf(quoteByCode), [quoteByCode]);
  const visibleGroups = useMemo(() => {
    if (!data) return [];
    const grouped = groupHeatmapEntries(data.folders, data.entries);
    const ordered = orderFolderGroups(grouped, groupSort, (g) => avgPct(g.entries, pctOf));
    return filterGroups(ordered, query);
  }, [data, groupSort, pctOf, query]);

  const isSearching = query.trim() !== '';
  // ⋯ 위/아래 이동은 수동 정렬 + 비검색일 때만(정렬 중엔 folder.order 가 화면과 어긋나 애매).
  const canMoveGroups = groupSort === 'manual' && !isSearching;
  const folderCount = data?.folders.length ?? 0;
  const moveFolder = (folderId: string, dir: -1 | 1) => {
    const ids = swapFolderOrder(data?.folders ?? [], folderId, dir);
    if (ids) reorderFoldersM.mutate(ids);
  };

  // 그룹 헤더 드래그 재정렬 — 검색 중이 아니면 정렬 모드와 무관하게 항상 가능. 실폴더만
  // sortable, SortableContext items = 현재 화면 순서(등락률 정렬이면 그 순서). 드롭 시 화면
  // 순서 기준으로 재배열한 뒤 groupSort 를 'manual' 로 전환 → 드래그한 순서가 바로 고정돼
  // 보인다(등락률 정렬 상태로 드래그해도 "안 움직이는" 혼란 없음).
  const groupDragEnabled = !isSearching;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const draggableFolderIds = groupDragEnabled
    ? visibleGroups.map((g) => g.folder.id)
    : [];
  const onDragEnd = (ev: DragEndEvent) => {
    const activeType = ev.active.data.current?.type;
    if (activeType === 'entry') {
      // 종목 행을 다른 그룹으로 이동. over 는 GroupDropZone(entry-target). data.folderId 로 대상
      // 그룹을 읽어 id 디코딩 불필요. 같은 그룹이면 no-op. 서버가 대상 그룹 끝에 배치.
      const over = ev.over?.data.current;
      if (!over || over.type !== 'entry-target') return;
      const from = String(ev.active.data.current?.folderId ?? '');
      const to = String(over.folderId ?? '');
      if (to === '' || from === to) return;
      moveM.mutate({ codes: [String(ev.active.data.current?.code)], folderId: to });
      return;
    }
    // 그룹 헤더 드래그(순서 변경).
    if (!ev.over) return;
    const r = resolveFolderDrag(draggableFolderIds, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder') {
      reorderFoldersM.mutate(r.orderedIds);
      if (groupSort !== 'manual') setGroupSort('manual'); // 드래그는 명시적 수동 정렬 의도
    }
  };

  return (
    <RailDrawer id="right-rail-heatmap-panel" testId="heatmap-panel" ariaLabel="히트맵">
      <RailDrawerHeader
        title="히트맵"
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" aria-label="새 그룹 만들기" title="새 그룹 만들기"
                    onClick={() => setAddGroupOpen(true)}
                    className="grid h-5 w-5 place-items-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg">
              <PlusIcon />
            </button>
            <HeaderAddButton folders={data?.folders ?? []} />
          </div>
        )}
      />

      <DrawerToolbar query={query} onQuery={setQuery} />

      <RailDrawerBody testId="heatmap-drawer-scroll" quoteNav>
        {isLoading && <RailState>불러오는 중</RailState>}
        {error && <RailState tone="error">히트맵을 불러올 수 없습니다</RailState>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <RailState>히트맵이 비어 있습니다</RailState>
        )}
        {!isLoading && !error && isSearching && visibleGroups.length === 0 && (
          <RailState>검색 결과 없음</RailState>
        )}
        <DndContext sensors={sensors} collisionDetection={typeAwareCollision} onDragEnd={onDragEnd}>
          <SortableContext items={draggableFolderIds} strategy={verticalListSortingStrategy}>
            {visibleGroups.map((g, gi) => {
              const folder = g.folder;
              const key = folder.id;
              // 빈 그룹도 표시 — 새 그룹 직후 종목 추가로 채울 수 있어야 하기 때문
              // (/heatmap 보드의 visibleFolderGroups 는 빈 폴더 숨김 → 의도적 비대칭).
              // 검색 중엔 접기 무시 — 매칭된 행이 보여야 한다(collapsed Set 은 안 건드림).
              const isCollapsed = !isSearching && collapsed.has(key);
              const rows = sortEntries(g.entries, sortMode, pctOf);
              const renderGroup = (dragHandle?: GroupDragHandle) => (
                <>
                  <GroupHeader label={folder.name} count={g.entries.length} collapsed={isCollapsed}
                    avg={avgPct(g.entries, pctOf)}
                    onToggle={() => toggle(key)}
                    onRename={() => setRenameTarget({ id: folder.id, name: folder.name })}
                    onDelete={() => deleteFolderWithConfirm(folder.id, folder.name)}
                    onMoveUp={() => moveFolder(folder.id, -1)}
                    onMoveDown={() => moveFolder(folder.id, +1)}
                    canMoveUp={canMoveGroups && gi > 0}
                    canMoveDown={canMoveGroups && gi < folderCount - 1}
                    onAddSymbol={(code) => addToFolder(code, folder.id)}
                    addPending={addingToFolder}
                    dragHandle={dragHandle} />
                  {!isCollapsed && (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {rows.map((entry) => {
                        const q = quoteByCode.get(entry.code);
                        return (
                          <DraggableRow key={entry.code} code={entry.code} folderId={entry.folder_id}>
                            {(drag) => (
                              <QuoteRow
                                name={entry.name}
                                price={q?.price ?? null}
                                pct={q?.change_pct ?? null}
                                changeWon={q?.change_won ?? null}
                                active={entry.code === activeCode}
                                ariaLabel={[entry.name, entry.code, '차트 열기'].join(' ')}
                                testId={`heatmap-drawer-row-${entry.code}`}
                                onClick={() => onPick(entry.code, entry.name)}
                                onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                                onDelete={() => removeM.mutate(entry.code)}
                                indented
                                sortableRef={drag.setNodeRef}
                                sortableStyle={{ transform: drag.transform }}
                                dragListeners={drag.listeners}
                                dragging={drag.isDragging}
                                trailingAction={
                                  <RowTrailing name={entry.name}
                                    onOpenMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)} />
                                }
                              />
                            )}
                          </DraggableRow>
                        );
                      })}
                    </ul>
                  )}
                </>
              );
              // GroupDropZone: 종목 이동 드롭 타깃. 그 안에서 비검색이면 SortableGroup 으로
              // 헤더를 드래그 활성 영역으로(그룹 순서 변경), 아니면 일반 div.
              return (
                <GroupDropZone key={key} folderId={folder.id}>
                  {groupDragEnabled ? (
                    <SortableGroup folderId={folder.id}>
                      {(dragHandle) => renderGroup(dragHandle)}
                    </SortableGroup>
                  ) : (
                    renderGroup()
                  )}
                </GroupDropZone>
              );
            })}
          </SortableContext>
        </DndContext>
      </RailDrawerBody>

      {/* 행 ⋯ 메뉴는 '히트맵에서 제거'만 — 그룹 이동은 행 드래그앤드롭으로 대체(folders/onMove
          미전달 → HeatmapRowMenu 가 '그룹으로 이동' 섹션을 자체 생략). */}
      {menu && (
        <HeatmapRowMenu x={menu.x} y={menu.y} name={menu.name}
          onRemove={() => removeM.mutate(menu.code)}
          onClose={() => setMenu(null)} />
      )}
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
    </RailDrawer>
  );
}

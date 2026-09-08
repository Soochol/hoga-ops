import { resolveDropOnHeatmap } from '../state/heatmapDrop';
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, PointerSensor, useSensor, useSensors,
  useDroppable, useDndContext,
  type DragEndEvent, type DragMoveEvent, type DragStartEvent, type DraggableAttributes, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { resolveFolderDrag, folderDroppableId, entrySortableId } from '../watchlist/dragHandlers';
import { useJumpToLive } from '../live/useJumpToLive';
import { dropPoint, isPointOnChart, resolveDropOnChart, useEntryDragStore } from '../state/entryDrag';
import { useDragPointPublisher } from '../state/useDragPointPublisher';
import { createPanelCollision } from '../watchlist/panelDragCollision';
import { DragPanelAssist } from '../watchlist/DragPanelAssist';
import { RailDragOverlay } from '../rightrail/RailDragOverlay';
import { folderCodes, planHeatmapTransfer, type HeatmapTransferSource } from './transferEntries';
import { useHeatmapTransfer } from './useHeatmapTransfer';
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
import { useOptimisticDuplicateGate } from '../util/useOptimisticDuplicateGate';
import { Banner } from '../ui/Banner';
import { DUPLICATE_FLASH_MS } from '../watchlist/duplicateFlash';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { HeatmapRowMenu } from './HeatmapRowMenu';
import { useAddToFolder } from './useAddToFolder';
import { SortCycleButton } from './SortCycleButton';
import { HeatmapSearchInput } from './HeatmapSearchInput';
import { priceDirClass } from '../ui/priceDir';
import { ChevronIcon } from '../ui/ChevronIcon';
import { ConfirmModal } from '../ui/ConfirmModal';
import { CollapseAllIcon, ExpandAllIcon } from '../ui/CollapseAllIcon';
import { filterGroups, entryMatchesQuery } from './filterGroups';
import { sortEntries, avgPct, groupHeatmapEntries, orderFolderGroups, makePctOf, nextSort, SORT_THROTTLE_MS } from './heat';
import { useThrottledValue } from '../util/useThrottledValue';
import {
  useHeatmap, useRemoveFromHeatmap,
  useCreateHeatmapFolder, useRenameHeatmapFolder, useDeleteHeatmapFolder,
  useReorderHeatmapFolders,
} from './useHeatmap';
import { useFrozenWhileDragging } from './useFrozenWhileDragging';
import { useCopyDragIntent } from './useCopyDragIntent';
import type { HeatmapEntry, HeatmapResponse } from '../api/heatmap';
import { PencilIcon } from '../ui/PencilIcon';

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
const ArrowUpIcon = () => <MenuGlyph><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></MenuGlyph>;
const ArrowDownIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></MenuGlyph>;
const PlusIcon = () => <MenuGlyph><path d="M12 5v14" /><path d="M5 12h14" /></MenuGlyph>;

/** 우측 정렬 앵커드 메뉴 셸 — WatchlistDrawer.AnchoredMenu 사본(독립 표면). */
function AnchoredMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="menu" aria-label={label}
      className="absolute right-0 z-30 mt-1 bg-bg-card border border-border rounded shadow-lg py-1 min-w-[150px]">
      <div className="px-3 py-1 text-xs text-fg-dim">{label}</div>
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
function SortableGroup({ folderId, busy, children }: {
  folderId: string;
  busy: boolean;
  children: (handle: GroupDragHandle) => React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, listeners, attributes, isDragging } =
    useSortable({ id: folderId, disabled: busy, data: { type: 'folder' } });
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
 *  이 그룹 위면 isOver 하이라이트 — Ctrl(복제)이면 success 계열로 색을 바꿔, 손을 떼기
 *  전에 "이동이 아니라 복제"임을 알린다. 헤더 그룹 드래그(type='folder')는
 *  typeAwareCollision 이 걸러 여기로 오지 않는다. */
function GroupDropZone({ folderId, copy, children }: {
  folderId: string;
  copy?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: folderDroppableId(folderId),
    data: { type: 'entry-target', folderId },
  });
  // isOver 대신 컨텍스트의 over 로 판정 — manual 정렬이면 행도 droppable 이라, 대상 그룹의
  // 행 위를 지나는 동안 이 존의 isOver 는 꺼지고 하이라이트가 사라진다(정작 그 상태로 놓으면
  // 이 그룹으로 들어간다). 보드 HeatmapFolder.useIsDropTarget 과 같은 규칙.
  const { active, over } = useDndContext();
  const isOver = !!active && !!over
    && over.data.current?.folderId === folderId
    && active.data.current?.folderId !== folderId;
  return (
    <div ref={setNodeRef}
      data-testid={`heatmap-drawer-dropzone-${folderId}`}
      data-drop-intent={isOver ? (copy ? 'copy' : 'move') : undefined}
      className={isOver
        ? `rounded ring-1 ring-inset ${copy ? 'ring-success bg-tint-success' : 'ring-accent bg-tint-selection'}`
        : ''}>
      {children}
    </div>
  );
}

type RowDrag = {
  setNodeRef: (n: HTMLElement | null) => void;
  setActivatorNodeRef: (n: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
};
/** Rows remain droppable in live sort; only manual sort permits insertion. */
function SortableEntryRow({ code, name, folderId, busy, children }: {
  code: string; name: string; folderId: string; busy: boolean;
  children: (drag: RowDrag) => React.ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, isDragging } = useSortable({
    id: entrySortableId(folderId, code), disabled: busy, data: { type: 'entry', code, name, folderId },
  });
  return <>{children({ setNodeRef, setActivatorNodeRef, listeners, isDragging })}</>;
}
const typeAwareCollision = createPanelCollision('[data-testid="heatmap-drawer-scroll"]');

/**
 * 그룹 헤더 행 — ⠿ 드래그 핸들(수동 정렬 시) + chevron 접기 + 라벨/개수 + 평균 등락률 + ⋯ 메뉴
 * (종목 추가/이름 변경/순서/삭제). WatchlistDrawer.GroupHeader
 * 미러(폴더별 행 정렬 토글은 드로어 툴바로 승격돼 헤더엔 없음).
 */
function GroupHeader(props: {
  folderId: string; busy: boolean;
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
  /** 이 그룹에 그 코드가 이미 있는가 / 있으면 그 행을 가리킨다. 드로어가 내려 준다. */
  isDuplicateInGroup?: (code: string) => boolean;
  onDuplicateSymbol?: (code: string) => void;
  dragHandle?: GroupDragHandle;
}) {
  const { setNodeRef: setHeaderRef } = useDroppable({
    id: `header:${props.folderId}`, data: { type: 'entry-target', folderId: props.folderId, header: true },
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(menuOpen, menuRef, () => setMenuOpen(false));
  const itemClass =
    'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div ref={setHeaderRef} data-testid="heatmap-group-header"
      data-draggable={props.dragHandle ? '' : undefined}
      className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-fg-dim bg-bg hover:bg-bg-input-hover`}>
      {props.dragHandle && <button type="button" aria-label={`${props.label} 그룹 이동`}
        ref={props.dragHandle?.setActivatorNodeRef} {...(props.dragHandle?.listeners ?? {})} disabled={props.busy}
        onClick={(e) => e.stopPropagation()}
        className="cursor-grab touch-none text-fg-dimmer opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40">⠿</button>}
      <button type="button" aria-label={`${props.label} ${props.collapsed ? '펼치기' : '접기'}`}
        aria-expanded={!props.collapsed}
        onClick={props.onToggle} className="px-1 leading-none text-fg-dimmer hover:text-fg">
        <ChevronIcon collapsed={props.collapsed} />
      </button>
      <button type="button" onClick={props.onToggle}
        aria-label={`${props.label} ${props.count}`} aria-expanded={!props.collapsed}
        className="flex-1 min-w-0 text-left flex items-baseline gap-1.5">
        <span className="truncate">{props.label}</span>
        <span className="flex-none text-xs font-normal text-fg-dim">{props.count}</span>
      </button>
      {/* 그룹 평균 등락률(비가중, 시세 도착 종목만; 전부 결측이면 미표시). 방향색만 —
          배경 틴트는 없다(섹터 스트립과 달리 드로어는 숫자만). 같은 avgPct 지만 **라이브
          시세**로 계산한다 — 그룹 순서를 정하는 쪽은 SORT_THROTTLE_MS 로 스로틀된 시세를
          보므로, 창 안에서는 이 숫자가 현재 순서보다 앞선다(값은 실시간, 자리는 격자). */}
      {props.avg != null && (
        <span className={`flex-none text-xs font-normal font-data tabular-nums ${priceDirClass(props.avg)}`}>
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
              onAdd={props.onAddSymbol}
              isDuplicate={(code) => !!props.isDuplicateInGroup?.(code)}
              onDuplicate={(code) => props.onDuplicateSymbol?.(code)} />
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

// w-64 = 256px @ 16px root(2026-08-07 다이얼 1.0×). FolderAddButton 과 동일한
// 우측정렬 초기추정폭 — 클램프가 덮으므로 상수로 둔다(그쪽 주석에 근거).
const POP_W = 320;

/** 종목 검색 팝오버 (controlled) — 마운트되면 열린 상태. anchorRef 우하단 기준 우측정렬 후
 *  useClampedFixedPosition 으로 뷰포트 보정, createPortal 로 body 에 fixed(드로어 overflow
 *  탈출). 선택+추가 시 onAdd(code, folderId) 후 onClose; 바깥 클릭·Escape 로도 onClose.
 *  헤더 "종목 추가"(folders 전달 → 그룹 선택 셀렉트 표시, v3 는 그룹 필수 — ADR-0112)와
 *  그룹 ⋯ 메뉴 "종목 추가"(folders 미전달 — 그 그룹으로 고정)가 공유. */
function SymbolAddPopover({ anchorRef, onClose, onAdd, isDuplicate, onDuplicate, folders }: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onAdd: (code: string, folderId?: string) => Promise<void>;
  /** 그 그룹에 그 코드가 이미 있는가. **폴더 인자를 받는다** — 헤더 경로는 셀렉트로
   *  대상 그룹이 바뀌므로 판정이 그때마다 달라진다(`undefined` = ⋯ 메뉴의 고정 그룹). */
  isDuplicate: (code: string, folderId?: string) => boolean;
  /** 이미 있는 종목을 고른 순간 — 드로어가 그 그룹의 행을 가리킨다. */
  onDuplicate: (code: string, folderId?: string) => void;
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
  const target = needsFolder ? folderId : undefined;
  // 중복 판정을 **제출 중에는 얼린다** — 히트맵 추가도 낙관적이라 요청을 보내는 순간
  // 캐시에 행이 들어가고, 파생 판정은 그걸 보고 자기 자신을 고발한다(훅 docstring).
  //
  // 판정을 **캐시하지 않는다**: 셀렉트로 그룹을 바꾸면 답이 달라져야 한다. 파생값이라
  // 배너 해제·버튼 재활성이 공짜로 따라온다.
  const { duplicate, submitting, run } =
    useOptimisticDuplicateGate(picked, (hit) => isDuplicate(hit.code, target));
  const canSubmit = !!picked && !submitting && !duplicate && (!needsFolder || folderId !== '');
  // 고른 순간 + **그룹을 바꿔 새로 중복이 된 순간**에만 알린다. 선택을 바꾸면 이전
  // 그룹의 행을 가리키던 하이라이트가 남는데, 새 그룹이 중복이면 그쪽으로 옮겨 가고
  // 아니면 그대로 사그라진다(2.5s 타이머) — **다른 그룹을 가리킨 채 머무는 것**만 막으면 된다.
  const pointAtDuplicate = (hit: SymbolHit | null, folder: string | undefined) => {
    if (hit && isDuplicate(hit.code, folder)) onDuplicate(hit.code, folder);
  };
  const submit = async () => {
    if (!canSubmit || !picked) return;
    // 성공했을 때만 닫는다 — 실패 시 팝오버를 열어 둬 재시도/다른 종목 선택이 가능하다.
    // `run` 은 실패해도 정상 반환하므로 닫기가 콜백 **안**에 있어야 한다.
    await run(async () => {
      await onAdd(picked.code, target);
      onClose();
    });
  };
  return createPortal(
    <div ref={popRef} role="dialog" aria-label="종목 추가"
      style={{ position: 'fixed', left, top, width: POP_W }}
      className="z-30 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2 shadow-lg">
      <SymbolSearch value={picked} onChange={(hit) => { setPicked(hit); pointAtDuplicate(hit, target); }} />
      {/* **위치를 약속하지 않는다** — 이 팝오버는 헤더/⋯ 버튼에 앵커돼 가리킬 리스트를
          자기가 덮는다(실측: 팝오버 30–208, 그 행 162–187). 관심종목 팝오버는 커서 자리에
          떠서 그 약속을 지킬 수 있었다 — 표면이 다르면 약속도 달라야 한다. */}
      {picked && duplicate && (
        <Banner kind="error">{picked.name}은(는) 이미 이 그룹에 있습니다</Banner>
      )}
      {needsFolder && (folders.length > 0 ? (
        <label className="flex items-center gap-2 text-xs text-fg-dim">
          <span className="flex-none">그룹</span>
          <select value={folderId}
            onChange={(e) => { setFolderId(e.target.value); pointAtDuplicate(picked, e.target.value); }}
            aria-label="추가할 그룹"
            className="flex-1 min-w-0 bg-bg-input border border-border rounded px-1.5 py-1 text-fg">
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      ) : (
        <div className="text-xs text-fg-dim">그룹이 없습니다 — 먼저 ＋ 버튼으로 그룹을 만들어 주세요</div>
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
function HeaderAddButton({ folders, isDuplicate, onDuplicate }: {
  folders: { id: string; name: string }[];
  /** 셀렉트로 대상 그룹이 바뀌므로 폴더까지 받아 판정한다. */
  isDuplicate: (code: string, folderId?: string) => boolean;
  onDuplicate: (code: string, folderId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { addToFolder } = useAddToFolder();
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btnRef} type="button" title="종목 추가" data-testid="heatmap-header-add"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-fg-dim hover:text-accent">
        종목 추가
      </button>
      {open && (
        <SymbolAddPopover anchorRef={btnRef} onClose={() => setOpen(false)}
          folders={folders} isDuplicate={isDuplicate} onDuplicate={onDuplicate}
          onAdd={async (code, folderId) => { if (folderId) await addToFolder(code, folderId); }} />
      )}
    </>
  );
}

/**
 * 드로어 툴바 — 목록 필터 검색창 + 행/그룹 등락률 정렬 토글 + 전체 접기/펼치기. 정렬은
 * useHeatmapPrefsStore(localStorage heatmap.sortMode.v1 / groupSort.v1)를 구독·기록하므로
 * /heatmap 페이지와 단일 진실(양방향 동기화)이다. 검색 query 는 드로어 로컬 상태(패널을
 * 닫으면 리셋 — 필터는 일시적 조회 보조이지 저장 설정이 아니다).
 *
 * 전체 접기는 **드로어 전용** 관심사다(/heatmap 페이지엔 접기 개념 자체가 없다). 페이지와
 * 공유되는 정렬 토글과 영속 축이 다르므로 ml-auto 로 우측에 떼어 배치해 한 줄 안에서도
 * 두 관심사가 섞여 보이지 않게 한다. 저장뷰 드로어는 같은 버튼을 테두리 박스
 * (RailToolbarIconButton)로 쓰지만, 여기 정렬 칩이 테두리 없는 고밀도 표기라 그 문법에
 * 맞춰 무테 아이콘 버튼으로 둔다(ui/SortCycleButton 이 히트맵을 예외로 둔 것과 같은 근거).
 */
function DrawerToolbar({ query, onQuery, allCollapsed, onToggleAll, toggleAllDisabled }: {
  query: string;
  onQuery: (v: string) => void;
  allCollapsed: boolean;
  onToggleAll: () => void;
  toggleAllDisabled: boolean;
}) {
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
        <button
          type="button"
          data-testid="heatmap-drawer-toggle-all"
          onClick={onToggleAll}
          disabled={toggleAllDisabled}
          aria-label={allCollapsed ? '전체 펼치기' : '전체 접기'}
          title={allCollapsed ? '전체 펼치기' : '전체 접기'}
          className="ml-auto grid h-6 w-6 place-items-center rounded text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-dim"
        >
          {allCollapsed ? <ExpandAllIcon className="h-4 w-4" /> : <CollapseAllIcon className="h-4 w-4" />}
        </button>
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
 * folder.order 가 어긋나므로 비활성). 행 드래그: 형제 위=그룹 내 재정렬(manual+비검색),
 * 다른 그룹 위=소속 이동(모든 모드). 그룹 헤더 드래그=그룹 순서 변경.
 */
export function HeatmapDrawer() {
  const activeCode = useLivePageStore((s) => s.activeCode);
  const onPick = useJumpToLive();
  // 차트 드롭 제스처의 공유 상태 — WorkspaceCanvas 가 구독해 드롭 어포던스를 띄운다.
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);
  // 드래그 좌표는 프레임당 한 번만 발행한다 — 우측 레일 드로어 공용 훅(직접 setDragPoint
  // 를 치면 포인터 이동마다 캔버스가 강제 레이아웃을 돈다).
  const { publishDragPoint, cancelDragPointFlush } = useDragPointPublisher();
  const { data, isLoading, error } = useHeatmap();
  const removeM = useRemoveFromHeatmap();
  const transfer = useHeatmapTransfer();
  const createM = useCreateHeatmapFolder();
  const renameM = useRenameHeatmapFolder();
  const deleteM = useDeleteHeatmapFolder();
  const reorderFoldersM = useReorderHeatmapFolders();
  const busy = transfer.busy || reorderFoldersM.isPending || removeM.isPending;
  const [notice, setNotice] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const dragDataRef = useRef<HeatmapResponse | null>(null);
  const sourcesRef = useRef<HeatmapTransferSource[]>([]);
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<string | null>(null);
  const [dragHint, setDragHint] = useState('그룹의 원하는 위치에 놓으세요 · 바깥에 놓으면 취소');
  const [destination, setDestination] = useState<{ folderId: string; at: number; rowId?: string; side?: 'before' | 'after'; where: string; duplicates: number } | null>(null);
  const [expandedDuringDrag, setExpandedDuringDrag] = useState<Set<string>>(new Set());
  const expandDuringDrag = useCallback((id: string) => setExpandedDuringDrag((old) => old.has(id) ? old : new Set([...old, id])), []);
  const toggleSelected = (id: string) => setSelected((old) => {
    const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const removeRow = (code: string, folderId: string) => {
    if (busy) return;
    transfer.dismiss();
    removeM.mutate({ code, folderId }, {
      onSuccess: () => setNotice('현재 그룹에서 제외했습니다'),
      onError: () => setNotice('제외하지 못했습니다. 최신 목록에서 다시 시도하세요.'),
    });
  };
  // 그룹 지정 종목 추가(⋯ 메뉴의 "종목 추가"). 훅 1회, folderId 는 호출 시 바인딩.
  // pending 을 내리지 않는 이유: 제출 게이트는 팝오버가 `useOptimisticDuplicateGate` 로
  // 자기 것을 갖는다 — 여기 것을 함께 내리면 게이트가 두 곳으로 갈린다(그 훅이 재는 창이
  // mutation 의 isPending 보다 정확하다는 것이 그 훅의 존재 이유다).
  const { addToFolder } = useAddToFolder();

  // 접기 상태는 localStorage 영속 — 패널을 닫았다 열어도(언마운트) 유지된다.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const saved = readJsonObject(COLLAPSE_STORAGE_KEY);
    const keys = Array.isArray(saved.keys) ? saved.keys.filter((k): k is string => typeof k === 'string') : [];
    return new Set(keys);
  });
  const [addGroupOpen, setAddGroupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [query, setQuery] = useState('');
  // 행 드래그 중(그룹 내 재정렬) 그룹 순서 동결(G1, 텔레포트 방지). groupSort≠manual 이면 그룹이
  // 매 폴링 라이브 재배치되는데, 종목을 끄는 도중 그 밑 그룹이 튀면 드롭 타깃이 어긋난다.
  const [isEntryDragging, setIsEntryDragging] = useState(false);
  // Ctrl+드래그 = 복제. 드롭존 색(copyIntent)과 커밋 분기(isCopy)를 같은 출처에서 읽는다.
  const { copyIntent, isCopy, seed } = useCopyDragIntent(isEntryDragging);
  const [menu, setMenu] =
    useState<{ x: number; y: number; code: string; name: string; folderId: string } | null>(null);

  // 정렬 취향은 페이지와 공유(heatmapPrefs). 행=sortMode, 그룹=groupSort.
  const sortMode = useHeatmapPrefsStore((s) => s.sortMode);
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);

  // entries 는 등록 단위(한 종목이 여러 그룹에 있으면 여러 행) — 시세 구독은 코드 집합이라
  // dedup 이 필수다(중복 구독 = 중복 요청).
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
  // 추가 팝오버가 "이미 이 그룹에 있습니다" 를 띄울 때 **그 행을 가리킨다**
  // (관심종목 드로어와 같은 계약). 코드만으로는 부족하다 — 한 종목이 여러 그룹에 있을 수
  // 있어 대상 그룹의 행만 깜빡여야 한다.
  const [duplicateHit, setDuplicateHit] =
    useState<{ folderId: string; code: string } | null>(null);
  const duplicateTimer = useRef<number | null>(null);
  // 팝오버에 넘기므로 **참조가 안정적이어야** 한다(매 렌더 새 함수면 그쪽이 매번 리렌더).
  // 세 가지를 함께 해야 "가리켰다" 가 된다: 접힌 그룹이면 펼치고 · 하이라이트하고 ·
  // 그 자리로 스크롤한다. 첫째가 없으면 접힌 그룹에선 **아무 일도 일어나지 않는다**.
  const flashDuplicate = useCallback((folderId: string, code: string) => {
    setCollapsed((s) => {
      if (!s.has(folderId)) return s;   // 참조 유지 — 없는 키를 지워 영속화를 깨우지 않는다
      const n = new Set(s);
      n.delete(folderId);
      return n;
    });
    setDuplicateHit({ folderId, code });
    if (duplicateTimer.current !== null) window.clearTimeout(duplicateTimer.current);
    duplicateTimer.current = window.setTimeout(() => setDuplicateHit(null), DUPLICATE_FLASH_MS);
  }, []);
  useEffect(() => () => {
    if (duplicateTimer.current !== null) window.clearTimeout(duplicateTimer.current);
  }, []);
  // 스크롤은 **다음 커밋**에서 한다 — 접힌 그룹을 펼친 그 렌더에는 행이 아직 DOM 에 없다.
  // `'nearest'` 인 이유는 위 배너 주석과 같다: 팝오버가 리스트 위에 얹혀 있어 가운데로
  // 끌어오면 보이던 행이 가려진 자리로 간다.
  // 조회를 그룹 컨테이너로 한정하는 이유: `heatmap-drawer-row-<code>` 는 다중 소속이라
  // 드로어 전체에서 고유하지 않다 — 전역 조회는 엉뚱한 그룹의 행으로 스크롤한다.
  useEffect(() => {
    if (duplicateHit === null) return;
    document.querySelector(`[data-testid="heatmap-drawer-group-${duplicateHit.folderId}"]`)
      ?.querySelector(`[data-testid="heatmap-drawer-row-${duplicateHit.code}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [duplicateHit]);
  const isDuplicateIn = useCallback((code: string, folderId?: string) =>
    folderId !== undefined
    && (data?.entries ?? []).some((e) => e.folder_id === folderId && e.code === code),
  [data]);

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
  // 문법으로 확인(빈 그룹은 즉시 삭제). 종목 수는 반드시 **필터 전 원본**(data.entries)
  // 에서 센다 — 검색 중 매칭 없는 그룹은 visibleGroups 에서 통째로 빠지고, data.entries 가
  // 멤버십의 SSOT 이므로 여기서 세야 확인 문구가 실제 삭제 수를 정확히 알린다.
  // 그 수는 확인을 띄우는 시점에 얼려 state 로 옮긴다(모달 표시 중 폴링 갱신으로 흔들리지
  // 않게 — WatchlistDrawer 와 동일 계약).
  const [deleteConfirm, setDeleteConfirm] =
    useState<{ folderId: string; name: string; memberCount: number } | null>(null);
  const deleteFolderWithConfirm = (folderId: string, name: string) => {
    const memberCount = data?.entries.filter((e) => e.folder_id === folderId).length ?? 0;
    if (memberCount > 0) {
      setDeleteConfirm({ folderId, name, memberCount });
      return;
    }
    deleteM.mutate(folderId);
  };

  // 렌더 파이프라인: groupByFolder → orderFolderGroups(그룹간 정렬) → filterGroups(검색)
  //   → (렌더 시) sortEntries(그룹내 정렬).
  //
  // pctOf 가 **두 갈래**인 이유: 표시값(그룹 헤더 평균 숫자)은 라이브여야 하고, 순서를
  // 정하는 키는 SORT_THROTTLE_MS 격자여야 한다. 갈라 두지 않으면 둘 중 하나가 반드시
  // 틀린다 — 통째로 스로틀하면 헤더 숫자가 최대 30초 낡고, 통째로 라이브면 WS 틱
  // flush 마다(초당 최대 ~6.7회) 그룹·행이 자리를 바꾼다. 페이지는 행 정렬이
  // HeatmapFolder 안에 있어 주입점이 다를 뿐 정책은 같다.
  const pctOf = useMemo(() => makePctOf(quoteByCode), [quoteByCode]);
  const [sortQuoteByCode, flushSortQuotes] = useThrottledValue(quoteByCode, SORT_THROTTLE_MS);
  // 정렬 버튼 클릭(=모드 변화) 순간엔 스로틀을 우회해 즉시 최신 시세로 정렬 — 페이지
  // (pages/Heatmap.tsx)와 동일 계약. 모드 스토어를 공유하므로 어느 표면의 클릭이든
  // 양쪽이 같이 갱신되고, 마운트 실행은 no-op 다(훅 docstring 의 콜드 로드 가드).
  useLayoutEffect(() => { flushSortQuotes(); }, [sortMode, groupSort, flushSortQuotes]);
  const frozenSortQuotes = useFrozenWhileDragging(sortQuoteByCode, ghost !== null);
  const sortPctOf = useMemo(() => makePctOf(frozenSortQuotes), [frozenSortQuotes]);
  const visibleGroups = useMemo(() => {
    if (!data) return [];
    const grouped = groupHeatmapEntries(data.folders, data.entries);
    const ordered = orderFolderGroups(grouped, groupSort, (g) => avgPct(g.entries, sortPctOf));
    return filterGroups(ordered, query);
  }, [data, groupSort, sortPctOf, query]);

  const isSearching = query.trim() !== '';
  // 그룹 내 종목 드래그 재정렬은 manual 정렬 + 비검색일 때만(페이지 HeatmapFolder 와 동일 계약).
  // 정렬·검색 중에는 표시 순서와 전체 저장 순서가 다르므로 그룹 간 이동·복제만 허용한다.
  const entrySortEnabled = sortMode === 'manual' && !isSearching;
  // G1: 행 드래그 중 그룹 순서 동결(텔레포트 방지), drag-end 에 최신 반영. 페이지와 동일 가드.
  const displayGroups = useFrozenWhileDragging(visibleGroups, ghost !== null);

  // 전체 접기/펼치기. 대상은 **화면에 보이는 그룹**(visibleGroups)이지 collapsed Set 이 아니다.
  // collapsed.size 로 "모두 접힘"을 판정하면 삭제된 그룹의 잔여 키에 걸려 거짓 양성이 난다
  // — 아래 persist 이펙트는 저장되는 값만 실존 폴더로 거르고 메모리 Set 은 그대로 두기 때문.
  // 검색 중엔 접힘이 통째로 무시되므로(isCollapsed = !isSearching && ...) 눌러도 화면이 안
  // 바뀌어 아이콘이 화면과 어긋난다 → 비활성. 그룹이 하나도 없을 때도 누를 것이 없어 비활성.
  const allCollapsed =
    visibleGroups.length > 0 && visibleGroups.every((g) => collapsed.has(g.folder.id));
  const toggleAllDisabled = isSearching || visibleGroups.length === 0;
  const toggleAll = () =>
    setCollapsed((s) => {
      const n = new Set(s);
      for (const g of visibleGroups) {
        if (allCollapsed) n.delete(g.folder.id);
        else n.add(g.folder.id);
      }
      return n;
    });

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
    ? displayGroups.map((g) => g.folder.id)
    : [];
  const getDestination = (ev: DragMoveEvent | DragEndEvent) => {
    const data = dragDataRef.current;
    if (!data || !ev.over) return null;
    const folderId = ev.over.data.current?.folderId as string | undefined;
    if (!folderId) return null;
    const manual = entrySortEnabled;
    if (!manual && sourcesRef.current.every((source) => source.folderId === folderId)) return null;
    const items = folderCodes(data, folderId);
    let at = items.length;
    let rowId: string | undefined;
    let side: 'before' | 'after' | undefined;
    let where = manual ? '맨 아래로' : '그룹으로';
    if (manual && ev.over.data.current?.type === 'entry') {
      const code = String(ev.over.data.current.code);
      const index = items.indexOf(code);
      if (index < 0) return null;
      const point = pointRef.current ?? dropPoint(ev);
      side = point && point.y > ev.over.rect.top + ev.over.rect.height / 2 ? 'after' : 'before';
      at = index + (side === 'after' ? 1 : 0);
      rowId = String(ev.over.id);
      where = `${data.entries.find((e) => e.code === code)?.name ?? code} ${side === 'after' ? '아래' : '위'}로`;
    }
    const moving = new Set(sourcesRef.current.filter((source) => source.folderId !== folderId).map((source) => source.code));
    return { folderId, at, rowId, side, where, duplicates: items.filter((code) => moving.has(code)).length };
  };
  const onDragStart = (ev: DragStartEvent) => {
    pointRef.current = dropPoint({ activatorEvent: ev.activatorEvent, delta: { x: 0, y: 0 } });
    setNotice('');
    setDragHint('그룹의 원하는 위치에 놓으세요 · 바깥에 놓으면 취소');
    dragDataRef.current = data ?? null;
    const d = ev.active.data.current;
    if (d?.type !== 'entry') {
      setGhost(data?.folders.find((f) => f.id === String(ev.active.id))?.name ?? '그룹');
      return;
    }
    seed(ev.activatorEvent);
    setIsEntryDragging(true);
    sourcesRef.current = displayGroups.flatMap((g) => sortEntries(g.entries, sortMode, sortPctOf)
      .filter((e) => selected.has(String(ev.active.id)) ? selected.has(entrySortableId(e.folder_id, e.code)) : entrySortableId(e.folder_id, e.code) === String(ev.active.id))
      .map((e) => ({ folderId: e.folder_id, code: e.code })));
    const count = new Set(sourcesRef.current.map((source) => source.code)).size;
    setGhost(sourcesRef.current.length > 1 ? `${count}종목` : String(d.name ?? d.code));
    if (sourcesRef.current.length === 1) startEntryDrag(String(d.code));
  };
  const onDragMove = (ev: DragMoveEvent) => {
    if (ev.active.data.current?.type !== 'entry') return;
    const next = getDestination(ev);
    const point = pointRef.current ?? dropPoint(ev);
    setDragHint(isPointOnChart(point)
      ? sourcesRef.current.length === 1 ? '차트에 놓으면 종목을 변경합니다' : '여러 종목은 그룹으로 이동·복제하세요'
      : !next && ev.over?.data.current?.folderId && !entrySortEnabled
        ? '정렬·검색 중에는 다른 그룹으로 이동·복제할 수 있습니다'
        : '그룹의 원하는 위치에 놓으세요 · 바깥에 놓으면 취소');
    setDestination((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    if (sourcesRef.current.length === 1) publishDragPoint(pointRef.current ?? dropPoint(ev));
  };
  const finishEntryDrag = () => {
    pointRef.current = null;
    cancelDragPointFlush();
    setIsEntryDragging(false);
    setGhost(null);
    setDestination(null);
    setExpandedDuringDrag(new Set());
    endEntryDrag();
  };
  const onDragEnd = (ev: DragEndEvent) => {
    const target = getDestination(ev);
    const point = pointRef.current ?? dropPoint(ev);
    const copy = isCopy();
    const d = ev.active.data.current;
    const externalDrop = !busy && d?.type === 'entry' && sourcesRef.current.length === 1
      && resolveDropOnHeatmap(point, { code: String(d.code), name: String(d.name ?? d.code) });
    finishEntryDrag();
    if (externalDrop) return;
    if (busy) return;
    if (ev.active.data.current?.type === 'entry') {
      if (isPointOnChart(point)) {
        if (sourcesRef.current.length !== 1) return;
        const d = ev.active.data.current;
        const code = String(d.code);
        const name = String(d.name ?? code);
        if (!resolveDropOnChart(point, { code, name })) onPick(code, name);
        return;
      }
      const data = dragDataRef.current;
      if (!data || !target) return;
      const changes = planHeatmapTransfer(data, sourcesRef.current, target.folderId, target.at, copy, !entrySortEnabled);
      if (!changes.length) {
        if (!transfer.canUndo) setNotice(copy ? '이미 해당 그룹에 있습니다' : '위치 변경이 없습니다');
        return;
      }
      const name = data.folders.find((f) => f.id === target.folderId)?.name ?? '';
      void transfer.run(changes, `${ghost ?? '종목'} → ${name} 그룹으로 ${copy ? '복제' : '이동'}했습니다`).then((saved) => {
        if (saved) setSelected(new Set());
      });
      return;
    }
    if (!ev.over) return;
    const r = resolveFolderDrag(draggableFolderIds, String(ev.active.id), String(ev.over.id));
    if (r.kind === 'reorder') {
      transfer.dismiss();
      reorderFoldersM.mutate(r.orderedIds, {
        onSuccess: () => { setGroupSort('manual'); setNotice('그룹 순서를 변경했습니다'); },
        onError: () => setNotice('그룹 순서를 저장하지 못했습니다. 다시 시도하세요.'),
      });
    }
  };

  return (
    <RailDrawer id="right-rail-heatmap-panel" testId="heatmap-panel" ariaLabel="히트맵">
      <RailDrawerHeader
        title="히트맵"
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" aria-label={selecting ? '선택 종료' : '여러 종목 선택'} aria-pressed={selecting} disabled={busy}
              className="text-xs text-fg-dim hover:text-accent disabled:opacity-40"
              onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>{selecting ? `선택 ${selected.size}` : '선택'}</button>
            <button type="button" aria-label="새 그룹 만들기" title="새 그룹 만들기"
                    onClick={() => setAddGroupOpen(true)}
                    className="grid h-5 w-5 place-items-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg">
              <PlusIcon />
            </button>
            <HeaderAddButton folders={data?.folders ?? []}
              isDuplicate={isDuplicateIn}
              onDuplicate={(code, folderId) => { if (folderId) flashDuplicate(folderId, code); }} />
          </div>
        )}
      />

      <DrawerToolbar query={query} onQuery={setQuery}
        allCollapsed={allCollapsed} onToggleAll={toggleAll} toggleAllDisabled={toggleAllDisabled} />

      <RailDrawerBody testId="heatmap-drawer-scroll" quoteNav>
        {isLoading && <RailState>불러오는 중</RailState>}
        {error && <RailState tone="error">히트맵을 불러올 수 없습니다</RailState>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <RailState>히트맵이 비어 있습니다</RailState>
        )}
        {!isLoading && !error && isSearching && visibleGroups.length === 0 && (
          <RailState>검색 결과 없음</RailState>
        )}
        <DndContext sensors={sensors} collisionDetection={typeAwareCollision} autoScroll={false}
          onDragStart={onDragStart} onDragMove={onDragMove} onDragOver={onDragMove} onDragEnd={onDragEnd}
          onDragCancel={finishEntryDrag}>
          <DragPanelAssist collapsed={collapsed} onExpand={expandDuringDrag} pointRef={pointRef} scrollSelector='[data-testid="heatmap-drawer-scroll"]' />
          <SortableContext items={draggableFolderIds} strategy={verticalListSortingStrategy}>
            {displayGroups.map((g, gi) => {
              const folder = g.folder;
              const key = folder.id;
              // 빈 그룹도 표시 — 새 그룹 직후 종목 추가로 채울 수 있어야 하기 때문
              // (/heatmap 보드도 이제 같다 — 예전의 '보드만 빈 폴더 숨김' 비대칭은 갓 만든
              //  그룹을 채울 표면을 없애 데드엔드였다).
              // 검색 중엔 접기 무시 — 매칭된 행이 보여야 한다(collapsed Set 은 안 건드림).
              const isCollapsed = !isSearching && collapsed.has(key) && !expandedDuringDrag.has(key);
              const rows = sortEntries(g.entries, sortMode, sortPctOf);
              const renderGroup = (dragHandle?: GroupDragHandle) => (
                <>
                  <GroupHeader folderId={folder.id} busy={busy} label={folder.name} count={g.entries.length} collapsed={isCollapsed}
                    avg={avgPct(g.entries, pctOf)}
                    onToggle={() => toggle(key)}
                    onRename={() => setRenameTarget({ id: folder.id, name: folder.name })}
                    onDelete={() => deleteFolderWithConfirm(folder.id, folder.name)}
                    onMoveUp={() => moveFolder(folder.id, -1)}
                    onMoveDown={() => moveFolder(folder.id, +1)}
                    canMoveUp={canMoveGroups && gi > 0}
                    canMoveDown={canMoveGroups && gi < folderCount - 1}
                    onAddSymbol={(code) => addToFolder(code, folder.id)}
                    isDuplicateInGroup={(code) => isDuplicateIn(code, folder.id)}
                    onDuplicateSymbol={(code) => flashDuplicate(folder.id, code)}
                    dragHandle={dragHandle} />
                  {!isCollapsed && (
                    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {/* 행은 모든 정렬에서 드롭 타깃이다. 순서 삽입은 기본 정렬에서만 허용한다. */}
                      {(() => {
                        const renderRow = (entry: HeatmapEntry, drag: RowDrag) => {
                          const q = quoteByCode.get(entry.code);
                          return (
                            <QuoteRow
                              name={entry.name}
                              price={q?.price ?? null}
                              pct={q?.change_pct ?? null}
                              changeWon={q?.change_won ?? null}
                              expectedPrice={q?.expected_price ?? null}
                              expectedPct={q?.expected_change_pct ?? null}
                              active={entry.code === activeCode}
                              matched={entryMatchesQuery(entry, query)}
                              ariaLabel={[entry.name, entry.code, '차트 열기'].join(' ')}
                              testId={`heatmap-drawer-row-${entry.code}`}
                              // 코드만 비교하면 안 된다 — 다중 소속이라 같은 종목이 여러
                              // 그룹에 있고, 가리켜야 할 것은 대상 그룹의 행이다.
                              flash={duplicateHit?.folderId === folder.id
                                && duplicateHit.code === entry.code}
                              onClick={(e) => onPick(entry.code, entry.name, e)}
                              onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                              onDelete={() => removeRow(entry.code, entry.folder_id)}
                              indented
                              sortableRef={drag.setNodeRef}
                              dropIndicator={destination?.rowId === entrySortableId(entry.folder_id, entry.code) ? destination.side : undefined}
                              draggingAppearance="placeholder"
                              leading={<span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                {selecting && <input type="checkbox" aria-label={`${entry.name} 선택`} disabled={busy}
                                  checked={selected.has(entrySortableId(entry.folder_id, entry.code))}
                                  onChange={() => toggleSelected(entrySortableId(entry.folder_id, entry.code))} />}
                                <button type="button" aria-label={`${entry.name} 이동`} disabled={busy}
                                  ref={drag.setActivatorNodeRef} {...drag.listeners}
                                  className="cursor-grab touch-none text-fg-dimmer opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-40">⠿</button>
                              </span>}
                              dragging={drag.isDragging}
                              trailingAction={
                                <RowTrailing name={entry.name}
                                  onOpenMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)} />
                              }
                            />
                          );
                        };
                        const rowEls = rows.map((entry) => (
                          <SortableEntryRow key={entry.code} code={entry.code} name={entry.name} folderId={entry.folder_id} busy={busy}>
                            {(drag) => renderRow(entry, drag)}
                          </SortableEntryRow>
                        ));
                        return entrySortEnabled ? (
                          <SortableContext items={rows.map((e) => entrySortableId(e.folder_id, e.code))}
                            strategy={verticalListSortingStrategy}>
                            {rowEls}
                          </SortableContext>
                        ) : rowEls;
                      })()}
                    </ul>
                  )}
                </>
              );
              // GroupDropZone: 종목 이동 드롭 타깃. 그 안에서 비검색이면 SortableGroup 으로
              // 헤더를 드래그 활성 영역으로(그룹 순서 변경), 아니면 일반 div.
              return (
                <GroupDropZone key={key} folderId={folder.id} copy={copyIntent}>
                  {groupDragEnabled ? (
                    <SortableGroup folderId={folder.id} busy={busy}>
                      {(dragHandle) => renderGroup(dragHandle)}
                    </SortableGroup>
                  ) : (
                    renderGroup()
                  )}
                </GroupDropZone>
              );
            })}
          </SortableContext>
          <RailDragOverlay droppedOnChart fitContentHeight>
            {ghost && <li data-testid="heatmap-drag-ghost" className="px-md py-1 text-sm font-semibold text-accent">⠿ {ghost} {isEntryDragging ? copyIntent ? '복제' : '이동' : '그룹 이동'}</li>}
          </RailDragOverlay>
        </DndContext>
      </RailDrawerBody>

      <div role="status" aria-live="polite" aria-atomic="true" className="flex min-h-12 shrink-0 items-center gap-2 border-t border-border px-md py-1 text-xs text-fg-dim">
        <span className="line-clamp-3 flex-1">{ghost
          ? destination ? `${data?.folders.find((f) => f.id === destination.folderId)?.name} · ${destination.where} ${copyIntent ? '복제' : '이동'}${!entrySortEnabled ? isSearching ? ' · 검색 중에는 맨 아래에 배치' : ' · 정렬 기준에 따라 배치' : ''}${destination.duplicates ? ` · 기존 ${destination.duplicates}종목${copyIntent ? '은 유지' : '과 합침'}` : ''}`
            : isEntryDragging ? dragHint : '그룹 핸들을 원하는 그룹 위치에 놓으세요'
          : notice || transfer.message || '⠿ 이동 · Ctrl 복제 · Delete로 현재 그룹에서 제외'}</span>
        {!ghost && transfer.canUndo && <button type="button" className="shrink-0 text-accent" disabled={busy} onClick={() => { setNotice(''); void transfer.undo(); }}>되돌리기</button>}
      </div>
      {/* 행 ⋯ 메뉴는 '이 그룹에서 제거'만 — 그룹 이동은 행 드래그앤드롭으로 대체(folders/onMove
          미전달 → HeatmapRowMenu 가 '그룹으로 이동' 섹션을 자체 생략). 제거는 menu.folderId
          스코프 — 다른 그룹에 같은 종목이 등록돼 있으면 그쪽은 남는다. */}
      {menu && (
        <HeatmapRowMenu x={menu.x} y={menu.y} name={menu.name}
          onRemove={() => removeRow(menu.code, menu.folderId)}
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
      {deleteConfirm && (
        <ConfirmModal
          message={<>
            ‘{deleteConfirm.name}’ 그룹과 종목 <b className="font-data">{deleteConfirm.memberCount}</b>개가
            함께 삭제됩니다
          </>}
          confirmLabel="삭제"
          tone="destructive"
          onConfirm={() => { deleteM.mutate(deleteConfirm.folderId); setDeleteConfirm(null); }}
          onClose={() => setDeleteConfirm(null)} />
      )}
    </RailDrawer>
  );
}

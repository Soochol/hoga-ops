import { useEffect, useMemo, useRef, useState } from 'react';
import { useJumpToLive } from '../live/useJumpToLive';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLivePageStore } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';
import { deriveCollectionStatus } from '../live/collectionStatus';
import {
  useWatchlist, useCatchupAll, useRemoveFromWatchlist,
  useCreateFolder, useRenameFolder, useDeleteFolder, useReorderFolders,
  useReorderEntries,
} from './useWatchlist';
import { persistJson, readJsonObject } from '../state/persist';
import { useWatchlistFeedback } from './useWatchlistFeedback';
import { groupByFolder, swapFolderOrder } from './grouping';
import { Countdown } from './Countdown';
import { Banner } from './Banner';
import { WatchlistEditModal } from './WatchlistEditModal';
import { GroupNameModal } from './GroupNameModal';
import { WatchlistRowMenu } from './WatchlistRowMenu';
import { WatchlistGroupPicker } from './WatchlistGroupPicker';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { TrashIcon } from '../ui/TrashIcon';
import { QuoteRow } from '../rightrail/QuoteRow';
import { summarizeCaughtUpAll, formatCaughtUpAllHeader } from './banners';
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter,
  type DragStartEvent, type DragMoveEvent, type DragEndEvent,
  type CollisionDetection, type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WatchlistEntry } from '../api/watchlist';
import { resolveDrag, resolveFolderDrag, entrySortableId, parseEntrySortableId } from './dragHandlers';
import { useEntryDragStore, isPointOnChart } from '../state/entryDrag';

/** 우측 정렬 앵커드 메뉴 셸 — dim 라벨 헤더 + menuitem children. 패널의 두 메뉴
 *  (헤더 편집 메뉴, 그룹 ⋯ 메뉴)가 공유해 컨테이너/헤더 스타일 드리프트를 막는다. */
function AnchoredMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="menu" aria-label={label}
      className="absolute right-0 z-30 mt-1 bg-bg-card border border-border rounded shadow-lg py-1 min-w-[150px]">
      <div className="px-3 py-1 text-xs text-fg-dimmer">{label}</div>
      {children}
    </div>
  );
}

/** 접기 chevron — 펼침=▼(클릭하면 접기), 접힘=▶. 폴더 관용구(VS Code·TradingView),
 *  좌측 배치와 세트. 유니코드 대신 SVG(폰트별 렌더 불일치 회피). */
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
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
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  dragHandle?: GroupDragHandle;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(menuOpen, menuRef, () => setMenuOpen(false));
  const itemClass =
    'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    // sticky + bg-bg-card: 패널 배경과 동일색이라 평시엔 투명처럼 보이고, 스크롤
    // 시에만 불투명이 드러나 행을 가린다(스펙 §1). 각 그룹 div가 컨테이닝 블록이라
    // 헤더는 자기 그룹 범위에서만 고정된다. 메뉴가 열리면 z를 올려 다음 sticky
    // 헤더(z-10)가 이 헤더의 메뉴(z-30, 헤더 스태킹 컨텍스트 내부)를 덮지 않게 한다.
    <div className={`group sticky top-0 ${menuOpen ? 'z-20' : 'z-10'} flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-fg-dim bg-bg-card hover:bg-bg-input-hover`}>
      {props.dragHandle && (
        // 그룹 드래그 핸들 — hover/focus 시 노출(⋯ 메뉴와 같은 관용구), 포인터 전용.
        // aria-hidden + listeners-only(편집 모달 ⠿ 행 핸들과 동일). 헤더 클릭(토글)과
        // 충돌하지 않게 핸들에만 listeners를 건다.
        <span {...props.dragHandle.listeners} aria-hidden data-testid="group-drag-handle"
          className="cursor-grab select-none touch-none px-1 leading-none text-fg-dimmer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          ⠿
        </span>
      )}
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
        <span className="flex-none text-xs font-normal text-fg-dimmer">{props.count}</span>
      </button>
      {props.onRename && (
        <div className="relative" ref={menuRef}>
          {/* opacity(레이아웃 유지)로 숨겨 Tab 포커스가 닿게 한다 — display:none이면
              키보드 사용자가 접근 불가. group-focus-within으로 헤더 내 포커스 시 노출,
              메뉴가 열려 있는 동안엔 계속 보여 앵커를 유지한다(마우스가 떠나도). */}
          <button type="button" aria-label={`${props.label} 그룹 메뉴`}
            aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className={`${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} px-1 leading-none hover:text-fg`}>
            ⋯
          </button>
          {menuOpen && (
            <AnchoredMenu label={props.label}>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onRename?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">✎</span> 그룹 이름 변경
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveUp}
                onClick={() => { setMenuOpen(false); props.onMoveUp?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">▲</span> 위로 이동
              </button>
              <button type="button" role="menuitem" disabled={!props.canMoveDown}
                onClick={() => { setMenuOpen(false); props.onMoveDown?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center">▼</span> 아래로 이동
              </button>
              <button type="button" role="menuitem"
                onClick={() => { setMenuOpen(false); props.onDelete?.(); }}
                className={itemClass}>
                <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 그룹 삭제
              </button>
            </AnchoredMenu>
          )}
        </div>
      )}
    </div>
  );
}

/** 액티브 드래그와 같은 data.type(='entry'|'folder')의 droppable만 closestCenter에 넘긴다 —
 *  중첩 SortableContext의 cross-talk(폴더 컨테이너가 행 위로 끼어드는) 차단. */
const typeAwareCollision: CollisionDetection = (args) => {
  const type = args.active.data.current?.type;
  const same = args.droppableContainers.filter((c) => c.data.current?.type === type);
  return closestCenter({ ...args, droppableContainers: same });
};

/** "차트로 드롭" 판정: dnd-kit 드래그의 최종 포인터 위치를 활성화 이벤트의 시작 좌표 +
 *  누적 delta로 복원한다(dnd-kit이 droppable 등록 없이도 좌표는 항상 제공). activatorEvent가
 *  없으면(합성 이벤트 등) null을 돌려 차트-드롭을 건너뛰고 일반 재정렬로 폴백한다. 이 좌표가
 *  차트 위인지는 entryDrag의 isPointOnChart(LiveWorkarea 등록 술어)가 판정한다 — 패널은
 *  차트 DOM·rect를 모른다. */
function dropPoint(ev: { activatorEvent: Event | null; delta: { x: number; y: number } }): { x: number; y: number } | null {
  const a = ev.activatorEvent as (MouseEvent | PointerEvent) | null;
  if (!a || typeof a.clientX !== 'number' || typeof a.clientY !== 'number') return null;
  return { x: a.clientX + ev.delta.x, y: a.clientY + ev.delta.y };
}

/** 그룹 헤더에 부착할 드래그 핸들 — listeners만(포인터 전용; KeyboardSensor 미도입,
 *  편집 모달 ⠿ 핸들과 동일 계약). */
type GroupDragHandle = { listeners: DraggableSyntheticListeners };

/** 폴더(그룹)의 sortable 단위 = 그룹 블록 전체(헤더 + 종목들). setNodeRef/transform은
 *  컨테이너 div에, listeners는 children render-prop으로 헤더 ⠿ 핸들에 전달한다 —
 *  핸들을 잡으면 그룹이 통째로 움직인다. data.type='folder'로 태깅. */
function SortableGroup({ folderId, children }: {
  folderId: string;
  children: (handle: GroupDragHandle) => React.ReactNode;
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } =
    useSortable({ id: folderId, data: { type: 'folder' } });
  return (
    <div ref={setNodeRef} data-testid={`watchlist-group-${folderId}`}
      style={{
        transform: CSS.Transform.toString(transform), transition,
        ...(isDragging ? { opacity: 0.6, position: 'relative', zIndex: 1 } : {}),
      }}>
      {children({ listeners })}
    </div>
  );
}

/** 패널 종목 행 — 행 전체가 드래그 표면(listeners on <li>). PointerSensor distance:5
 *  임계가 클릭(차트 이동)과 드래그를 구분한다. data.type='entry' + folderId 태깅으로
 *  onDragEnd가 폴더 드래그와 구분한다. */
function SortableQuoteRow(props: {
  entry: WatchlistEntry;
  price: number | null; pct: number | null; changeWon: number | null;
  active: boolean;
  onPick: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete: () => void;
  collectionBadge?: React.ReactNode;
}) {
  const { entry } = props;
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: entrySortableId(entry.folder_id, entry.code), data: { type: 'entry', folderId: entry.folder_id, code: entry.code, name: entry.name } });
  return (
    <QuoteRow
      name={entry.name}
      price={props.price}
      pct={props.pct}
      changeWon={props.changeWon}
      active={props.active}
      ariaLabel={`${entry.name} ${entry.code} 차트 열기`}
      testId={`watchlist-row-${entry.code}`}
      onClick={props.onPick}
      onContextMenu={props.onContextMenu}
      onDelete={props.onDelete}
      indented
      sortableRef={setNodeRef}
      sortableStyle={{ transform: CSS.Transform.toString(transform), transition }}
      dragListeners={listeners}
      dragging={isDragging}
      trailingAction={props.collectionBadge}
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
  const { data, isLoading, error } = useWatchlist();
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
  const [editMenu, setEditMenu] = useState(false);
  const editMenuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(editMenu, editMenuRef, () => setEditMenu(false));
  const [menu, setMenu] =
    useState<{ x: number; y: number; code: string; name: string; folderId: string | null } | null>(null);
  // v3 "그룹 편집" — 행 메뉴/하트가 여는 멤버십 피커(ADR-0070 P5).
  const [groupPicker, setGroupPicker] =
    useState<{ code: string; name: string; x: number; y: number } | null>(null);

  // 다중 소속이라 한 코드가 여러 폴더 행으로 등장 → quote 폴링용 코드는 dedup.
  const codes = useMemo(() => [...new Set(data?.entries.map((e) => e.code) ?? [])], [data]);
  const quoteByCode = useQuoteByCode(codes);

  // ADR-0067: 행별 수집상태 배지 — live_set을 한 번 읽어 공유 (행마다 재계산 없음).
  const { data: liveStatusData } = useLiveStatus();
  const liveSet = liveStatusData?.live_set ?? [];
  const viewedCodes = activeCode ? [activeCode] : [];

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
  const openMenu = (e: React.MouseEvent, code: string, name: string, folderId: string | null) => {
    e.preventDefault();                                   // 네이티브 우클릭 메뉴 억제
    setMenu({ x: e.clientX, y: e.clientY, code, name, folderId });  // raw 좌표 — 클램프는 메뉴가 실측
  };

  const groups = data ? groupByFolder(data.folders, data.entries) : [];
  const folderCount = data?.folders.length ?? 0;
  const realFolderIds = groups.filter((g) => g.folder).map((g) => g.folder!.id);

  const moveFolder = (folderId: string, dir: -1 | 1) => {
    const ids = swapFolderOrder(data?.folders ?? [], folderId, dir);
    if (ids) reorderFoldersM.mutate(ids);
  };

  // v3 폴더 삭제는 파괴적(ADR-0070 P6): 이 폴더에만 있는 코드는 관심종목에서 빠진다.
  // 고아가 생기면 명시적으로 확인(ADR-0065 정신 — 조용한 유실 금지).
  const deleteFolderWithConfirm = (folderId: string) => {
    const entries = data?.entries ?? [];
    const inThis = new Set(entries.filter((e) => e.folder_id === folderId).map((e) => e.code));
    const inOthers = new Set(entries.filter((e) => e.folder_id !== folderId).map((e) => e.code));
    const orphans = [...inThis].filter((c) => !inOthers.has(c));
    if (orphans.length > 0 &&
        !window.confirm(`이 폴더에만 있는 ${orphans.length}종목이 관심종목에서 빠집니다(데이터 수집 중단). 계속할까요?`)) {
      return;
    }
    deleteM.mutate(folderId);
  };

  const reorderEntriesM = useReorderEntries();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // "차트로 드롭" 공유 상태 — LiveWorkarea가 구독해 드롭 타깃 오버레이를 띄운다.
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const setOverChart = useEntryDragStore((s) => s.setOverChart);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);

  const onDragStart = (ev: DragStartEvent) => {
    if (ev.active.data.current?.type === 'entry') startEntryDrag(String(ev.active.id));
  };
  const onDragMove = (ev: DragMoveEvent) => {
    if (ev.active.data.current?.type !== 'entry') return;
    setOverChart(isPointOnChart(dropPoint(ev)));
  };
  const onDragCancel = () => endEntryDrag();

  const onDragEnd = (ev: DragEndEvent) => {
    const wasEntry = ev.active.data.current?.type === 'entry';
    endEntryDrag();
    // 종목 행을 차트 위에 드롭 → 현재 탭 종목 교체(재정렬 대신). 클릭과 같은 onPick 경로를
    // 재사용한다(/live 위라 navigate는 no-op). 차트 밖 드롭이면 아래 재정렬로 폴백.
    if (wasEntry && isPointOnChart(dropPoint(ev))) {
      const d = ev.active.data.current as { code?: string; name?: string } | undefined;
      onPick(d?.code ?? parseEntrySortableId(String(ev.active.id)).code, d?.name);
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
    // v3 composite id: `${folderId}:${code}` — 같은 코드가 N폴더면 N행이라 폴더 스코프로 파싱.
    const { folderId, code: activeCode } = parseEntrySortableId(String(ev.active.id));
    const { code: overCode } = parseEntrySortableId(String(ev.over.id));
    const group = (data?.entries ?? [])
      .filter((e) => e.folder_id === folderId)
      .sort((a, b) => a.order - b.order);
    const r = resolveDrag(group, folderId, activeCode, overCode);
    if (r.kind === 'reorder' && r.folderId !== null) {
      reorderEntriesM.mutate({ folderId: r.folderId, orderedCodes: r.orderedCodes });
    }
  };

  return (
    <div id="right-rail-watchlist-panel" data-testid="watchlist-panel"
      style={{ width: 'var(--watchlist-panel-w)', height: '100%', background: 'var(--bg-card)',
               borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
      {/* 헤더: 관심종목 라벨 + 편집 메뉴 (종목 추가는 편집 모달에서 — 빠른 추가 제거) */}
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{ padding: 'var(--space-sm) var(--space-md)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-dim)', fontFamily: 'monospace',
                         textTransform: 'uppercase', letterSpacing: '0.08em' }}>관심종목</span>
          {/* 편집 → 앵커드 메뉴 (이동 메뉴와 같은 relative+absolute+useDismissablePopover 패턴).
              패널이 뷰포트 우측 끝이라 right-0으로 안쪽으로 연다 — 클램프 불필요. */}
          <div className="relative" ref={editMenuRef}>
            <button type="button" aria-label="관심종목 편집 메뉴" aria-haspopup="menu" aria-expanded={editMenu}
                    onClick={() => setEditMenu((v) => !v)}
                    className="text-fg-dim hover:text-accent text-xs">편집</button>
            {editMenu && (
              <AnchoredMenu label="관심">
                <button type="button" role="menuitem"
                        onClick={() => { setEditMenu(false); setEditOpen(true); }}
                        className="block w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover">
                  관심 편집
                </button>
                <button type="button" role="menuitem"
                        onClick={() => { setEditMenu(false); setAddGroupOpen(true); }}
                        className="block w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover">
                  새 그룹 만들기
                </button>
              </AnchoredMenu>
            )}
          </div>
        </div>
      </div>

      <div data-testid="watchlist-scroll" style={{ flex: 1, overflow: 'auto' }}>
        {isLoading && <div className="p-3 text-fg-dimmer text-sm">불러오는 중</div>}
        {error && <div className="p-3 text-error text-sm">관심종목을 불러올 수 없습니다</div>}
        {!isLoading && !error && (data?.entries.length ?? 0) === 0 && (data?.folders.length ?? 0) === 0 && (
          <div className="p-3 text-fg-dimmer text-sm">관심종목이 없습니다</div>
        )}
        <DndContext sensors={sensors} collisionDetection={typeAwareCollision}
          onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
          <SortableContext items={realFolderIds} strategy={verticalListSortingStrategy}>
            {groups.map((g, gi) => {
              const key = g.folder?.id ?? '__uncat__';
              const label = g.folder?.name ?? '미분류';
              if (g.entries.length === 0 && g.folder === null) return null; // 빈 미분류는 숨김
              const isCollapsed = collapsed.has(key);
              const folder = g.folder;
              const entriesList = !isCollapsed && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  <SortableContext items={g.entries.map((e) => entrySortableId(e.folder_id, e.code))} strategy={verticalListSortingStrategy}>
                    {g.entries.map((entry) => {
                      const q = quoteByCode.get(entry.code);
                      const status = deriveCollectionStatus(entry.code, liveSet, codes, viewedCodes);
                      const badge = status === 'uncollected' ? null : (
                        <span
                          className="font-mono px-1.5 py-0.5 rounded"
                          style={{
                            background: status === 'realtime' ? 'var(--tint-success)' : 'transparent',
                            border: `1px solid ${status === 'realtime' ? 'var(--tint-success-border)' : 'var(--border)'}`,
                            color: status === 'realtime' ? 'var(--success)' : 'var(--fg-dimmer)',
                            fontSize: 'var(--text-xs)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {/* TODO(label): 배지 문구 확정 */}
                          {status === 'realtime' ? '실시간' : status === 'polling' ? '준실시간' : '저녁대기'}
                        </span>
                      );
                      return (
                        <SortableQuoteRow
                          key={entrySortableId(entry.folder_id, entry.code)}
                          entry={entry}
                          price={q?.price ?? null}
                          pct={q?.change_pct ?? null}
                          changeWon={q?.change_won ?? null}
                          active={entry.code === activeCode}
                          onPick={() => onPick(entry.code, entry.name)}
                          onContextMenu={(e) => openMenu(e, entry.code, entry.name, entry.folder_id)}
                          onDelete={() => removeM.mutate(entry.code)}
                          collectionBadge={badge}
                        />
                      );
                    })}
                  </SortableContext>
                </ul>
              );
              const renderHeader = (dragHandle?: GroupDragHandle) => (
                <GroupHeader label={label} count={g.entries.length} collapsed={isCollapsed}
                  onToggle={() => toggle(key)}
                  onRename={folder ? () => setRenameTarget({ id: folder.id, name: folder.name }) : undefined}
                  onDelete={folder ? () => deleteFolderWithConfirm(folder.id) : undefined}
                  onMoveUp={folder ? () => moveFolder(folder.id, -1) : undefined}
                  onMoveDown={folder ? () => moveFolder(folder.id, +1) : undefined}
                  canMoveUp={gi > 0}
                  canMoveDown={gi < folderCount - 1}
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
        </DndContext>
      </div>

      {/* 푸터: 전체수집 결과 배너 + 다음 수집 카운트다운 + 전체 수집 */}
      {recentAction?.kind === 'caught_up_all' && (() => {
        const s = summarizeCaughtUpAll(recentAction.summary);
        return (
          <div className="px-3 py-2 border-t border-border">
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
      <div style={{ borderTop: '1px solid var(--border)', padding: 'var(--space-sm) var(--space-md)' }}
           className="text-xs text-fg-dim flex items-center justify-between gap-2">
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

      {menu && (
        <WatchlistRowMenu x={menu.x} y={menu.y} name={menu.name}
          onEditGroups={() => setGroupPicker({ code: menu.code, name: menu.name, x: menu.x, y: menu.y })}
          onRemove={() => removeM.mutate(menu.code)} onClose={() => setMenu(null)} />
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
    </div>
  );
}

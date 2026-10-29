import { StudyGroupDialog, type StudyGroupAction } from './StudyGroupDialog';
import { useStudyViewReveal } from './studyViewReveal';
import { ClearSearchIcon } from '../ui/ClearSearchIcon';
import { PlusIcon } from '../ui/RailActionIcons';
import { usePanelRowSelection } from '../rightrail/usePanelRowSelection';
import { PanelContextMenu } from '../ui/PanelContextMenu';
import { openPanelContextMenuFromKeyboard, panelDragListeners } from '../ui/panelRowInteractions';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStudyViewDeletion } from './studyViewDeletion';
import { DragPanelAssist } from '../watchlist/DragPanelAssist';
import { RailDragOverlay } from '../rightrail/RailDragOverlay';
import { dropPoint } from '../state/entryDrag';
import { dropIndicatorClass, type DropIndicator } from '../ui/sortableDragVisuals';
import { useNavigate, useLocation } from 'react-router';
import { DndContext, PointerSensor, useSensor, useSensors, type DraggableSyntheticListeners, type DragEndEvent, type DragStartEvent, type DragMoveEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { StudyViewListRow } from '../api/studyViews';
import { useLivePageStore } from '../state/livePage';
import { openSavedRange } from './openSavedRange';
import { openSavedViewInNewTab } from './studyDeepLink';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import { RailDrawer, RailDrawerBody, RailDrawerHeader, RailDrawerSection, RailState, RailTreeRow } from '../ui/RailShell';
import { GroupToggleButton } from '../ui/GroupToggleButton';
import { ChevronIcon } from '../ui/ChevronIcon';
import { SortCycleButton } from '../ui/SortCycleButton';
import { resolveStudyViewTreeDrag, studyViewGroupDndId, studyViewRowDndId, studyViewTreeCollision } from './studyViewTreeDnd';
import { useStudyViewTreeState } from './useStudyViewTreeState';
import { StudyViewRowMenu } from './StudyViewRowMenu';
import { formatStudyViewTitle, formatStudyViewMeta } from './StudyViewsDrawerHelpers';


const EMPTY_GROUPS: import('../api/studyViews').StudyViewGroup[] = [];

const NO_COLLAPSED_GROUPS = new Set<string>();

const ignoreExpand = () => {};


type TreeDragHandle = { listeners: DraggableSyntheticListeners; setActivatorNodeRef: (node: HTMLElement | null) => void };

/** Modified clicks select rows or open a tab, and must never begin a drag. */
function studyViewDragListeners(listeners: DraggableSyntheticListeners): DraggableSyntheticListeners {
  const guarded = panelDragListeners(listeners);
  if (!guarded) return undefined;
  return {
    ...guarded,
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      guarded.onPointerDown?.(event);
    },
  };
}

function SortableStudyViewGroup({ id, disabled, indicator, children }: {
  id: string; disabled: boolean; indicator?: DropIndicator;
  children: (handle: TreeDragHandle) => ReactNode;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: studyViewGroupDndId(id), disabled, data: { type: 'group', groupKey: id },
  });
  return <div ref={setNodeRef} data-testid={`saved-view-group-${id}`} className={`relative ${dropIndicatorClass(indicator)}`}
    style={{ opacity: isDragging ? 0.35 : undefined }}>
    {children({ listeners, setActivatorNodeRef })}
  </div>;
}

function SortableStudyViewRow({ row, groupKey, disabled, indicator, children }: {
  row: StudyViewListRow; groupKey: string; disabled: boolean; indicator?: DropIndicator;
  children: (handle: TreeDragHandle) => ReactNode;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: studyViewRowDndId(row.id), disabled, data: { type: 'row', groupKey },
  });
  return <div ref={setNodeRef} data-testid={`saved-view-item-${row.id}`} className={`relative ${dropIndicatorClass(indicator)}`}
    style={{ opacity: isDragging ? 0.35 : undefined }}>
    {children({ listeners, setActivatorNodeRef })}
  </div>;
}


export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const mutations = useStudyViewMutations();
  const [groupAction, setGroupAction] = useState<StudyGroupAction | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  const [moveError, setMoveError] = useState('');
  const reveal = useStudyViewReveal((s) => s.target);
  const savedGroups = data?.groups ?? EMPTY_GROUPS;
  const [rowMenu, setRowMenu] = useState<{ row: StudyViewListRow; left: number; top: number } | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [memoState, setMemoState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const client = useQueryClient();
  const deletionBatches = useStudyViewDeletion((s) => s.batches);
  const [ghost, setGhost] = useState<string | null>(null);
  const [destination, setDestination] = useState<{ id: string; side: DropIndicator; label: string } | null>(null);
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const dragIds = useRef<string[]>([]);
  const [dragHint, setDragHint] = useState('원하는 그룹이나 위치에 놓으세요 · 패널 밖은 취소');
  const renameCommittingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const memoCommittingRef = useRef(false);
  const memoInputRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // Pending rows stay in the order model and are hidden only in the rendered list.
  const allSaves = data?.saves ?? [];
  const hiddenIds = useMemo(() => new Set(deletionBatches.filter((b) => b.phase !== 'complete').flatMap((b) => b.rows.map((r) => r.id))), [deletionBatches]);
  const {
    query,
    setQuery,
    revealGroup,
    sortAction,
    cycleSortMode,
    dragEnabled,
    visibleGroups: treeGroups,
    visibleGroupsCollapsed,
    isCollapsed,
    toggleGroup,
    toggleVisibleGroups,
    placeRows, placeGroup, searching, orderMessage, canUndoOrder, undoReorder, useManualSort,
  } = useStudyViewTreeState(allSaves, savedGroups, data !== undefined);
  // Keep pending deletions in the order model so Undo also restores their exact position.
  const visibleGroups = useMemo(() => treeGroups.map((g) => ({ ...g, rows: g.rows.filter((r) => !hiddenIds.has(r.id)) })), [treeGroups, hiddenIds]);
  const visibleRows = visibleGroups.flatMap((g) => isCollapsed(g.key) ? [] : g.rows);
  const visibleIds = visibleRows.map((r) => r.id);
  const { selectedRows: selected, clear: clearSelection, select: selectRow } = usePanelRowSelection(visibleIds);
  const selectedRows = visibleRows.filter((r) => selected.has(r.id));
  useEffect(() => {
    if (!reveal || !allSaves.some((r) => r.id === reveal.id)) return;
    revealGroup(reveal.groupId);
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-saved-row="${reveal.id}"]`)?.scrollIntoView?.({ block: 'nearest' });
      document.querySelector<HTMLElement>(`[data-saved-row="${reveal.id}"]`)?.focus();
      useStudyViewReveal.setState({ target: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, data]);
  const searchScroll = useRef<number | null>(null);
  useEffect(() => {
    const node = document.querySelector('[data-testid="saved-views-scroll"]');
    if (!node) return;
    if (searching && searchScroll.current === null) { searchScroll.current = node.scrollTop; node.scrollTop = 0; }
    if (!searching && searchScroll.current !== null) { node.scrollTop = searchScroll.current; searchScroll.current = null; }
  }, [searching]);
  // Toast retries enter the shared queue without going through this drawer's
  // delete handler. Release editing state at that external state transition.
  useEffect(() => useStudyViewDeletion.subscribe((state) => {
    const queued = new Set(state.batches.filter((batch) => batch.phase !== 'complete')
      .flatMap((batch) => batch.rows.map((row) => row.id)));
    if (renameState && queued.has(renameState.id)) {
      renameCommittingRef.current = false;
      setRenameState(null);
    }
    if (memoState && queued.has(memoState.id)) {
      memoCommittingRef.current = false;
      setMemoState(null);
    }
  }), [renameState, memoState]);
  const canDrag = dragEnabled && !renameState && !memoState && !mutations.move.isPending;
  const currentStudyViewId = useMemo(() => new URLSearchParams(location.search).get('view'), [location.search]);
  /**
   * "지금 열려 있는 저장뷰" = `/live` 의 **저장 구간 슬롯**(2026-08-23).
   *
   * 그전 출처는 `/study` 의 그룹→저장뷰 맵이었다(ADR-0155). 그 페이지가 사라지면서
   * 열린 뷰는 다시 **한 번에 하나**가 됐고, 그 하나를 아는 곳이 이 슬롯이다.
   *
   * URL 을 안 보고 스토어를 보는 이유는 그대로다 — 이 드로어는 우측 레일의 전역
   * 컴포넌트라 `?view=` 없이 도착한 `/live`(관심종목 클릭 등)에서도 하이라이트가
   * 살아야 한다. URL 폴백은 슬롯이 아직 안 세워진 딥링크 첫 프레임을 메운다.
   */
  const savedRangeViewId = useLivePageStore((s) => s.savedRangeFocus?.viewId ?? null);
  const openStudyViewId = savedRangeViewId ?? currentStudyViewId;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    if (!renameState) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameState?.id]);

  useEffect(() => {
    if (!memoState) return;
    memoInputRef.current?.focus();
    memoInputRef.current?.select();
  }, [memoState?.id]);

  const startRename = (row: StudyViewListRow) => {
    setMemoState(null);
    setRenameState({ id: row.id, value: row.name, error: null });
  };

  const cancelRename = () => {
    renameCommittingRef.current = false;
    setRenameState(null);
  };

  const startMemoEdit = (row: StudyViewListRow) => {
    setRenameState(null);
    setMemoState({ id: row.id, value: row.memo, error: null });
  };

  const cancelMemoEdit = () => {
    memoCommittingRef.current = false;
    setMemoState(null);
  };

  /**
   * 저장뷰를 **`/live` 에서 연다** — 행 클릭의 목적지 (2026-08-21 사용자 결정,
   * `/study` 진입로를 대체한다).
   *
   * 두 단계이고 **순서가 계약이다**:
   *  1. `activateLiveCode` — 종목 교체. 목적지는 `activationTarget` 이 고르므로
   *     **포커스 그룹만** 바뀌고 **핀 걸린 창은 건드리지 않는다**(ADR-0153).
   *     이 호출이 이전 슬롯을 해제한다(종목이 다를 때만).
   *  2. `focusSavedRange` — 기간 슬롯 세팅. 반드시 **나중**이다. 역순이면 1단계의
   *     해제 트리거가 방금 세운 슬롯을 스스로 지운다.
   *
   * 여기서 `/study` 워크스페이스(`setGroupView`)는 건드리지 않는다 — 두 페이지가
   * 같은 저장뷰 슬롯을 공유하면 `/live` 클릭이 `/study` 창 배치를 조용히 바꾼다.
   *
   * ctrl/⌘+클릭은 이 함수를 부르지 않지만 **목적지는 같다** — 새 브라우저 탭에서
   * `/live?view=` 를 열고(`openSavedViewInNewTab`), 착지 쪽이 여기와 같은 두 단계를
   * 같은 순서로 밟는다(`useSavedRangeDeepLink`). 2026-08-23 까지는 그쪽만 `/study`
   * 새 탭이라 같은 행의 두 제스처가 다른 페이지로 갈라져 있었다.
   */
  function openSavedRangeInLive(row: StudyViewListRow) {
    openSavedRange(row);
    if (location.pathname !== '/live') navigate('/live');
  }

  const commitRename = (row: StudyViewListRow) => {
    if (!renameState || renameState.id !== row.id || renameCommittingRef.current) return;
    const name = renameState.value.trim();
    if (!name || name === row.name) {
      cancelRename();
      return;
    }
    renameCommittingRef.current = true;
    mutations.updateMetadata.mutate(
      { id: row.id, body: { name } },
      {
        onSuccess: () => cancelRename(),
        onError: (error) => {
          renameCommittingRef.current = false;
          setRenameState((current) => current?.id === row.id
            ? { ...current, error: error instanceof Error ? error.message : '이름 변경에 실패했습니다' }
            : current);
        },
      },
    );
  };

  const commitMemo = (row: StudyViewListRow) => {
    if (!memoState || memoState.id !== row.id || memoCommittingRef.current) return;
    const memo = memoState.value.trim();
    if (memo === row.memo) {
      cancelMemoEdit();
      return;
    }
    memoCommittingRef.current = true;
    mutations.updateMetadata.mutate(
      { id: row.id, body: { memo } },
      {
        onSuccess: () => cancelMemoEdit(),
        onError: (error) => {
          memoCommittingRef.current = false;
          setMemoState((current) => current?.id === row.id
            ? { ...current, error: error instanceof Error ? error.message : '메모 저장에 실패했습니다' }
            : current);
        },
      },
    );
  };

  const requestDeleteRows = (rows: StudyViewListRow[]) => {
    const removing = new Set(rows.map((r) => r.id));
    if (renameState && removing.has(renameState.id)) cancelRename();
    if (memoState && removing.has(memoState.id)) cancelMemoEdit();
    const nodes = [...document.querySelectorAll<HTMLElement>('#right-rail-saved-views-panel [data-saved-row]')];
    const focused = document.activeElement?.closest<HTMLElement>('[data-saved-row]')
      ?? (document.activeElement?.closest('[role="menu"]')
        ? nodes.find((node) => removing.has(node.dataset.savedRow ?? '')) : undefined);
    if (focused && removing.has(focused.dataset.savedRow ?? '')) {
      const at = nodes.indexOf(focused);
      const next = [...nodes.slice(at + 1), ...nodes.slice(0, at).reverse()].find((node) => !removing.has(node.dataset.savedRow ?? ''));
      next?.focus();
      if (!next) document.querySelector<HTMLInputElement>('[aria-label="저장뷰 검색"]')?.focus();
    }
    useStudyViewDeletion.getState().queue(rows, client);
    clearSelection();
  };
  const requestDelete = (row: StudyViewListRow) => requestDeleteRows([row]);
  const pickRow = (row: StudyViewListRow, event: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
    if (mutations.move.isPending) return;
    if (selectRow(row.id, event)) return;
    if (event.ctrlKey || event.metaKey) openSavedViewInNewTab(row.id);
    else openSavedRangeInLive(row);
  };
  const showRowMenu = (row: StudyViewListRow, event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    setGroupMenu(null);
    if (selected.has(row.id) && selectedRows.length) {
      setRowMenu(null);
      setSelectionMenu({ x: event.clientX, y: event.clientY });
    } else {
      clearSelection();
      setSelectionMenu(null);
      setRowMenu({ row, left: event.clientX, top: event.clientY });
    }
  };
  const getDestination = (event: DragMoveEvent | DragEndEvent) => {
    const intent = resolveStudyViewTreeDrag(event);
    if (!intent || !event.over) return null;

    const point = pointRef.current ?? dropPoint(event);
    const side: DropIndicator = point && point.y > event.over.rect.top + event.over.rect.height / 2 ? 'after' : 'before';
    const row = intent.type === 'row' ? allSaves.find((r) => r.id === intent.overId) : null;
    const name = row ? `${formatStudyViewTitle(row)} (${formatStudyViewMeta(row)})` : visibleGroups.find((g) => g.key === (intent.type === 'group' ? intent.overKey : intent.groupKey))?.label;
    return { id: String(event.over.id), side, label: intent.type === 'row' && !intent.overId ? `${name ?? ''} 그룹으로 이동` : `${name ?? ''} ${side === 'after' ? '아래' : '위'}로 이동` };
  };
  const handleDragStart = (event: DragStartEvent) => {
    pointRef.current = dropPoint({ activatorEvent: event.activatorEvent, delta: { x: 0, y: 0 } });
    const row = allSaves.find((r) => studyViewRowDndId(r.id) === String(event.active.id));
    dragIds.current = row ? selected.has(row.id) ? selectedRows.map((r) => r.id) : [row.id] : [];
    setGhost(row ? dragIds.current.length > 1 ? `${dragIds.current.length}개 저장뷰` : row.name
      : visibleGroups.find((g) => studyViewGroupDndId(g.key) === String(event.active.id))?.label ?? '그룹');
    setDragHint('원하는 그룹이나 위치에 놓으세요 · 패널 밖은 취소');
  };
  const handleDragMove = (event: DragMoveEvent) => {
    const next = getDestination(event);
    setDestination((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
  };
  const finishDrag = () => { setGhost(null); setDestination(null); pointRef.current = null; };
  const handleDragEnd = (event: DragEndEvent) => {
    const next = getDestination(event);
    const intent = resolveStudyViewTreeDrag(event);
    finishDrag();
    if (!intent || !next) return;
    if (intent.type === 'group') placeGroup(intent.activeKey, intent.overKey, next.side);
    else if (dragIds.current.every((id) => allSaves.find((r) => r.id === id)?.group_id === intent.groupKey) && intent.overId) {
      placeRows(intent.groupKey, dragIds.current, intent.overId, next.side);
    } else {
      setMoveError('');
      mutations.move.mutate({ ids: dragIds.current, groupId: intent.groupKey }, {
        onSuccess: () => { placeRows(intent.groupKey, dragIds.current, intent.overId, next.side); clearSelection(); revealGroup(intent.groupKey); },
        onError: (e) => setMoveError(e instanceof Error ? e.message : '이동에 실패했습니다'),
      });
    }
  };

  const renderStudyViewRow = (row: StudyViewListRow, handle: TreeDragHandle) => {
    const isActive = openStudyViewId === row.id;
    const isEditing = renameState?.id === row.id || memoState?.id === row.id;
    const stockName = row.label || row.code;
    const title = formatStudyViewTitle(row);
    return (
      <RailTreeRow
        key={row.id}
        data-saved-row={row.id}
        ref={handle.setActivatorNodeRef}
        {...studyViewDragListeners(canDrag ? handle.listeners : undefined)}
        data-draggable={canDrag ? '' : undefined}
        className={`group select-none touch-none ${canDrag ? ghost ? 'cursor-grabbing' : 'cursor-grab' : 'cursor-pointer'}`}
        role={isEditing ? undefined : 'button'}
        tabIndex={isEditing ? undefined : 0}
        aria-label={isEditing ? undefined : `${row.name} 저장뷰 열기`}
        aria-current={isActive ? 'true' : undefined}
        aria-pressed={isEditing ? undefined : selected.has(row.id)}
        aria-haspopup={isEditing ? undefined : 'menu'}
        aria-keyshortcuts={isEditing ? undefined : 'Delete Shift+F10 ContextMenu'}
        data-selected={selected.has(row.id) ? 'true' : undefined}
        style={{
          background: selected.has(row.id) ? 'var(--tint-selection)' : undefined,
          cursor: canDrag ? ghost ? 'grabbing' : 'grab' : 'pointer',
        }}
        onClick={isEditing ? undefined : (e) => pickRow(row, e)}
        onContextMenu={isEditing ? undefined : (e) => showRowMenu(row, e)}
        onKeyDown={isEditing ? undefined : (e) => {
          if (e.target !== e.currentTarget) return;
          if (openPanelContextMenuFromKeyboard(e)) return;
          if (e.key === 'Delete') {
            e.preventDefault();
            requestDeleteRows(selectedRows.length ? selectedRows : [row]);
            return;
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const nextId = visibleIds[visibleIds.indexOf(row.id) + (e.key === 'ArrowDown' ? 1 : -1)];
            const next = allSaves.find((r) => r.id === nextId);
            if (!next) return;
            if (e.shiftKey && !selected.size) selectRow(row.id, {});
            if (e.shiftKey) selectRow(next.id, { shiftKey: true, altKey: e.altKey });
            else pickRow(next, e);
            const node = Array.from(e.currentTarget.closest('aside')!.querySelectorAll<HTMLElement>('[data-saved-row]'))
              .find((n) => n.dataset.savedRow === nextId);
            node?.focus();
            node?.scrollIntoView?.({ block: 'nearest' });
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickRow(row, e);
          }
        }}
      >
        {renameState?.id === row.id ? (
          <div className="min-w-0 flex-1 space-y-1">
            <input
              aria-label="저장뷰 이름 수정"
              autoFocus
              ref={renameInputRef}
              value={renameState.value}
              onChange={(e) => setRenameState({ ...renameState, value: e.target.value, error: null })}
              onBlur={() => commitRename(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename(row);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              className="w-full rounded border border-border bg-bg-input px-1 py-0.5 text-xs text-fg"
            />
            {renameState.error && <div className="text-xs text-danger">{renameState.error}</div>}
          </div>
        ) : memoState?.id === row.id ? (
          <div className="min-w-0 flex-1 space-y-1">
            <div className="truncate text-xs text-fg">{row.name}</div>
            <textarea
              aria-label="저장뷰 메모 수정"
              autoFocus
              ref={memoInputRef}
              rows={2}
              value={memoState.value}
              onChange={(e) => setMemoState({ ...memoState, value: e.target.value, error: null })}
              onBlur={() => commitMemo(row)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitMemo(row);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelMemoEdit();
                }
              }}
              className="w-full resize-none rounded border border-border bg-bg-input px-1 py-0.5 text-xs text-fg"
            />
            {memoState.error && <div className="text-xs text-danger">{memoState.error}</div>}
          </div>
        ) : (
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(6em,1fr)_max-content] items-center gap-2 text-xs leading-tight">
            <div className="truncate text-xs">
              <span className={isActive ? 'font-semibold text-accent' : 'text-fg'}>{stockName}</span>
              <span className="font-normal text-fg-dim">{title.slice(stockName.length)}</span>
            </div>
            <div className="shrink-0 whitespace-nowrap text-right text-xs leading-tight text-fg-dim font-data tabular-nums">
              {formatStudyViewMeta(row)}
            </div>
          </div>
        )}
      </RailTreeRow>
    );
  };

  return (
    <RailDrawer id="right-rail-saved-views-panel" ariaLabel="저장뷰" onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || ghost || rowMenu || groupMenu || selectionMenu
        || (event.target as HTMLElement).closest('input, textarea, [role="dialog"]')) return;
      if (selected.size) { event.preventDefault(); event.stopPropagation(); clearSelection(); }
    }}>
      <RailDrawerHeader
        title="저장뷰"
        actions={<button type="button" aria-label="새 그룹 만들기" data-tooltip="새 그룹 만들기"
          className="flex h-7 items-center gap-1 rounded px-2 text-xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
          onClick={() => setGroupAction({ type: 'create' })}><PlusIcon /> 그룹</button>}
      />
      <RailDrawerSection className="px-md py-sm">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <input
                aria-label="저장뷰 검색"
                placeholder="그룹·종목·저장뷰 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
                className="w-full bg-bg-input border rounded py-1 pl-2 pr-8 text-sm"
              />
              {query && (
                <button
                  type="button"
                  aria-label="검색어 지우기"
                  data-tooltip="검색어 지우기"
                  onClick={() => setQuery('')}
                  className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  <ClearSearchIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <GroupToggleButton testId="saved-views-toggle-all" allCollapsed={visibleGroupsCollapsed}
              onToggle={toggleVisibleGroups} disabled={searching || visibleGroups.length === 0}
              title={searching ? '검색 해제 후 전체 접기 사용' : undefined} />
          </div>
          {selectedRows.length > 0 && <div className="mt-1.5 flex min-h-7 flex-wrap items-center gap-2 text-xs" data-testid="saved-view-selection-actions">
            <span role="status" className="mr-auto text-fg-dim">{selectedRows.length}개 선택</span>
            <button type="button" disabled={mutations.move.isPending} className="text-accent disabled:opacity-40" onClick={() => setGroupAction({ type: 'move', ids: selectedRows.map((r) => r.id) })}>이동</button>
            <button type="button" disabled={mutations.move.isPending} className="text-accent disabled:opacity-40" onClick={() => requestDeleteRows(selectedRows)}>삭제</button>
            <button type="button" className="text-fg-dim" onClick={clearSelection}>선택 해제</button>
          </div>}
          <div className="mt-1.5 flex items-center gap-1">
            <SortCycleButton onClick={cycleSortMode} direction={sortAction.direction === 'default' ? 'none' : sortAction.direction}
              label={sortAction.label} visibleLabel="이름" />

          </div>
      </RailDrawerSection>
        {isLoading && <RailState>불러오는 중</RailState>}
        {isError && (
          <RailState tone="error">
            <p>저장뷰를 불러오지 못했습니다</p>
            <button type="button" onClick={() => refetch()} className="mt-2 underline">다시 시도</button>
          </RailState>
        )}
        {!isLoading && !isError && (data?.groups.length ?? 0) === 0 && (
          <RailState>그룹을 만들고 캔들차트의 저장 버튼으로 추가하세요</RailState>
        )}
        {!isLoading && !isError && (data?.groups.length ?? 0) > 0 && visibleGroups.length === 0 && (
          <RailState>{hiddenIds.size > 0 && !searching ? '삭제 대기 중입니다 · 실행 취소로 복원할 수 있습니다' : '검색 결과가 없습니다'}</RailState>
        )}
        <RailDrawerBody testId="saved-views-scroll">
          <DndContext
            sensors={sensors}
            collisionDetection={studyViewTreeCollision}
            autoScroll={false}
            onDragStart={handleDragStart} onDragMove={handleDragMove} onDragOver={handleDragMove}
            onDragEnd={handleDragEnd} onDragCancel={finishDrag}
          >
            <DragPanelAssist collapsed={NO_COLLAPSED_GROUPS} onExpand={ignoreExpand} pointRef={pointRef} scrollSelector='[data-testid="saved-views-scroll"]' />
            <div className="w-min min-w-full">
            <SortableContext items={visibleGroups.map((group) => studyViewGroupDndId(group.key))} strategy={verticalListSortingStrategy}>
              {visibleGroups.map((group) => {
                const groupCollapsed = isCollapsed(group.key);
                return (
                  <SortableStudyViewGroup key={group.key} id={group.key} disabled={!canDrag} indicator={destination?.id === studyViewGroupDndId(group.key) ? destination.side : undefined}>
                    {(groupHandle) => (
                      <section aria-label={`${group.label} 저장뷰`}>
                        <div
                          ref={groupHandle.setActivatorNodeRef}
                          {...studyViewDragListeners(canDrag ? groupHandle.listeners : undefined)}
                          data-testid="saved-view-group-header"
                          data-draggable={canDrag ? '' : undefined}
                          role="group" tabIndex={0} aria-label={`${group.label} 그룹`} aria-haspopup="menu"
                          aria-keyshortcuts="Shift+F10 ContextMenu"
                          onContextMenu={(event) => {
                            event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
                            setRowMenu(null); setSelectionMenu(null);
                            setGroupMenu({ id: group.key, x: event.clientX, y: event.clientY });
                          }}
                          onKeyDown={openPanelContextMenuFromKeyboard}
                          className={`group select-none touch-none sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1.5 min-h-list-group-header text-sm font-semibold text-fg-dim bg-bg hover:bg-bg-input-hover ${canDrag ? ghost ? 'cursor-grabbing' : 'cursor-grab' : ''}`}>
                          <button type="button" aria-label={`${group.label} ${groupCollapsed ? '펼치기' : '접기'}`}
                            aria-expanded={!groupCollapsed} onClick={() => toggleGroup(group.key)} disabled={searching}
                            className="grid h-6 w-6 shrink-0 place-items-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg disabled:opacity-40">
                            <ChevronIcon collapsed={groupCollapsed} />
                          </button>
                          <button type="button" data-panel-drag-label aria-label={`${group.label} ${group.rows.length}`}
                            aria-expanded={!groupCollapsed} onClick={() => toggleGroup(group.key)} disabled={searching}
                            className={`flex min-w-0 flex-1 items-baseline gap-1.5 text-left ${canDrag ? 'cursor-grab' : ''}`}>
                            <span className="truncate">{group.label}</span>
                            <span className="shrink-0 text-xs font-normal text-fg-dim">{group.rows.length}</span>
                          </button>
                          {searching && <span className="text-xs font-normal text-fg-dim">전체 {allSaves.filter((r) => r.group_id === group.key).length}</span>}
                        </div>
                        {!groupCollapsed && group.rows.length === 0 && <p className="px-4 py-3 text-xs text-fg-dim">캔들차트의 저장 버튼으로 추가</p>}
                        {!groupCollapsed && (
                          <SortableContext items={group.rows.map((row) => studyViewRowDndId(row.id))} strategy={verticalListSortingStrategy}>
                            {group.rows.map((row) => (
                              <SortableStudyViewRow key={row.id} row={row} groupKey={group.key} disabled={!canDrag} indicator={destination?.id === studyViewRowDndId(row.id) ? destination.side : undefined}>
                                {(handle) => renderStudyViewRow(row, handle)}
                              </SortableStudyViewRow>
                            ))}
                          </SortableContext>
                        )}
                      </section>
                    )}
                  </SortableStudyViewGroup>
                );
              })}
            </SortableContext>
            </div>
            <RailDragOverlay droppedOnChart fitContentHeight>
              {ghost && <li data-testid="saved-view-drag-ghost" className="px-md py-1 text-sm font-semibold text-accent">{ghost}</li>}
            </RailDragOverlay>
          </DndContext>
        </RailDrawerBody>
      {(ghost || orderMessage || !dragEnabled) && <div role="status" aria-label="저장뷰 순서 안내" className="flex min-h-12 shrink-0 items-center gap-2 border-t border-border px-md py-1 text-xs text-fg-dim">
        <span className="line-clamp-3 flex-1">{ghost ? destination?.label ?? dragHint : !dragEnabled
          ? searching ? '검색 중에는 순서를 변경할 수 없습니다' : '이름 정렬 중에는 순서를 변경할 수 없습니다'
          : orderMessage}</span>
        {!ghost && canUndoOrder && <button type="button" className="shrink-0 text-accent" onClick={undoReorder}>순서 되돌리기</button>}
        {!ghost && !dragEnabled && !searching && <button type="button" className="shrink-0 text-accent" onClick={useManualSort}>수동 정렬</button>}
      </div>}
      {moveError && <p role="alert" className="p-3 text-xs text-error">{moveError}</p>}
      {groupAction && <StudyGroupDialog action={groupAction} groups={savedGroups} onClose={() => { setGroupAction(null); clearSelection(); }} />}
      {groupMenu && <PanelContextMenu point={groupMenu} label={`${savedGroups.find((g) => g.id === groupMenu.id)?.name ?? ''} 그룹 메뉴`} onClose={() => setGroupMenu(null)}>
        {(['rename', 'delete'] as const).map((type) => <button type="button" role="menuitem" key={type}
          className="block w-full px-3 py-1.5 text-left text-sm hover:bg-bg-input-hover"
          onClick={() => {
            const found = savedGroups.find((g) => g.id === groupMenu.id);
            const rows = allSaves.filter((r) => r.group_id === groupMenu.id);
            if (found) {
              if (type === 'delete' && rows.length === 0) mutations.deleteGroup.mutate(found.id, { onError: (e) => setMoveError(e.message) });
              else setGroupAction({ type, group: found, count: rows.length, ids: rows.map((r) => r.id) });
            }
            setGroupMenu(null);
          }}>{type === 'rename' ? '이름 변경' : '그룹 삭제'}</button>)}
      </PanelContextMenu>}
      {selectionMenu && selectedRows.length > 0 && <PanelContextMenu point={selectionMenu} label={`${selectedRows.length}개 저장뷰 선택`} onClose={() => setSelectionMenu(null)}>
        <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-bg-input-hover"
          onClick={() => { setGroupAction({ type: 'move', ids: selectedRows.map((r) => r.id) }); setSelectionMenu(null); }}>그룹 이동</button>
        <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-sm text-error hover:bg-tint-error"
          onClick={() => { requestDeleteRows(selectedRows); setSelectionMenu(null); }}>삭제</button>
      </PanelContextMenu>}
      {rowMenu && (
        <StudyViewRowMenu
          x={rowMenu.left}
          y={rowMenu.top}
          name={rowMenu.row.name}
          onOpen={() => openSavedRangeInLive(rowMenu.row)}
          onOpenNewTab={() => openSavedViewInNewTab(rowMenu.row.id)}
          onMove={() => setGroupAction({ type: 'move', ids: [rowMenu.row.id] })}
          onRename={() => startRename(rowMenu.row)}
          onEditMemo={() => startMemoEdit(rowMenu.row)}
          onDelete={() => requestDelete(rowMenu.row)}
          onClose={() => setRowMenu(null)}
        />
      )}
    </RailDrawer>
  );
}

import { studyViewPeriod, studyTimeframeLabel } from './studyViewPeriod';
import { StudyGroupDialog, type StudyGroupAction } from './StudyGroupDialog';
import { useStudyViewReveal } from './studyViewReveal';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { ClearSearchIcon } from '../ui/ClearSearchIcon';
import { MoreIcon, GripIcon } from '../ui/RailActionIcons';
import { RailSelectionControl } from '../rightrail/RailSelectionControl';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStudyViewDeletion } from './studyViewDeletion';
import { DragPanelAssist } from '../watchlist/DragPanelAssist';
import { RailDragOverlay } from '../rightrail/RailDragOverlay';
import { dropPoint } from '../state/entryDrag';
import { dropIndicatorClass, type DropIndicator } from '../ui/sortableDragVisuals';
import { useNavigate, useLocation } from 'react-router';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { StudyViewListRow } from '../api/studyViews';
import { wantsNewTab } from '../live/useJumpToLive';
import { activateLiveCode } from '../live/liveNavigate';
import { useLivePageStore } from '../state/livePage';
import { savedRangeFocusFromView } from './savedRangeFocus';
import { openSavedViewInNewTab } from './studyDeepLink';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import {
  RailDrawer,
  RailDrawerBody,
  RailDrawerHeader,
  RailDrawerSection,
  RailGroupHeader,
  RailState,
  RailToolbarIconButton,
  RailTreeRow,
} from '../ui/RailShell';
import { CollapseAllIcon, ExpandAllIcon } from '../ui/CollapseAllIcon';
import { ChevronIcon } from '../ui/ChevronIcon';
import { SortCycleButton } from '../ui/SortCycleButton';
import { normalizeStudyViewQuery } from './studyViewTree';
import {
  resolveStudyViewTreeDrag,
  studyViewGroupDndId,
  studyViewRowDndId,
  studyViewTreeCollision,
} from './studyViewTreeDnd';
import { useStudyViewTreeState } from './useStudyViewTreeState';
import { StudyViewRowMenu } from './StudyViewRowMenu';

const EMPTY_GROUPS: import('../api/studyViews').StudyViewGroup[] = [];
const NO_COLLAPSED_GROUPS = new Set<string>();
const ignoreExpand = () => {};

export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalizeStudyViewQuery(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalizeStudyViewQuery(v).includes(q)));
}

export function formatStudyViewMeta(row: { timeframe: string; range: { from_date: string; to_date: string; from_ms?: number; to_ms?: number } }): string {
  return `${studyTimeframeLabel(row.timeframe)} · ${studyViewPeriod(row.range, row.timeframe)}`;
}

type TreeDragHandle = { listeners: DraggableSyntheticListeners; setActivatorNodeRef: (node: HTMLElement | null) => void };
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
  const [groupMenu, setGroupMenu] = useState<string | null>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(!!groupMenu, groupMenuRef, () => setGroupMenu(null));
  const [moveError, setMoveError] = useState('');
  const reveal = useStudyViewReveal((s) => s.target);
  const savedGroups = data?.groups ?? EMPTY_GROUPS;
  const [rowMenu, setRowMenu] = useState<{ row: StudyViewListRow; left: number; top: number } | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [memoState, setMemoState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const client = useQueryClient();
  const deletionBatches = useStudyViewDeletion((s) => s.batches);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ghost, setGhost] = useState<string | null>(null);
  const [destination, setDestination] = useState<{ id: string; side: DropIndicator; label: string } | null>(null);
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const dragIds = useRef<string[]>([]);
  const [dragHint, setDragHint] = useState('원하는 그룹이나 위치에 놓으세요 · 패널 밖은 취소');
  const renameCommittingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const memoCommittingRef = useRef(false);
  const memoInputRef = useRef<HTMLTextAreaElement>(null);
  const navigateClickTimerRef = useRef<number | null>(null);
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
  const visibleGroups = treeGroups.map((g) => ({ ...g, rows: g.rows.filter((r) => !hiddenIds.has(r.id)) }));
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
  useEffect(() => () => {
    if (navigateClickTimerRef.current === null) return;
    window.clearTimeout(navigateClickTimerRef.current);
    navigateClickTimerRef.current = null;
  }, []);

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

  function cancelPendingStudyViewNavigation() {
    if (navigateClickTimerRef.current === null) return;
    window.clearTimeout(navigateClickTimerRef.current);
    navigateClickTimerRef.current = null;
  }

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
    cancelPendingStudyViewNavigation();
    activateLiveCode(row.code, row.label);
    useLivePageStore.getState().focusSavedRange(savedRangeFocusFromView(row));
    if (location.pathname !== '/live') navigate('/live');
  }

  function scheduleStudyViewNavigation(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    navigateClickTimerRef.current = window.setTimeout(() => {
      navigateClickTimerRef.current = null;
      openSavedRangeInLive(row);
    }, 180);
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
    cancelPendingStudyViewNavigation();
    const removing = new Set(rows.map((r) => r.id));
    if (renameState && removing.has(renameState.id)) cancelRename();
    if (memoState && removing.has(memoState.id)) cancelMemoEdit();
    const focused = document.activeElement?.closest<HTMLElement>('[data-saved-row]');
    if (focused && removing.has(focused.dataset.savedRow ?? '')) {
      const nodes = [...document.querySelectorAll<HTMLElement>('#right-rail-saved-views-panel [data-saved-row]')];
      const at = nodes.indexOf(focused);
      const next = [...nodes.slice(at + 1), ...nodes.slice(0, at).reverse()].find((node) => !removing.has(node.dataset.savedRow ?? ''));
      next?.focus();
      if (!next) document.querySelector<HTMLInputElement>('[aria-label="저장뷰 검색"]')?.focus();
    }
    useStudyViewDeletion.getState().queue(rows, client);
    setSelected(new Set());
  };
  const requestDelete = (row: StudyViewListRow) => requestDeleteRows([row]);
  const selectedRows = allSaves.filter((r) => selected.has(r.id) && !hiddenIds.has(r.id));
  const toggleSelected = (id: string) => setSelected((old) => {
    const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const getDestination = (event: DragMoveEvent | DragEndEvent) => {
    const intent = resolveStudyViewTreeDrag(event);
    if (!intent || !event.over) return null;

    const point = pointRef.current ?? dropPoint(event);
    const side: DropIndicator = point && point.y > event.over.rect.top + event.over.rect.height / 2 ? 'after' : 'before';
    const row = intent.type === 'row' ? allSaves.find((r) => r.id === intent.overId) : null;
    const name = row ? `${row.label} · ${row.name} (${formatStudyViewMeta(row)})` : visibleGroups.find((g) => g.key === (intent.type === 'group' ? intent.overKey : intent.groupKey))?.label;
    return { id: String(event.over.id), side, label: intent.type === 'row' && !intent.overId ? `${name ?? ''} 그룹으로 이동` : `${name ?? ''} ${side === 'after' ? '아래' : '위'}로 이동` };
  };
  const handleDragStart = (event: DragStartEvent) => {
    cancelPendingStudyViewNavigation();
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
        onSuccess: () => { placeRows(intent.groupKey, dragIds.current, intent.overId, next.side); setSelected(new Set()); revealGroup(intent.groupKey); },
        onError: (e) => setMoveError(e instanceof Error ? e.message : '이동에 실패했습니다'),
      });
    }
  };

  const renderStudyViewRow = (row: StudyViewListRow, handle: TreeDragHandle) => {
    const isActive = openStudyViewId === row.id;
    const isEditing = renameState?.id === row.id || memoState?.id === row.id;
    return (
      <RailTreeRow
        key={row.id}
        data-saved-row={row.id}
        title={`${row.label} ${row.code} · ${row.name} · ${formatStudyViewMeta(row)}`}
        className="group"
        role={isEditing ? undefined : 'button'}
        tabIndex={isEditing ? undefined : 0}
        aria-label={isEditing ? undefined : `${row.name} 저장뷰 열기`}
        aria-current={isActive ? 'true' : undefined}
        style={{
          background: isActive ? 'var(--tint-selection)' : 'transparent',
        }}
        // Ctrl/⌘+클릭 = **브라우저** 새 탭. ADR-0149 가 없앤 것은 앱 안의 저장뷰 탭이고
        // (그 disposition 은 되살리지 않는다), 여기서 타는 것은 같은 ADR §7 이 정식 경로로
        // 못박은 `?view=` 딥링크다 — 새 상태가 0이라 결정과 충돌하지 않는다.
        //
        // 지연 스케줄(180ms — 이름 변경 더블클릭과의 모호성 해소)을 **거치지 않는다**:
        // 수정자 클릭에는 그 모호성이 없고, 사용자 제스처 핸들러 안에서 동기로 열어야
        // 팝업 차단에 걸리지 않는다. **이 탭은 아무것도 바뀌지 않는 것이 계약**이라
        // `openSavedRangeInLive`(종목 활성화 + 기간 슬롯)를 부르지 않는다 — 새 탭이
        // URL 로 자기 상태를 세운다.
        onClick={isEditing ? undefined : (e) => {
          if (wantsNewTab(e)) {
            cancelPendingStudyViewNavigation();
            openSavedViewInNewTab(row.id);
            return;
          }
          scheduleStudyViewNavigation(row);
        }}
        onContextMenu={isEditing ? undefined : (e) => {
          e.preventDefault();
          setRowMenu({ row, left: e.clientX, top: e.clientY });
        }}
        onKeyDown={isEditing ? undefined : (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Delete') {
            e.preventDefault();
            requestDeleteRows(selected.has(row.id) ? selectedRows : [row]);
            return;
          }
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openSavedRangeInLive(row);
        }}
      >
        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {selecting && <input type="checkbox" aria-label={`${row.name} 선택`} checked={selected.has(row.id)} onChange={() => toggleSelected(row.id)} />}
          <button type="button" aria-label={`${row.name} 순서 이동`} disabled={!canDrag}
            ref={handle.setActivatorNodeRef} {...handle.listeners}
            className="grid place-items-center h-5 w-4 shrink-0 cursor-grab touch-none text-fg-dimmer opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30"><GripIcon /></button>
        </span>
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
          <div className="flex min-w-0 flex-1 items-center gap-2 leading-tight">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-border bg-bg" aria-hidden />
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-xs text-fg"
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelPendingStudyViewNavigation();
                  startRename(row);
                }}
              >
                {row.label || row.code} · {row.name}
              </div>
              {/* 메타행 — 저장뷰 이름만으론 "무엇을 저장했나"를 알 수 없던 것 보완:
                  타임프레임 · 복기 대상일(종목은 위 이름행에 표시). */}
              <div className="text-xs text-fg-dim font-data break-words">
                {formatStudyViewMeta(row)}
              </div>
              {/* 메모 미리보기(첫 줄) — 검색만 되고 화면엔 없던 복기 노트를 목록에서
                  바로 훑을 수 있게 한다. 메타보다 한 단계 밝은 fg-dim 으로 구분. */}
              {row.memo && (
                <div className="truncate text-badge text-fg-dim">{row.memo.split('\n', 1)[0]}</div>
              )}
            </div>
            {/* 메뉴는 항상 클릭 가능하게 두어 키보드와 포인터로 그룹 이동에 접근한다. */}
            <button
              type="button"
              aria-label={`${row.name} 행 메뉴`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                cancelPendingStudyViewNavigation();
                setRowMenu({ row, left: e.clientX, top: e.clientY });
              }}
              className="shrink-0 grid h-6 w-6 place-items-center rounded text-fg-dimmer hover:text-fg opacity-60 hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreIcon />
            </button>
          </div>
        )}
      </RailTreeRow>
    );
  };

  return (
    <RailDrawer id="right-rail-saved-views-panel" ariaLabel="저장뷰">
      <RailDrawerHeader
        title="저장뷰"
        actions={<button type="button" className="h-7 rounded px-2 text-xs text-accent" onClick={() => setGroupAction({ type: 'create' })}>+ 그룹</button>}
      />
      <RailDrawerSection className="p-3">
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
                  title="검색어 지우기"
                  onClick={() => setQuery('')}
                  className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-fg-dim hover:bg-bg-input-hover hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  <ClearSearchIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <RailToolbarIconButton className="shrink-0" onClick={toggleVisibleGroups} disabled={searching || visibleGroups.length === 0}
              aria-label={visibleGroupsCollapsed ? '전체 펼치기' : '전체 접기'}
              title={searching ? '검색 해제 후 전체 접기 사용' : visibleGroupsCollapsed ? '전체 펼치기' : '전체 접기'}>
              {visibleGroupsCollapsed ? <ExpandAllIcon className="h-4 w-4" /> : <CollapseAllIcon className="h-4 w-4" />}
            </RailToolbarIconButton>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <RailSelectionControl active={selecting} count={selectedRows.length}
              onToggle={() => { setSelecting(!selecting); setSelected(new Set()); }} />
            {selecting && <button type="button" disabled={!selectedRows.length} className="h-7 rounded px-2 text-xs text-accent disabled:opacity-40" onClick={() => setGroupAction({ type: 'move', ids: selectedRows.map((r) => r.id) })}>그룹 이동</button>}
            {selecting && <button type="button" disabled={!selectedRows.length} className="h-7 rounded px-2 text-xs text-error disabled:opacity-40"
              onClick={() => requestDeleteRows(selectedRows)}>선택 삭제</button>}
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
            <SortableContext items={visibleGroups.map((group) => studyViewGroupDndId(group.key))} strategy={verticalListSortingStrategy}>
              {visibleGroups.map((group) => {
                const groupCollapsed = isCollapsed(group.key);
                return (
                  <SortableStudyViewGroup key={group.key} id={group.key} disabled={!canDrag} indicator={destination?.id === studyViewGroupDndId(group.key) ? destination.side : undefined}>
                    {(groupHandle) => (
                      <section aria-label={`${group.label} 저장뷰`}>
                        <div className="group sticky top-0 z-10 flex items-center bg-bg">
                          <button type="button" aria-label={`${group.label} 그룹 이동`} disabled={!canDrag}
                            ref={groupHandle.setActivatorNodeRef} {...groupHandle.listeners}
                            className="ml-2 grid place-items-center h-5 w-4 shrink-0 cursor-grab touch-none text-fg-dimmer opacity-0 group-hover:opacity-100 focus:opacity-100 disabled:opacity-30"><GripIcon /></button>
                        <RailGroupHeader
                          type="button"
                          aria-label={`${group.label} ${groupCollapsed ? '펼치기' : '접기'}`}
                          aria-expanded={!groupCollapsed}
                          title={`${group.label}`}
                          // Ctrl/⌘+클릭 = 그 종목의 최신 저장뷰를 앱 탭으로 열던 분기는
                          // ADR-0149 로 사라졌다. 헤더 클릭은 이제 접기/펼치기 하나다.
                          // 행에 생긴 브라우저 새 탭(ctrl/⌘+클릭)을 여기까지 넓히지 않은 것은
                          // 의도다 — 헤더의 클릭 하나는 접기이고, 어느 뷰를 열지는 헤더가
                          // 아니라 행이 정한다.
                          onClick={() => {
                            toggleGroup(group.key);
                          }}
                          className="flex-1 min-w-0"
                          disabled={searching}
                          leading={<span className="text-fg-dimmer"><ChevronIcon collapsed={groupCollapsed} /></span>}
                          count={group.rows.length}
                        >
                          {group.label}
                        </RailGroupHeader>
                        {searching && <span className="text-xs text-fg-dim">전체 {allSaves.filter((r) => r.group_id === group.key).length}</span>}
                        <div className="relative" ref={groupMenu === group.key ? groupMenuRef : undefined}>
                          <button type="button" aria-label={`${group.label} 그룹 메뉴`} aria-haspopup="menu" className="h-7 w-7 text-fg-dim" onClick={() => setGroupMenu(groupMenu === group.key ? null : group.key)}><MoreIcon /></button>
                          {groupMenu === group.key && <div role="menu" className="absolute right-0 z-30 w-32 rounded border bg-bg-card p-1 shadow-lg">
                            {(['rename', 'delete'] as const).map((type) => <button type="button" role="menuitem" key={type} className="block w-full px-2 py-1 text-left text-xs hover:bg-bg-input-hover" onClick={() => {
                              const found = savedGroups.find((g) => g.id === group.key);
                              const rows = allSaves.filter((r) => r.group_id === group.key);
                              if (found) {
                                if (type === 'delete' && rows.length === 0) mutations.deleteGroup.mutate(found.id, { onError: (e) => setMoveError(e.message) });
                                else setGroupAction({ type, group: found, count: rows.length, ids: rows.map((r) => r.id) });
                              }
                              setGroupMenu(null);
                            }}>{type === 'rename' ? '이름 변경' : '그룹 삭제'}</button>)}
                          </div>}
                        </div>
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
            <RailDragOverlay droppedOnChart fitContentHeight>
              {ghost && <li data-testid="saved-view-drag-ghost" className="px-md py-1 text-sm font-semibold text-accent">⠿ {ghost} 이동</li>}
            </RailDragOverlay>
          </DndContext>
        </RailDrawerBody>
      <div role="status" aria-label="저장뷰 순서 안내" className="flex min-h-12 shrink-0 items-center gap-2 border-t border-border px-md py-1 text-xs text-fg-dim">
        <span className="line-clamp-3 flex-1">{ghost ? destination?.label ?? dragHint : !dragEnabled
          ? searching ? '검색 중에는 순서를 변경할 수 없습니다' : '이름 정렬 중에는 순서를 변경할 수 없습니다'
          : orderMessage || '핸들로 순서 이동 · Delete 삭제 · 순서는 이 브라우저에 저장'}</span>
        {!ghost && canUndoOrder && <button type="button" className="shrink-0 text-accent" onClick={undoReorder}>순서 되돌리기</button>}
        {!ghost && !dragEnabled && !searching && <button type="button" className="shrink-0 text-accent" onClick={useManualSort}>수동 정렬</button>}
      </div>
      {moveError && <p role="alert" className="p-3 text-xs text-error">{moveError}</p>}
      {groupAction && <StudyGroupDialog action={groupAction} groups={savedGroups} onClose={() => { setGroupAction(null); setSelected(new Set()); }} />}
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

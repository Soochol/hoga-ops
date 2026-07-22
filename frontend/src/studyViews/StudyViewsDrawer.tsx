import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { StudyViewListRow } from '../api/studyViews';
import { dropPoint, isPointOnStudy, useEntryDragStore } from '../state/entryDrag';
import { useStudyTabsStore } from '../state/studyTabs';
import { useStudyViewOpenPrefsStore } from '../state/studyViewOpenPrefs';
import { latestStudyViewForCode } from './studyViewSelection';
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

/** 삭제 유예(ms) — 이 시간 안에 "실행 취소"를 누르면 서버 DELETE 자체가 나가지 않는다. */
const DELETE_UNDO_MS = 5000;

export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalizeStudyViewQuery(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalizeStudyViewQuery(v).includes(q)));
}

/** YYYYMMDD → "MM-DD" (같은 연도 가정, 저장뷰 메타의 좁은 폭에 맞춘 축약). */
function shortMonthDay(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  return `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 저장뷰 아이템 메타 = 타임프레임 · 복기 대상일(범위면 from~to). 종목은 그룹
 *  헤더가 이미 이므로 생략 — 아이템엔 "무엇을 저장했나"(분봉·날짜)만 남긴다. */
export function formatStudyViewMeta(row: { timeframe: string; range: { from_date: string; to_date: string } }): string {
  const { from_date, to_date } = row.range;
  const date = from_date === to_date ? shortMonthDay(from_date) : `${shortMonthDay(from_date)}~${shortMonthDay(to_date)}`;
  return `${row.timeframe} · ${date}`;
}

function ClearSearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function SortableStudyViewGroup({
  id,
  code,
  disabled,
  children,
}: {
  id: string;
  code: string;
  disabled: boolean;
  children: (listeners: DraggableSyntheticListeners | undefined) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: studyViewGroupDndId(id),
    disabled,
    data: { type: 'group', code },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.65, position: 'relative', zIndex: 20 } : {}),
      }}
    >
      {children(listeners)}
    </div>
  );
}

function SortableStudyViewRow({
  row,
  groupKey,
  disabled,
  children,
}: {
  row: StudyViewListRow;
  groupKey: string;
  disabled: boolean;
  children: ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: studyViewRowDndId(row.id),
    disabled,
    data: { type: 'row', groupKey },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(isDragging ? { opacity: 0.65, position: 'relative', zIndex: 10 } : {}),
      }}
    >
      {children}
    </div>
  );
}

export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const mutations = useStudyViewMutations();
  const [rowMenu, setRowMenu] = useState<{ row: StudyViewListRow; left: number; top: number } | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [memoState, setMemoState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StudyViewListRow | null>(null);
  const renameCommittingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const memoCommittingRef = useRef(false);
  const memoInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingDeleteTimerRef = useRef<number | null>(null);
  const navigateClickTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // 삭제 유예 중인 행은 트리·그룹 최신뷰 계산 모두에서 즉시 사라져야 하므로
  // 소스 배열 단계에서 걸러낸다(실행 취소 시 원배열 복귀 = 상태 복원).
  const allSaves = data?.saves ?? [];
  const saves = pendingDelete ? allSaves.filter((row) => row.id !== pendingDelete.id) : allSaves;
  const {
    query,
    setQuery,
    sortAction,
    cycleSortMode,
    dragEnabled,
    visibleGroups,
    visibleGroupsCollapsed,
    isCollapsed,
    toggleGroup,
    toggleVisibleGroups,
    reorderGroup,
    reorderRow,
  } = useStudyViewTreeState(saves);
  const currentStudyViewId = useMemo(() => new URLSearchParams(location.search).get('view'), [location.search]);
  const activeStudyViewId = useStudyTabsStore((state) => (
    state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId ?? null
  ));
  const selectedStudyViewId = activeStudyViewId ?? currentStudyViewId;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const startEntryDrag = useEntryDragStore((s) => s.startDrag);
  const setOverStudy = useEntryDragStore((s) => s.setOverStudy);
  const endEntryDrag = useEntryDragStore((s) => s.endDrag);
  const defaultOpenTimeframe = useStudyViewOpenPrefsStore((s) => s.defaultTimeframe);

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

  function navigateToStudyView(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    navigate(`/study?view=${row.id}`);
  }

  function openSaveInActiveTab(row: StudyViewListRow) {
    useStudyTabsStore.getState().openSaveInActiveTab(
      row,
      defaultOpenTimeframe === 'saved' ? undefined : { timeframeOverride: defaultOpenTimeframe },
    );
  }

  function openSaveInNewTab(row: StudyViewListRow) {
    useStudyTabsStore.getState().openSaveInNewTab(
      row,
      defaultOpenTimeframe === 'saved' ? undefined : { timeframeOverride: defaultOpenTimeframe },
    );
  }

  function openStudyViewInActiveTab(row: StudyViewListRow) {
    openSaveInActiveTab(row);
    navigateToStudyView(row);
  }

  function openStudyViewInNewTab(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    openSaveInNewTab(row);
    navigate(`/study?view=${row.id}`);
  }

  function scheduleStudyViewNavigation(row: StudyViewListRow) {
    cancelPendingStudyViewNavigation();
    navigateClickTimerRef.current = window.setTimeout(() => {
      navigateClickTimerRef.current = null;
      openStudyViewInActiveTab(row);
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
            ? { ...current, error: error instanceof Error ? error.message : '이름 변경에 실패했습니다.' }
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
            ? { ...current, error: error instanceof Error ? error.message : '메모 저장에 실패했습니다.' }
            : current);
        },
      },
    );
  };

  const executeDelete = (row: StudyViewListRow) => {
    const deletedId = row.id;
    mutations.remove.mutate(deletedId, {
      onSuccess: () => {
        const nextActiveTab = useStudyTabsStore.getState().closeTabsByViewId(deletedId);
        if (location.pathname === '/study' && currentStudyViewId === deletedId) {
          navigate(nextActiveTab ? `/study?view=${nextActiveTab.viewId}` : '/study');
        }
      },
    });
  };

  // 언마운트(패널 전환) 시점의 flush 가 stale location/mutation 을 잡지 않도록
  // 최신 클로저를 ref 로 유지한다.
  const executeDeleteRef = useRef(executeDelete);
  useEffect(() => { executeDeleteRef.current = executeDelete; });
  const pendingDeleteRef = useRef<StudyViewListRow | null>(null);
  useEffect(() => { pendingDeleteRef.current = pendingDelete; }, [pendingDelete]);

  /** 유예 삭제 — 행은 즉시 사라지고, DELETE 는 유예 후에만 나간다. 유예 중 다른
   *  삭제가 오면 앞선 것은 그 자리에서 확정한다(단일 실행취소 슬롯). */
  const requestDelete = (row: StudyViewListRow) => {
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
      if (pendingDeleteRef.current) executeDeleteRef.current(pendingDeleteRef.current);
    }
    setPendingDelete(row);
    pendingDeleteTimerRef.current = window.setTimeout(() => {
      pendingDeleteTimerRef.current = null;
      setPendingDelete(null);
      executeDeleteRef.current(row);
    }, DELETE_UNDO_MS);
  };

  const undoDelete = () => {
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
    setPendingDelete(null);
  };

  // 유예가 남은 채로 패널이 닫히면 삭제 의사는 이미 확정된 것 — 즉시 flush.
  useEffect(() => () => {
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
    if (pendingDeleteRef.current) executeDeleteRef.current(pendingDeleteRef.current);
  }, []);

  const handleDragStart = (event: DragStartEvent) => {
    if (event.active.data.current?.type !== 'group') return;
    const draggedGroup = event.active.data.current as { code?: string };
    if (draggedGroup.code) startEntryDrag(draggedGroup.code);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    if (event.active.data.current?.type !== 'group') return;
    setOverStudy(isPointOnStudy(dropPoint(event)));
  };

  const handleDragCancel = () => {
    endEntryDrag();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const wasGroupDrag = event.active.data.current?.type === 'group';
    endEntryDrag();
    if (event.active.data.current?.type === 'group' && isPointOnStudy(dropPoint(event))) {
      const draggedGroup = visibleGroups.find((group) => studyViewGroupDndId(group.key) === String(event.active.id));
      const save = draggedGroup ? latestStudyViewForCode(saves, draggedGroup.code) : null;
      if (save) openStudyViewInActiveTab(save);
      return;
    }

    if (wasGroupDrag && !event.over) return;
    const intent = resolveStudyViewTreeDrag(event);
    if (!intent) return;
    if (intent.type === 'group') {
      reorderGroup(intent.activeKey, intent.overKey);
      return;
    }
    reorderRow(intent.groupKey, intent.activeId, intent.overId);
  };

  const renderStudyViewRow = (row: StudyViewListRow) => {
    const isActive = selectedStudyViewId === row.id;
    const isEditing = renameState?.id === row.id || memoState?.id === row.id;
    return (
      <RailTreeRow
        key={row.id}
        className="group"
        role={isEditing ? undefined : 'button'}
        tabIndex={isEditing ? undefined : 0}
        aria-label={isEditing ? undefined : `${row.name} 저장뷰 열기`}
        aria-current={isActive ? 'true' : undefined}
        style={{
          background: isActive ? 'var(--tint-selection)' : 'transparent',
          borderLeft: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
        }}
        onClick={isEditing ? undefined : (event) => {
          if (event.ctrlKey || event.metaKey) {
            openStudyViewInNewTab(row);
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
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openStudyViewInActiveTab(row);
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
                {row.name}
              </div>
              {/* 메타행 — 저장뷰 이름만으론 "무엇을 저장했나"를 알 수 없던 것 보완:
                  타임프레임 · 복기 대상일(종목은 그룹 헤더가 이미 표시). */}
              <div className="truncate text-badge text-fg-dimmer tabular-nums">
                {formatStudyViewMeta(row)}
              </div>
              {/* 메모 미리보기(첫 줄) — 검색만 되고 화면엔 없던 복기 노트를 목록에서
                  바로 훑을 수 있게 한다. 메타보다 한 단계 밝은 fg-dim 으로 구분. */}
              {row.memo && (
                <div className="truncate text-badge text-fg-dim">{row.memo.split('\n', 1)[0]}</div>
              )}
            </div>
            {/* 행 메뉴 ⋯ — 평시 opacity-0 + pointer-events-none 이라 클릭이 행(열기)으로
                통과하고, 호버/포커스 시에만 보이며 클릭 가능(관심종목 RowTrailing 과 동일
                계약). opacity(=DOM 유지)라 Tab 포커스가 닿는다. */}
            <button
              type="button"
              aria-label={`${row.name} 행 메뉴`}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                cancelPendingStudyViewNavigation();
                setRowMenu({ row, left: e.clientX, top: e.clientY });
              }}
              className="shrink-0 grid place-items-center px-1 leading-none text-fg-dimmer hover:text-fg opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
            >
              ⋯
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
      />
      <RailDrawerSection className="p-3">
          <div className="flex items-center gap-1">
            <div className="relative min-w-0 flex-1">
              <input
                aria-label="저장뷰 검색"
                placeholder="검색하세요"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
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
            {visibleGroups.length > 0 && (
              <div className="flex shrink-0 gap-1">
                <RailToolbarIconButton
                  type="button"
                  onClick={toggleVisibleGroups}
                  aria-label={visibleGroupsCollapsed ? '전체 펼치기' : '전체 접기'}
                  title={visibleGroupsCollapsed ? '전체 펼치기' : '전체 접기'}
                >
                  {visibleGroupsCollapsed
                    ? <ExpandAllIcon className="h-4 w-4" />
                    : <CollapseAllIcon className="h-4 w-4" />}
                </RailToolbarIconButton>
                <SortCycleButton
                  onClick={cycleSortMode}
                  direction={sortAction.direction === 'default' ? 'none' : sortAction.direction}
                  label={sortAction.label}
                />
              </div>
            )}
          </div>
      </RailDrawerSection>
        {isLoading && <RailState>불러오는 중</RailState>}
        {isError && (
          <RailState tone="error">
            <p>저장뷰를 불러오지 못했습니다.</p>
            <button type="button" onClick={() => refetch()} className="mt-2 underline">다시 시도</button>
          </RailState>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) === 0 && (
          <RailState>저장된 뷰가 없습니다.</RailState>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) > 0 && visibleGroups.length === 0 && (
          <RailState>검색 결과가 없습니다.</RailState>
        )}
        <RailDrawerBody>
          <DndContext
            sensors={sensors}
            collisionDetection={studyViewTreeCollision}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={visibleGroups.map((group) => studyViewGroupDndId(group.key))} strategy={verticalListSortingStrategy}>
              {visibleGroups.map((group) => {
                const groupCollapsed = isCollapsed(group.key);
                return (
                  <SortableStudyViewGroup key={group.key} id={group.key} code={group.code} disabled={!dragEnabled}>
                    {(groupDragListeners) => (
                      <section aria-label={`${group.label} ${group.code} 저장뷰`}>
                        <RailGroupHeader
                          type="button"
                          {...(groupDragListeners ?? {})}
                          aria-label={`${group.label} ${group.code} ${groupCollapsed ? '펼치기' : '접기'}`}
                          aria-expanded={!groupCollapsed}
                          title={`${group.label} ${group.code}`}
                          onClick={(event) => {
                            if (event.ctrlKey || event.metaKey) {
                              event.preventDefault();
                              const save = latestStudyViewForCode(saves, group.code);
                              if (save) openStudyViewInNewTab(save);
                              return;
                            }
                            toggleGroup(group.key);
                          }}
                          className={dragEnabled ? 'cursor-grab active:cursor-grabbing' : ''}
                          leading={<span className="w-3 text-xs" aria-hidden>{groupCollapsed ? '▶' : '▼'}</span>}
                          count={group.rows.length}
                        >
                          {group.label}
                        </RailGroupHeader>
                        {!groupCollapsed && (
                          <SortableContext items={group.rows.map((row) => studyViewRowDndId(row.id))} strategy={verticalListSortingStrategy}>
                            {group.rows.map((row) => (
                              <SortableStudyViewRow key={row.id} row={row} groupKey={group.key} disabled={!dragEnabled}>
                                {renderStudyViewRow(row)}
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
          </DndContext>
        </RailDrawerBody>
      {/* 삭제 유예 토스트 — 패널 하단 고정 슬롯. 유예 중에만 존재하며 "실행 취소"가
          유일한 액션(확인 다이얼로그 대신 사후 복구를 택해 정상 삭제 흐름은 무마찰). */}
      {pendingDelete && (
        <div role="status" className="flex items-center gap-2 border-t border-border bg-bg-subtle px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg-dim">‘{pendingDelete.name}’ 삭제됨</span>
          <button
            type="button"
            onClick={undoDelete}
            className="shrink-0 font-medium text-accent hover:underline"
          >
            실행 취소
          </button>
        </div>
      )}
      {rowMenu && (
        <StudyViewRowMenu
          x={rowMenu.left}
          y={rowMenu.top}
          name={rowMenu.row.name}
          onOpen={() => openStudyViewInActiveTab(rowMenu.row)}
          onOpenNewTab={() => openStudyViewInNewTab(rowMenu.row)}
          onRename={() => startRename(rowMenu.row)}
          onEditMemo={() => startMemoEdit(rowMenu.row)}
          onDelete={() => requestDelete(rowMenu.row)}
          onClose={() => setRowMenu(null)}
        />
      )}
    </RailDrawer>
  );
}

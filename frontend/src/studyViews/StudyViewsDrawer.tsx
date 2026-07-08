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
import { SortCycleButton } from '../ui/SortCycleButton';
import { normalizeStudyViewQuery } from './studyViewTree';
import {
  resolveStudyViewTreeDrag,
  studyViewGroupDndId,
  studyViewRowDndId,
  studyViewTreeCollision,
} from './studyViewTreeDnd';
import { useStudyViewTreeState } from './useStudyViewTreeState';

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

function CollapseAllIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 8h10" />
      <path d="M9 4h6" />
      <path d="M9 12h6" />
      <path d="m8 17 4-4 4 4" />
      <path d="m8 20 4-4 4 4" />
    </svg>
  );
}

function ExpandAllIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 8h10" />
      <path d="M9 4h6" />
      <path d="M9 20h6" />
      <path d="m8 13 4 4 4-4" />
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
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
  const renameCommittingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const navigateClickTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
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
  } = useStudyViewTreeState(data?.saves ?? []);
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
    if (!rowMenu) return;

    const close = () => setRowMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [rowMenu]);

  const startRename = (row: StudyViewListRow) => {
    setRenameState({ id: row.id, value: row.name, error: null });
  };

  const cancelRename = () => {
    renameCommittingRef.current = false;
    setRenameState(null);
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

  const deleteSave = (row: StudyViewListRow) => {
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
      const save = draggedGroup ? latestStudyViewForCode(data?.saves ?? [], draggedGroup.code) : null;
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
    return (
      <RailTreeRow
        key={row.id}
        role={renameState?.id === row.id ? undefined : 'button'}
        tabIndex={renameState?.id === row.id ? undefined : 0}
        aria-label={renameState?.id === row.id ? undefined : `${row.name} 저장뷰 열기`}
        aria-current={isActive ? 'true' : undefined}
        style={{
          background: isActive ? 'var(--tint-selection)' : 'transparent',
          borderLeft: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
        }}
        onClick={renameState?.id === row.id ? undefined : (event) => {
          if (event.ctrlKey || event.metaKey) {
            openStudyViewInNewTab(row);
            return;
          }
          scheduleStudyViewNavigation(row);
        }}
        onContextMenu={renameState?.id === row.id ? undefined : (e) => {
          e.preventDefault();
          setRowMenu({ row, left: e.clientX, top: e.clientY });
        }}
        onKeyDown={renameState?.id === row.id ? undefined : (e) => {
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
              className="w-full rounded border border-line bg-bg-input px-1 py-0.5 text-xs text-fg"
            />
            {renameState.error && <div className="text-xs text-danger">{renameState.error}</div>}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 leading-tight">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-line bg-bg" aria-hidden />
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
            </div>
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
                              const save = latestStudyViewForCode(data?.saves ?? [], group.code);
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
      {rowMenu && (
        <div
          role="menu"
          aria-label={`${rowMenu.row.name} 저장뷰 메뉴`}
          className="fixed z-50 min-w-[96px] rounded border border-line bg-bg shadow-lg"
          style={{ left: rowMenu.left, top: rowMenu.top }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              deleteSave(rowMenu.row);
              setRowMenu(null);
            }}
            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-bg-input"
          >
            삭제
          </button>
        </div>
      )}
    </RailDrawer>
  );
}

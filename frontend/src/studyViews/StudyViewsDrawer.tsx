import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ParquetStudyView, ParquetStudyViewWriteRequest } from '../api/studyViews';
import { useCurrentStudySaveSource } from './studySaveSource';
import { studySnapshotByteSize } from './studySaveRequest';
import { makeStudySaveCommand } from './studySaveCommand';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import {
  normalizeStudyViewQuery,
  type StudyViewTreeSortDirection,
} from './studyViewTree';
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

type SaveDialogState = {
  mode: 'create' | 'overwrite';
  id?: string;
  request: ParquetStudyViewWriteRequest;
  defaultName: string;
  defaultMemo: string;
};

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

function NameSortIcon({ direction, className }: { direction: StudyViewTreeSortDirection; className?: string }) {
  return (
    <svg
      className={className}
      data-sort-icon={direction}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7h7" />
      <path d="M5 12h10" />
      <path d="M5 17h5" />
      {direction === 'default' ? (
        <>
          <path d="M16 8h4" />
          <path d="M16 12h4" />
          <path d="M16 16h4" />
        </>
      ) : (
        <>
          <path d="M18 6v12" />
          <path d={direction === 'desc' ? 'm15 15 3 3 3-3' : 'm15 9 3-3 3 3'} />
        </>
      )}
    </svg>
  );
}

function treeToolbarButtonClass(active = false): string {
  return [
    'grid h-7 w-7 place-items-center rounded border text-fg-dim transition-colors',
    active ? 'border-line-strong bg-bg-input text-fg' : 'border-line hover:bg-bg-input hover:text-fg',
  ].join(' ');
}

function SortableStudyViewGroup({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (listeners: DraggableSyntheticListeners | undefined) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: studyViewGroupDndId(id),
    disabled,
    data: { type: 'group' },
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
  row: ParquetStudyView;
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
  const saveSource = useCurrentStudySaveSource();
  const [dialog, setDialog] = useState<SaveDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParquetStudyView | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const renameCommittingRef = useRef(false);
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const {
    query,
    setQuery,
    sortAction,
    cycleSortMode,
    dragEnabled,
    visibleGroups,
    isCollapsed,
    toggleGroup,
    collapseVisibleGroups,
    expandVisibleGroups,
    reorderGroup,
    reorderRow,
  } = useStudyViewTreeState(data?.saves ?? []);
  const currentStudyViewId = useMemo(() => new URLSearchParams(location.search).get('view'), [location.search]);
  const currentStudyRow = useMemo(
    () => data?.saves.find((row) => row.id === currentStudyViewId),
    [currentStudyViewId, data?.saves],
  );
  const dialogMutation = dialog?.mode === 'overwrite' ? mutations.update : mutations.create;
  const dialogError = dialogMutation?.error instanceof Error ? dialogMutation.error.message : null;
  const studySource = saveSource?.origin === 'study' ? saveSource : null;
  const overwriteStudyViewId = location.pathname === '/study' ? studySource?.viewId ?? currentStudyViewId ?? undefined : undefined;
  const canSaveStudy = location.pathname === '/study' && !!studySource;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    if (!deleteTarget) return;
    deleteConfirmButtonRef.current?.focus();
  }, [deleteTarget]);

  const openSaveDialog = (mode: 'create' | 'overwrite', id?: string) => {
    if (!studySource) return;
    const row = id ? data?.saves.find((save) => save.id === id) : currentStudyRow;
    const command = makeStudySaveCommand({ mode, source: studySource, existingSave: row });
    if (command) {
      setDialog({
        mode: command.mode,
        id: id ?? command.id,
        request: command.request,
        defaultName: command.defaultName,
        defaultMemo: command.defaultMemo,
      });
    }
  };

  const handleDialogSubmit = ({ name, memo }: { name: string; memo: string }) => {
    if (!dialog) return;
    const body = { ...dialog.request, name, memo };
    if (dialog.mode === 'overwrite' && dialog.id) {
      mutations.update.mutate({ id: dialog.id, body }, { onSuccess: () => setDialog(null) });
      return;
    }
    mutations.create.mutate(body, {
      onSuccess: (created) => {
        setDialog(null);
        if (location.pathname === '/study') navigate(`/study?view=${created.id}`);
      },
    });
  };

  const startRename = (row: ParquetStudyView) => {
    setRenameState({ id: row.id, value: row.name, error: null });
  };

  const navigateToStudyView = (row: ParquetStudyView) => {
    navigate(`/study?view=${row.id}`);
  };

  const cancelRename = () => {
    renameCommittingRef.current = false;
    setRenameState(null);
  };

  const commitRename = (row: ParquetStudyView) => {
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

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const deletedId = deleteTarget.id;
    mutations.remove.mutate(deletedId, {
      onSuccess: () => {
        setDeleteTarget(null);
        setDialog(null);
        if (location.pathname === '/study' && (currentStudyViewId === deletedId || studySource?.viewId === deletedId)) {
          navigate('/study');
        }
      },
    });
  };

  const handleDragEnd = (event: Parameters<typeof resolveStudyViewTreeDrag>[0]) => {
    const intent = resolveStudyViewTreeDrag(event);
    if (!intent) return;
    if (intent.type === 'group') {
      reorderGroup(intent.activeKey, intent.overKey);
      return;
    }
    reorderRow(intent.groupKey, intent.activeId, intent.overId);
  };

  const renderStudyViewRow = (row: ParquetStudyView) => (
    <div
      key={row.id}
      role={renameState?.id === row.id ? undefined : 'button'}
      tabIndex={renameState?.id === row.id ? undefined : 0}
      aria-label={renameState?.id === row.id ? undefined : `${row.name} 저장뷰 열기`}
      onClick={renameState?.id === row.id ? undefined : () => navigateToStudyView(row)}
      onKeyDown={renameState?.id === row.id ? undefined : (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        navigateToStudyView(row);
      }}
      className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 pl-7 hover:bg-bg-input-hover focus:outline-none focus:ring-1 focus:ring-inset focus:ring-line"
    >
      {renameState?.id === row.id ? (
        <div className="min-w-0 flex-1 space-y-1">
          <input
            aria-label="저장뷰 이름 수정"
            autoFocus
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
            className="w-full rounded border border-line bg-bg-input px-1 py-0.5 text-sm font-medium text-fg"
          />
          {renameState.error && <div className="text-xs text-danger">{renameState.error}</div>}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">
              {row.name}
            </div>
          </div>
          <button
            type="button"
            aria-label={`${row.name} 이름 수정`}
            onClick={(e) => {
              e.stopPropagation();
              startRename(row);
            }}
            className="shrink-0 rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-bg-input"
          >
            수정
          </button>
        </div>
      )}
      <button
        type="button"
        aria-label={`${row.name} 삭제`}
        onClick={(e) => {
          e.stopPropagation();
          setDeleteTarget(row);
        }}
        className="shrink-0 rounded border border-line px-2 py-1 text-xs"
      >
        삭제
      </button>
    </div>
  );

  return (
    <aside id="right-rail-saved-views-panel" className="h-full min-w-0 overflow-hidden border-l bg-bg">
      <div className="h-full flex flex-col">
        <header className="px-3 py-2 border-b flex items-center justify-between">
          <h2 className="text-sm font-semibold">저장 뷰</h2>
          {location.pathname === '/study' && (
            <button
              type="button"
              disabled={!canSaveStudy}
              onClick={() => overwriteStudyViewId
                ? openSaveDialog('overwrite', overwriteStudyViewId)
                : openSaveDialog('create')}
              className="text-xs px-2 py-1 border rounded disabled:opacity-50"
            >
              {overwriteStudyViewId ? '덮어쓰기' : '현재 뷰 저장'}
            </button>
          )}
        </header>
        <div className="p-3 border-b">
          <div className="flex items-center gap-1">
            <input
              aria-label="저장 뷰 검색"
              placeholder="검색하세요"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-w-0 flex-1 bg-bg-input border rounded px-2 py-1 text-sm"
            />
            {visibleGroups.length > 0 && (
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={collapseVisibleGroups}
                  aria-label="전체 접기"
                  title="전체 접기"
                  className={treeToolbarButtonClass()}
                >
                  <CollapseAllIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={expandVisibleGroups}
                  aria-label="전체 펼치기"
                  title="전체 펼치기"
                  className={treeToolbarButtonClass()}
                >
                  <ExpandAllIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={cycleSortMode}
                  aria-label={sortAction.label}
                  aria-pressed={sortAction.pressed}
                  title={sortAction.label}
                  className={treeToolbarButtonClass(sortAction.pressed)}
                >
                  <NameSortIcon direction={sortAction.direction} className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          {location.pathname === '/study' && !studySource && <p className="mt-2 text-xs text-fg-dim">학습뷰를 불러온 뒤 저장할 수 있습니다.</p>}
        </div>
        {isLoading && <div className="p-3 text-sm text-fg-dim">불러오는 중</div>}
        {isError && (
          <div className="p-3 text-sm">
            <p>저장 뷰를 불러오지 못했습니다.</p>
            <button type="button" onClick={() => refetch()} className="mt-2 underline">다시 시도</button>
          </div>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) === 0 && (
          <div className="p-3 text-sm text-fg-dim">저장된 뷰가 없습니다.</div>
        )}
        {!isLoading && !isError && (data?.saves.length ?? 0) > 0 && visibleGroups.length === 0 && (
          <div className="p-3 text-sm text-fg-dim">검색 결과가 없습니다.</div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <DndContext sensors={sensors} collisionDetection={studyViewTreeCollision} onDragEnd={handleDragEnd}>
            <SortableContext items={visibleGroups.map((group) => studyViewGroupDndId(group.key))} strategy={verticalListSortingStrategy}>
              {visibleGroups.map((group) => {
                const groupCollapsed = isCollapsed(group.key);
                return (
                  <SortableStudyViewGroup key={group.key} id={group.key} disabled={!dragEnabled}>
                    {(groupDragListeners) => (
                      <section aria-label={`${group.label} ${group.code} 저장뷰`}>
                        <button
                          type="button"
                          {...(groupDragListeners ?? {})}
                          aria-label={`${group.label} ${group.code} ${groupCollapsed ? '펼치기' : '접기'}`}
                          aria-expanded={!groupCollapsed}
                          title={`${group.label} ${group.code}`}
                          onClick={() => toggleGroup(group.key)}
                          className={`sticky top-0 z-10 flex w-full items-center gap-2 border-b bg-bg-card px-3 py-1.5 text-left text-sm font-semibold text-fg-dim hover:bg-bg-input-hover ${dragEnabled ? 'cursor-grab active:cursor-grabbing' : ''}`}
                        >
                          <span className="w-3 text-xs" aria-hidden>{groupCollapsed ? '▶' : '▼'}</span>
                          <span className="min-w-0 flex-1 truncate">{group.label}</span>
                          <span className="text-xs font-normal text-fg-dimmer">{group.rows.length}</span>
                        </button>
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
        </div>
      </div>
      {dialog && (
        <StudyViewSaveDialog
          mode={dialog.mode}
          defaultName={dialog.defaultName}
          defaultMemo={dialog.defaultMemo}
          barCount={dialog.request.snapshot.bundle.candles.length}
          sizeBytes={studySnapshotByteSize(dialog.request.snapshot)}
          isSubmitting={dialogMutation.isPending}
          errorMessage={dialogError}
          onCancel={() => setDialog(null)}
          onSubmit={handleDialogSubmit}
        />
      )}
      {deleteTarget && (
        <div role="dialog" aria-modal="true" aria-label="저장뷰 삭제" className="fixed inset-0 z-50 grid place-items-center bg-black/40">
          <div className="w-[320px] max-w-[calc(100vw-24px)] space-y-3 rounded border bg-bg p-4 shadow-lg">
            <h2 className="text-sm font-semibold">저장뷰 삭제</h2>
            <p className="text-xs text-fg-dim">{deleteTarget.name} 저장뷰를 삭제합니다.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteTarget(null)} className="rounded border px-3 py-1 text-sm">취소</button>
              <button
                type="button"
                ref={deleteConfirmButtonRef}
                onClick={confirmDelete}
                className="rounded border px-3 py-1 text-sm"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

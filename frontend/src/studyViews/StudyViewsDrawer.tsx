import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import type { ParquetStudyView, ParquetStudyViewWriteRequest } from '../api/studyViews';
import { useCurrentStudySaveSource } from './studySaveSource';
import {
  defaultStudyViewName,
  studySnapshotByteSize,
  viewportFromCapture,
  visibleWindow,
} from './studySaveRequest';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import { buildStudySnapshotRequest } from './useStudySnapshotCapture';

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function filterStudyViews<T extends { name: string; code: string; memo: string }>(rows: T[], query: string): T[] {
  const q = normalize(query);
  if (!q) return rows;
  return rows.filter((row) => [row.name, row.code, row.memo].some((v) => normalize(v).includes(q)));
}

type SaveDialogState = { mode: 'create' | 'overwrite'; id?: string; request: ParquetStudyViewWriteRequest };

export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const mutations = useStudyViewMutations();
  const saveSource = useCurrentStudySaveSource();
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<SaveDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParquetStudyView | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; value: string; error: string | null } | null>(null);
  const renameCommittingRef = useRef(false);
  const deleteConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const rows = useMemo(() => filterStudyViews(data?.saves ?? [], query), [data?.saves, query]);
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

  useEffect(() => {
    if (!deleteTarget) return;
    deleteConfirmButtonRef.current?.focus();
  }, [deleteTarget]);

  const openSaveDialog = (mode: 'create' | 'overwrite', id?: string) => {
    if (!studySource) return;
    const row = id ? data?.saves.find((save) => save.id === id) : currentStudyRow;
    const viewport = viewportFromCapture(studySource.captureViewport, studySource.snapshot.viewport);
    if (!viewport) return;
    const window = visibleWindow(studySource.bundle, viewport);
    const request = buildStudySnapshotRequest({
      name: defaultStudyViewName(mode === 'overwrite' ? row : undefined, studySource.snapshot.label, studySource.snapshot.timeframe),
      memo: mode === 'overwrite' ? row?.memo ?? '' : '',
      route: '/study',
      code: studySource.snapshot.code,
      label: studySource.snapshot.label,
      timeframe: studySource.snapshot.timeframe,
      viewport,
      indicatorState: studySource.snapshot.indicator_state,
      bundle: studySource.bundle,
      fromIndex: window.fromIndex,
      toIndex: window.toIndex,
    });
    setDialog({ mode, id, request });
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
          <input
            aria-label="저장 뷰 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-bg-input border rounded px-2 py-1 text-sm"
          />
          {location.pathname === '/live' && <p className="mt-2 text-xs text-fg-dim">라이브 상단 툴바에서 저장할 수 있습니다.</p>}
          {location.pathname === '/study' && !studySource && <p className="mt-2 text-xs text-fg-dim">학습뷰를 불러온 뒤 저장할 수 있습니다.</p>}
          {location.pathname !== '/live' && location.pathname !== '/study' && (
            <p className="mt-2 text-xs text-fg-dim">차트 화면에서 저장할 수 있습니다.</p>
          )}
          {canSaveStudy && (
            <button type="button" onClick={() => openSaveDialog('create')} className="mt-2 w-full text-xs px-2 py-1 border rounded">
              새 저장본 만들기
            </button>
          )}
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
        {!isLoading && !isError && (data?.saves.length ?? 0) > 0 && rows.length === 0 && (
          <div className="p-3 text-sm text-fg-dim">검색 결과가 없습니다.</div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-start gap-2 border-b px-3 py-2 hover:bg-bg-input-hover"
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
                  <div className="truncate text-xs text-fg-dim">{row.label} {row.code} · {row.timeframe}</div>
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => navigate(`/study?view=${row.id}`)}
                      className="block w-full truncate text-left text-sm font-medium text-fg focus:outline-none focus:ring-1 focus:ring-line"
                    >
                      {row.name}
                    </button>
                    <div className="truncate text-xs text-fg-dim">
                      {row.label} {row.code} · {row.timeframe}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`${row.name} 이름 수정`}
                    onClick={() => startRename(row)}
                    className="shrink-0 rounded border border-line px-2 py-1 text-xs text-fg-dim hover:bg-bg-input"
                  >
                    수정
                  </button>
                </div>
              )}
              <button
                type="button"
                aria-label={`${row.name} 삭제`}
                onClick={() => setDeleteTarget(row)}
                className="shrink-0 rounded border border-line px-2 py-1 text-xs"
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      </div>
      {dialog && (
        <StudyViewSaveDialog
          mode={dialog.mode}
          defaultName={dialog.request.name}
          defaultMemo={dialog.request.memo ?? ''}
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

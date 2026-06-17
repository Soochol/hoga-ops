import { useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import type { ParquetStudyView, ParquetStudyViewWriteRequest, StudyViewport } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { chooseSnapshotWindow } from './snapshotWindow';
import { useCurrentStudySaveSource } from './studySaveSource';
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

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function defaultName(row: ParquetStudyView | undefined, label: string, timeframe: string): string {
  return row?.name ?? `${label} ${timeframe} 저장뷰`;
}

function fallbackViewport(bundle: RangeBundle): StudyViewport | null {
  const last = bundle.candles[bundle.candles.length - 1];
  if (!last) return null;
  return {
    right_edge_ms: last.ts_ms,
    bar_span: Math.max(1, Math.min(200, bundle.candles.length)),
    at_live_edge: true,
  };
}

function viewportFromCapture(
  captureViewport: () => { rightEdgeMs: number; barSpan: number; atLiveEdge: boolean } | null,
  fallback: StudyViewport | null,
): StudyViewport | null {
  const captured = captureViewport();
  if (!captured) return fallback;
  return {
    right_edge_ms: captured.rightEdgeMs,
    bar_span: captured.barSpan,
    at_live_edge: captured.atLiveEdge,
  };
}

function visibleWindow(bundle: RangeBundle, viewport: StudyViewport) {
  const candles = bundle.candles;
  if (candles.length === 0) return { fromIndex: 0, toIndex: -1 };
  const rightIndex = candles.reduce((best, candle, index) => (
    candle.ts_ms <= viewport.right_edge_ms ? index : best
  ), 0);
  const visibleTo = Math.max(0, Math.min(candles.length - 1, rightIndex));
  const visibleFrom = Math.max(0, visibleTo - Math.ceil(viewport.bar_span) + 1);
  return chooseSnapshotWindow(candles, visibleFrom, visibleTo);
}

export function StudyViewsDrawer() {
  const { data, isLoading, isError, refetch } = useStudyViews();
  const mutations = useStudyViewMutations();
  const saveSource = useCurrentStudySaveSource();
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<SaveDialogState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ParquetStudyView | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const rows = useMemo(() => filterStudyViews(data?.saves ?? [], query), [data?.saves, query]);
  const currentStudyViewId = useMemo(() => new URLSearchParams(location.search).get('view'), [location.search]);
  const currentStudyRow = useMemo(
    () => data?.saves.find((row) => row.id === currentStudyViewId),
    [currentStudyViewId, data?.saves],
  );
  const liveSource = saveSource?.origin === 'live' ? saveSource : null;
  const studySource = saveSource?.origin === 'study' ? saveSource : null;
  const overwriteStudyViewId = location.pathname === '/study' ? studySource?.viewId ?? currentStudyViewId ?? undefined : undefined;
  const canSaveStudy = location.pathname === '/study' && !!studySource;
  const canSaveLive = location.pathname === '/live' && !!liveSource;
  const canSave = canSaveStudy || canSaveLive;

  const openSaveDialog = (mode: 'create' | 'overwrite', id?: string) => {
    if (location.pathname === '/live') {
      if (!liveSource) return;
      const viewport = viewportFromCapture(liveSource.captureViewport, fallbackViewport(liveSource.bundle));
      if (!viewport) return;
      const window = visibleWindow(liveSource.bundle, viewport);
      const request = buildStudySnapshotRequest({
        name: defaultName(undefined, liveSource.label, liveSource.timeframe),
        memo: '',
        route: '/live',
        code: liveSource.code,
        label: liveSource.label,
        timeframe: liveSource.timeframe,
        viewport,
        indicatorState: liveSource.indicatorState,
        bundle: liveSource.bundle,
        fromIndex: window.fromIndex,
        toIndex: window.toIndex,
      });
      setDialog({ mode: 'create', request });
      return;
    }
    if (!studySource) return;
    const row = id ? data?.saves.find((save) => save.id === id) : currentStudyRow;
    const viewport = viewportFromCapture(studySource.captureViewport, studySource.snapshot.viewport);
    if (!viewport) return;
    const window = visibleWindow(studySource.bundle, viewport);
    const request = buildStudySnapshotRequest({
      name: defaultName(mode === 'overwrite' ? row : undefined, studySource.snapshot.label, studySource.snapshot.timeframe),
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
          <button
            type="button"
            disabled={!canSave}
            onClick={() => location.pathname === '/study' && overwriteStudyViewId
              ? openSaveDialog('overwrite', overwriteStudyViewId)
              : openSaveDialog('create')}
            className="text-xs px-2 py-1 border rounded disabled:opacity-50"
          >
            {location.pathname === '/study' && overwriteStudyViewId ? '덮어쓰기' : '현재 뷰 저장'}
          </button>
        </header>
        <div className="p-3 border-b">
          <input
            aria-label="저장 뷰 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-bg-input border rounded px-2 py-1 text-sm"
          />
          {location.pathname === '/live' && !liveSource && <p className="mt-2 text-xs text-fg-dim">차트를 불러온 뒤 저장할 수 있습니다.</p>}
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
              <button
                type="button"
                onClick={() => navigate(`/study?view=${row.id}`)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="text-sm font-medium truncate">{row.name}</div>
                <div className="text-xs text-fg-dim truncate">{row.label} {row.code} · {row.timeframe}</div>
              </button>
              <button
                type="button"
                aria-label={`${row.name} 삭제`}
                onClick={() => setDeleteTarget(row)}
                className="shrink-0 rounded border px-2 py-1 text-xs"
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
          sizeBytes={byteSize(dialog.request.snapshot)}
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

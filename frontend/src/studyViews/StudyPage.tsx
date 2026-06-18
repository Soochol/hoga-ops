import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import type { TabViewport } from '../live/viewportAnchor';
import { bucketSeconds } from '../state/livePage';
import { StudyDetailPanel } from './StudyDetailPanel';
import { StudyMemoPanel } from './StudyMemoPanel';
import { useStudyViewMutations, useStudyViews, useStudyViewSnapshot } from './useStudyViews';
import { studySnapshotBundleToChartInput, studySnapshotDetails } from './studySnapshotAdapter';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type StoredStudySaveSource,
} from './studySaveSource';

export function StudyPage() {
  const [params] = useSearchParams();
  const viewId = params.get('view');
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const [isCursorActive, setIsCursorActive] = useState(false);
  const savesQuery = useStudyViews();
  const mutations = useStudyViewMutations();
  const [isMemoOpen, setIsMemoOpen] = useState(false);
  const [memoError, setMemoError] = useState<string | null>(null);
  const snapshotQuery = useStudyViewSnapshot(viewId);
  const snapshot = snapshotQuery.data;
  const selectedSave = useMemo(
    () => savesQuery.data?.saves.find((row) => row.id === viewId) ?? null,
    [savesQuery.data?.saves, viewId],
  );
  const chartInput = useMemo(
    () => snapshot ? studySnapshotBundleToChartInput(snapshot.bundle) : null,
    [snapshot],
  );
  const details = useMemo(
    () => snapshot ? studySnapshotDetails(snapshot.bundle) : null,
    [snapshot],
  );
  const bucketMs = snapshot ? (bucketSeconds(snapshot.timeframe) ?? 60) * 1000 : 60_000;
  const captureViewportRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    captureViewportRef.current = capture;
  }, []);
  const commitMemo = useCallback((memo: string) => {
    if (!viewId || memo === (selectedSave?.memo ?? '')) return;
    setMemoError(null);
    mutations.updateMetadata.mutate(
      { id: viewId, body: { memo } },
      {
        onError: (error) => setMemoError(error instanceof Error ? error.message : '메모 저장에 실패했습니다.'),
      },
    );
  }, [mutations.updateMetadata, selectedSave?.memo, viewId]);

  useEffect(() => {
    setIsCursorActive(false);
  }, [viewId]);

  useEffect(() => {
    if (!viewId || !snapshot || !chartInput) {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    const source: StoredStudySaveSource = {
      origin: 'study',
      viewId,
      snapshot,
      bundle: chartInput.bundle,
      captureViewport: () => captureViewportRef.current(),
    };
    setCurrentStudySaveSource(source);
    return () => {
      clearCurrentStudySaveSource(source);
    };
  }, [captureViewportRef, chartInput, snapshot, viewId]);

  if (!viewId) {
    return (
      <section data-testid="study-page-empty" className="h-full min-w-0 bg-[var(--bg)] text-[var(--fg)]">
        <div className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
          저장된 학습뷰를 선택하세요.
        </div>
      </section>
    );
  }

  if (snapshotQuery.isLoading) {
    return (
      <section data-testid="study-page-loading" className="h-full min-w-0 bg-[var(--bg)] text-[var(--fg)]">
        <div className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
          학습뷰 불러오는 중...
        </div>
      </section>
    );
  }

  if (snapshotQuery.isError || !snapshot || !chartInput) {
    return (
      <section data-testid="study-page-error" className="h-full min-w-0 bg-[var(--bg)] text-[var(--fg)]">
        <div className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
          학습뷰를 찾을 수 없습니다.
        </div>
      </section>
    );
  }

  return (
    <section data-testid="study-page" className="grid h-full min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-[var(--bg)] text-[var(--fg)]">
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{snapshot.label}</div>
          <div className="text-xs text-[var(--fg-dimmer)]">
            {snapshot.code} · {snapshot.timeframe} · 저장 스냅샷
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsMemoOpen((value) => !value)}
          className="shrink-0 rounded border border-border bg-bg-input px-2 py-1 text-xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
        >
          메모
        </button>
      </header>
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_280px]">
        <LiveChartRoot
          code={snapshot.code}
          timeframe={snapshot.timeframe}
          viewIdentity={viewId}
          bundle={chartInput.bundle}
          chartBundle={chartInput.chartBundle}
          ratioBundle={chartInput.ratioBundle}
          clampEngaged={false}
          isPastCandlesLoading={false}
          isExtending={false}
          pastDataWarnings={[]}
          restoreViewport={{
            rightEdgeMs: snapshot.viewport.right_edge_ms,
            barSpan: snapshot.viewport.bar_span,
            atLiveEdge: snapshot.viewport.at_live_edge,
          }}
          dayAskPeaks={chartInput.bundle.ask_peaks}
          forceHogaPanes
          paneTogglesOverride={{
            volumeEnabled: snapshot.indicator_state.volume_enabled,
            quoteTotalsEnabled: snapshot.indicator_state.quote_totals_enabled,
            ratioEnabled: snapshot.indicator_state.ratio_enabled,
            fillStrengthEnabled: snapshot.indicator_state.fill_strength_enabled,
          }}
          persistLiveViewport={false}
          onViewportCaptureReady={handleViewportCaptureReady}
          onCursorActiveChange={setIsCursorActive}
        />
        <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-[var(--border)]">
          {isMemoOpen && selectedSave && (
            <StudyMemoPanel
              memo={selectedSave.memo}
              isSaving={mutations.updateMetadata.isPending}
              errorMessage={memoError}
              onClose={() => setIsMemoOpen(false)}
              onCommit={commitMemo}
            />
          )}
          {details && chartInput && (
            <StudyDetailPanel
              details={details}
              candles={chartInput.bundle.candles}
              segments={chartInput.bundle.segments}
              bucketMs={bucketMs}
              cursorMs={isCursorActive ? cursorMs : null}
            />
          )}
        </aside>
      </div>
    </section>
  );
}

export default StudyPage;

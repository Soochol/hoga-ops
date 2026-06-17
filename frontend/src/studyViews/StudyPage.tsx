import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import type { TabViewport } from '../live/viewportAnchor';
import { bucketSeconds } from '../state/livePage';
import { StudyDetailPanel } from './StudyDetailPanel';
import { useStudyViewSnapshot } from './useStudyViews';
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
  const snapshotQuery = useStudyViewSnapshot(viewId);
  const snapshot = snapshotQuery.data;
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
      <header className="flex min-h-12 items-center gap-3 border-b border-[var(--border)] px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{snapshot.label}</div>
          <div className="text-xs text-[var(--fg-dimmer)]">
            {snapshot.code} · {snapshot.timeframe} · 저장 스냅샷
          </div>
        </div>
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
        />
        {details && chartInput && (
          <StudyDetailPanel
            details={details}
            candles={chartInput.bundle.candles}
            bucketMs={bucketMs}
            cursorMs={cursorMs}
          />
        )}
      </div>
    </section>
  );
}

export default StudyPage;

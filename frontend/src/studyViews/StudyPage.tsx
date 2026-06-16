import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { useStudyViewSnapshot } from './useStudyViews';
import { studySnapshotBundleToRangeBundle } from './studySnapshotAdapter';

export function StudyPage() {
  const [params] = useSearchParams();
  const viewId = params.get('view');
  const snapshotQuery = useStudyViewSnapshot(viewId);
  const snapshot = snapshotQuery.data;
  const bundle = useMemo(
    () => snapshot ? studySnapshotBundleToRangeBundle(snapshot.bundle) : null,
    [snapshot],
  );

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

  if (snapshotQuery.isError || !snapshot || !bundle) {
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
      <LiveChartRoot
        code={snapshot.code}
        timeframe={snapshot.timeframe}
        viewIdentity={viewId}
        bundle={bundle}
        chartBundle={bundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        pastDataWarnings={[]}
        restoreViewport={{
          rightEdgeMs: snapshot.viewport.right_edge_ms,
          barSpan: snapshot.viewport.bar_span,
          atLiveEdge: snapshot.viewport.at_live_edge,
        }}
        dayAskPeaks={[]}
        forceHogaPanes
        paneTogglesOverride={{
          volumeEnabled: snapshot.indicator_state.volume_enabled,
          quoteTotalsEnabled: snapshot.indicator_state.quote_totals_enabled,
          ratioEnabled: snapshot.indicator_state.ratio_enabled,
          fillStrengthEnabled: snapshot.indicator_state.fill_strength_enabled,
        }}
        persistLiveViewport={false}
      />
    </section>
  );
}

export default StudyPage;

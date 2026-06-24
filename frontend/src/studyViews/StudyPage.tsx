import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import type { TabViewport } from '../live/viewportAnchor';
import { bucketSeconds, type LiveMAConfig } from '../state/livePage';
import { useStudyTabsStore } from '../state/studyTabs';
import { StudyDetailPanel } from './StudyDetailPanel';
import { StudyMemoPanel } from './StudyMemoPanel';
import { StudyTabBar } from './StudyTabBar';
import { useStudyKeyboard } from './useStudyKeyboard';
import { useStudyViewMutations, useStudyViews, useStudyViewSnapshot } from './useStudyViews';
import { studySnapshotBundleToChartInput, studySnapshotDetails } from './studySnapshotAdapter';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type StoredStudySaveSource,
} from './studySaveSource';

export function StudyPage() {
  const [params] = useSearchParams();
  const queryViewId = params.get('view');
  const navigate = useNavigate();
  const cursorMs = useLiveCursorStore((s) => s.cursorMs);
  const [isCursorActive, setIsCursorActive] = useState(false);
  const savesQuery = useStudyViews();
  const mutations = useStudyViewMutations();
  const [isMemoOpen, setIsMemoOpen] = useState(false);
  const [memoError, setMemoError] = useState<string | null>(null);
  const tabs = useStudyTabsStore((state) => state.tabs);
  const activeTabId = useStudyTabsStore((state) => state.activeTabId);
  const ensureQuerySeed = useStudyTabsStore((state) => state.ensureQuerySeed);
  const focusTab = useStudyTabsStore((state) => state.focusTab);
  const closeTab = useStudyTabsStore((state) => state.closeTab);
  const reorderTabs = useStudyTabsStore((state) => state.reorderTabs);
  const initialQueryViewIdRef = useRef(queryViewId);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const querySave = useMemo(
    () => savesQuery.data?.saves.find((row) => row.id === queryViewId) ?? null,
    [queryViewId, savesQuery.data?.saves],
  );
  const activeViewId = queryViewId ?? activeTab?.viewId ?? null;
  const snapshotQuery = useStudyViewSnapshot(activeViewId);
  const snapshot = snapshotQuery.data;
  const selectedSave = useMemo(
    () => savesQuery.data?.saves.find((row) => row.id === activeViewId) ?? null,
    [activeViewId, savesQuery.data?.saves],
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
  const dailyMovingAverageOverride = useMemo(() => {
    if (!snapshot) return undefined;
    return {
      configs: (snapshot.indicator_state.daily_moving_averages ?? []).map((m): LiveMAConfig => ({
        id: m.id,
        enabled: m.enabled,
        period: m.period,
        color: m.color,
        lineWidth: m.line_width,
        source: m.source,
      })),
      masterEnabled: snapshot.indicator_state.daily_moving_average_enabled === true,
      hidden: snapshot.indicator_state.daily_moving_average_hidden === true,
    };
  }, [snapshot]);
  const captureViewportRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    captureViewportRef.current = capture;
  }, []);
  const commitMemo = useCallback((memo: string) => {
    if (!activeViewId || memo === (selectedSave?.memo ?? '')) return;
    setMemoError(null);
    mutations.updateMetadata.mutate(
      { id: activeViewId, body: { memo } },
      {
        onError: (error) => setMemoError(error instanceof Error ? error.message : '메모 저장에 실패했습니다.'),
      },
    );
  }, [activeViewId, mutations.updateMetadata, selectedSave?.memo]);

  useEffect(() => {
    if (initialQueryViewIdRef.current === null) return;
    if (queryViewId !== initialQueryViewIdRef.current) return;
    if (!querySave) return;
    ensureQuerySeed(querySave);
    initialQueryViewIdRef.current = null;
  }, [ensureQuerySeed, querySave, queryViewId]);

  useEffect(() => {
    setIsCursorActive(false);
  }, [activeViewId]);

  useEffect(() => {
    if (activeTab) {
      if (queryViewId === activeTab.viewId) return;
      navigate(`/study?view=${activeTab.viewId}`, { replace: true });
      return;
    }
    if (tabs.length === 0 && queryViewId !== null && initialQueryViewIdRef.current === null) {
      navigate('/study', { replace: true });
    }
  }, [activeTab, navigate, queryViewId, tabs.length]);

  useStudyKeyboard({
    onSelectTabIndex: (index) => {
      const nextTab = tabs[index];
      if (nextTab) focusTab(nextTab.id);
    },
  });

  useEffect(() => {
    if (!activeViewId || !snapshot || !chartInput) {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    const source: StoredStudySaveSource = {
      origin: 'study',
      viewId: activeViewId,
      snapshot,
      bundle: chartInput.bundle,
      captureViewport: () => captureViewportRef.current(),
    };
    setCurrentStudySaveSource(source);
    return () => {
      clearCurrentStudySaveSource(source);
    };
  }, [activeViewId, captureViewportRef, chartInput, snapshot]);

  if (!activeViewId) {
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
    <section data-testid="study-page" className="grid h-full min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] bg-[var(--bg)] text-[var(--fg)]">
      {tabs.length > 0 && (
        <div className="min-w-0 border-b border-[var(--border)]">
          <StudyTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            activeLoading={snapshotQuery.isLoading}
            onFocus={focusTab}
            onClose={closeTab}
            onReorder={reorderTabs}
            onNewTab={() => {}}
          />
        </div>
      )}
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
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_var(--sidebar-w)]">
        <div className="min-h-0 min-w-0 overflow-hidden">
          <LiveChartRoot
            code={snapshot.code}
            timeframe={snapshot.timeframe}
            viewIdentity={activeTabId ? `${activeTabId}:${activeViewId}` : activeViewId}
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
            dayBidPeaks={chartInput.bundle.bid_peaks}
            forceHogaPanes
            paneTogglesOverride={{
              volumeEnabled: snapshot.indicator_state.volume_enabled,
              quoteTotalsEnabled: snapshot.indicator_state.quote_totals_enabled,
              ratioEnabled: snapshot.indicator_state.ratio_enabled,
              fillStrengthEnabled: snapshot.indicator_state.fill_strength_enabled,
            }}
            dailyMovingAverageOverride={dailyMovingAverageOverride}
            persistLiveViewport={false}
            onViewportCaptureReady={handleViewportCaptureReady}
            onCursorActiveChange={setIsCursorActive}
          />
        </div>
        <aside className="relative z-10 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-[var(--border)] bg-[var(--bg-card)]">
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

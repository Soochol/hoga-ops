import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LiveChartRoot } from '../live/LiveChartRoot';
import { tradeVolumePocsFromWire } from '../live/tradeVolumePocWire';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import type { TabViewport } from '../live/viewportAnchor';
import { useEntryDragStore } from '../state/entryDrag';
import { useStudyTabsStore } from '../state/studyTabs';
import { StudyDetailPanel } from './StudyDetailPanel';
import { StudyMemoPanel } from './StudyMemoPanel';
import { StudyTabBar } from './StudyTabBar';
import { useStudyKeyboard } from './useStudyKeyboard';
import { useStudyViewMutations, useStudyViews, useStudyViewSnapshot } from './useStudyViews';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';
import {
  legacyStudySnapshotId,
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
} from './studyViewVariant';
import { studyActiveViewModel } from './studyActiveViewModel';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type ReferenceStudySaveSource,
  type StoredStudySaveSource,
} from './studySaveSource';

function StudyDropOverlay() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-20 flex items-center justify-center"
      style={{
        pointerEvents: 'none',
        background: 'var(--tint-selection)',
        border: '2px dashed var(--accent)',
      }}
    >
      <span
        className="rounded-md font-ui text-sm font-semibold"
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        여기에 놓아 학습뷰 열기
      </span>
    </div>
  );
}

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
  const openSaveInActiveTab = useStudyTabsStore((state) => state.openSaveInActiveTab);
  const focusTab = useStudyTabsStore((state) => state.focusTab);
  const closeTab = useStudyTabsStore((state) => state.closeTab);
  const reorderTabs = useStudyTabsStore((state) => state.reorderTabs);
  const initialQueryViewIdRef = useRef(queryViewId);
  const handledQueryViewIdRef = useRef(queryViewId);
  const routeSyncPendingRef = useRef(false);
  const studyDropTargetRef = useRef<HTMLDivElement>(null);
  const detailPanelScrollRef = useRef<HTMLElement>(null);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const querySave = useMemo(
    () => savesQuery.data?.saves.find((row) => row.id === queryViewId) ?? null,
    [queryViewId, savesQuery.data?.saves],
  );
  const initialQueryPending = initialQueryViewIdRef.current !== null && queryViewId === initialQueryViewIdRef.current;
  const unhandledRouteQuery = queryViewId !== null && queryViewId !== handledQueryViewIdRef.current;
  const activeViewId = initialQueryPending || unhandledRouteQuery
    ? queryViewId
    : activeTab?.viewId ?? queryViewId ?? null;
  const selectedSave = useMemo(
    () => savesQuery.data?.saves.find((row) => row.id === activeViewId) ?? null,
    [activeViewId, savesQuery.data?.saves],
  );
  const referenceSave = referenceStudyView(selectedSave);
  const legacySnapshotId = legacyStudySnapshotId(selectedSave);
  const snapshotQuery = useStudyViewSnapshot(legacySnapshotId);
  const referenceQuery = useStudyReferenceBundle(referenceSave);
  const activeViewModel = useMemo(
    () => studyActiveViewModel({
      selectedSave,
      reference: referenceQuery,
      snapshot: {
        snapshot: snapshotQuery.data,
        isLoading: snapshotQuery.isLoading,
        isError: snapshotQuery.isError,
      },
    }),
    [
      referenceQuery.bundle,
      referenceQuery.chartBundle,
      referenceQuery.error,
      referenceQuery.isLoading,
      referenceQuery.pastDataWarnings,
      selectedSave,
      snapshotQuery.data,
      snapshotQuery.isError,
      snapshotQuery.isLoading,
    ],
  );
  const isLoadingActiveView = activeViewModel.status === 'loading';
  const isErrorActiveView = activeViewModel.status === 'error';
  const captureViewportRef = useRef<() => TabViewport | null>(() => null);
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overStudy = useEntryDragStore((s) => s.overStudy);
  const registerStudyTarget = useEntryDragStore((s) => s.registerStudyTarget);
  const clearStudyTarget = useEntryDragStore((s) => s.clearStudyTarget);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    captureViewportRef.current = capture;
  }, []);
  const handleWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (!event.altKey) return;
    const scroller = detailPanelScrollRef.current;
    if (!scroller) return;
    scroller.scrollTop += event.deltaY;
    event.preventDefault();
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
    if (queryViewId !== initialQueryViewIdRef.current) {
      initialQueryViewIdRef.current = null;
      return;
    }
    if (savesQuery.isLoading) return;
    if (querySave) ensureQuerySeed(querySave);
    initialQueryViewIdRef.current = null;
  }, [ensureQuerySeed, querySave, queryViewId, savesQuery.isLoading]);

  useEffect(() => {
    routeSyncPendingRef.current = false;
    if (initialQueryViewIdRef.current !== null) return;
    if (queryViewId === handledQueryViewIdRef.current) return;
    handledQueryViewIdRef.current = queryViewId;
    if (!querySave) return;
    if (activeTab?.viewId === querySave.id) return;
    routeSyncPendingRef.current = true;
    openSaveInActiveTab(querySave);
  }, [activeTab?.viewId, openSaveInActiveTab, querySave, queryViewId]);

  useEffect(() => {
    setIsCursorActive(false);
  }, [activeViewId]);

  useEffect(() => {
    if (routeSyncPendingRef.current) return;
    if (initialQueryViewIdRef.current !== null) return;
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
    if (!activeViewId) {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    if (activeViewModel.status === 'ready' && activeViewModel.variant === 'reference') {
      const source: ReferenceStudySaveSource = {
        origin: 'study-reference',
        viewId: activeViewId,
        save: activeViewModel.save,
        bundle: activeViewModel.bundle,
        captureViewport: () => captureViewportRef.current(),
      };
      setCurrentStudySaveSource(source);
      return () => {
        clearCurrentStudySaveSource(source);
      };
    }
    if (activeViewModel.status !== 'ready' || activeViewModel.variant !== 'legacy-snapshot') {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    const source: StoredStudySaveSource = {
      origin: 'study',
      viewId: activeViewId,
      snapshot: activeViewModel.snapshot,
      bundle: activeViewModel.renderModel.chartInput.bundle,
      captureViewport: () => captureViewportRef.current(),
    };
    setCurrentStudySaveSource(source);
    return () => {
      clearCurrentStudySaveSource(source);
    };
  }, [activeViewId, activeViewModel, captureViewportRef]);

  useEffect(() => {
    const hitTest = (clientX: number, clientY: number): boolean => {
      const el = studyDropTargetRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    };
    registerStudyTarget(hitTest);
    return () => clearStudyTarget(hitTest);
  }, [clearStudyTarget, registerStudyTarget]);

  if (!activeViewId) {
    return (
      <section data-testid="study-page-empty" className="h-full min-w-0 bg-[var(--bg)] text-[var(--fg)]">
        <div ref={studyDropTargetRef} data-testid="study-drop-target" className="relative h-full">
          <div className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
            저장된 학습뷰를 선택하세요.
          </div>
          {draggingEntry && overStudy && <StudyDropOverlay />}
        </div>
      </section>
    );
  }

  if (savesQuery.isLoading || isLoadingActiveView) {
    return (
      <section data-testid="study-page-loading" className="h-full min-w-0 bg-[var(--bg)] text-[var(--fg)]">
        <div ref={studyDropTargetRef} data-testid="study-drop-target" className="relative h-full">
          <div className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
            학습뷰 불러오는 중...
          </div>
          {draggingEntry && overStudy && <StudyDropOverlay />}
        </div>
      </section>
    );
  }

  if (!selectedSave || isErrorActiveView) {
    return (
      <section data-testid="study-page-error" className="h-full min-w-0 bg-[var(--bg)] text-[var(--fg)]">
        <div ref={studyDropTargetRef} data-testid="study-drop-target" className="relative h-full">
          <div className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
            학습뷰를 찾을 수 없습니다.
          </div>
          {draggingEntry && overStudy && <StudyDropOverlay />}
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
            activeLoading={isLoadingActiveView}
            onFocus={focusTab}
            onClose={closeTab}
            onReorder={reorderTabs}
            onNewTab={() => {}}
          />
        </div>
      )}
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{selectedSave.label}</div>
          <div className="text-xs text-[var(--fg-dimmer)]">
            {selectedSave.code} · {selectedSave.timeframe} · {studyViewKindLabel(selectedSave)}
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
      <div
        ref={studyDropTargetRef}
        data-testid="study-drop-target"
        className="relative grid min-h-0 grid-cols-[minmax(0,1fr)_var(--sidebar-w)]"
        onWheelCapture={handleWheelCapture}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">
          {activeViewModel.status === 'ready' && activeViewModel.variant === 'reference' ? (
            <LiveChartRoot
              code={activeViewModel.save.code}
              timeframe={activeViewModel.save.timeframe}
              viewIdentity={activeTabId ? `${activeTabId}:${activeViewId}` : activeViewId}
              bundle={activeViewModel.bundle}
              chartBundle={activeViewModel.chartBundle}
              clampEngaged={false}
              isPastCandlesLoading={false}
              isExtending={false}
              pastDataWarnings={activeViewModel.pastDataWarnings}
              restoreViewport={{
                rightEdgeMs: activeViewModel.save.viewport.right_edge_ms,
                barSpan: activeViewModel.save.viewport.bar_span,
                atLiveEdge: activeViewModel.save.viewport.at_live_edge,
              }}
              dayAskPeaks={activeViewModel.bundle.ask_peaks}
              dayBidPeaks={activeViewModel.bundle.bid_peaks}
              todayKst={activeViewModel.save.range.to_date}
              tradeVolumePocs={tradeVolumePocsFromWire(activeViewModel.bundle.trade_volume_pocs)}
              forceHogaPanes
              onViewportCaptureReady={handleViewportCaptureReady}
              onCursorActiveChange={setIsCursorActive}
            />
          ) : activeViewModel.status === 'ready' && activeViewModel.variant === 'legacy-snapshot' ? (
            <LiveChartRoot
              code={activeViewModel.snapshot.code}
              timeframe={activeViewModel.snapshot.timeframe}
              viewIdentity={activeTabId ? `${activeTabId}:${activeViewId}` : activeViewId}
              bundle={activeViewModel.renderModel.chartInput.bundle}
              chartBundle={activeViewModel.renderModel.chartInput.chartBundle}
              ratioBundle={activeViewModel.renderModel.chartInput.ratioBundle}
              clampEngaged={false}
              isPastCandlesLoading={false}
              isExtending={false}
              pastDataWarnings={[]}
              restoreViewport={activeViewModel.renderModel.restoreViewport}
              dayAskPeaks={activeViewModel.renderModel.chartInput.bundle.ask_peaks}
              dayBidPeaks={activeViewModel.renderModel.chartInput.bundle.bid_peaks}
              todayKst={activeViewModel.renderModel.todayKst}
              tradeVolumePocs={activeViewModel.renderModel.tradeVolumePocs}
              forceHogaPanes
              paneTogglesOverride={activeViewModel.renderModel.paneTogglesOverride}
              dailyMovingAverageOverride={activeViewModel.renderModel.dailyMovingAverageOverride}
              tradeVolumePocOverride={activeViewModel.renderModel.tradeVolumePocOverride}
              onViewportCaptureReady={handleViewportCaptureReady}
              onCursorActiveChange={setIsCursorActive}
            />
          ) : null}
        </div>
        <aside
          ref={detailPanelScrollRef}
          role="complementary"
          aria-label="Study Detail Panel"
          data-testid={studyReferenceDetailPanelTestId(selectedSave)}
          className="relative z-10 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-y-auto overflow-x-hidden border-l border-[var(--border)] bg-[var(--bg-card)]"
          style={{ scrollbarGutter: 'stable' }}
        >
          {isMemoOpen && selectedSave && (
            <StudyMemoPanel
              memo={selectedSave.memo}
              isSaving={mutations.updateMetadata.isPending}
              errorMessage={memoError}
              onClose={() => setIsMemoOpen(false)}
              onCommit={commitMemo}
            />
          )}
          {activeViewModel.status === 'ready' && activeViewModel.variant === 'legacy-snapshot' && (
            <StudyDetailPanel
              details={activeViewModel.renderModel.details}
              candles={activeViewModel.renderModel.chartInput.bundle.candles}
              segments={activeViewModel.renderModel.chartInput.bundle.segments}
              programTrade={activeViewModel.renderModel.chartInput.bundle.program_trade ?? null}
              bucketMs={activeViewModel.renderModel.bucketMs}
              cursorMs={isCursorActive ? cursorMs : null}
            />
          )}
        </aside>
        {draggingEntry && overStudy && <StudyDropOverlay />}
      </div>
    </section>
  );
}

export default StudyPage;

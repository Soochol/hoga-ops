import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type WheelEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { PageContainer } from '../layout/PageContainer';
import IndicatorPanel from '../live/indicators/IndicatorPanel';
import { LiveChartRoot } from '../live/LiveChartRoot';
import LiveSettingsModal from '../live/LiveSettingsModal';
import { TimeframeControl } from '../live/TimeframeControl';
import { LiveChartActionButtons } from '../live/LiveToolbar';
import { tradeVolumePocsFromWire } from '../live/tradeVolumePocWire';
import type { TabViewport } from '../live/viewportAnchor';
import { useEntryDragStore } from '../state/entryDrag';
import { useStudyTabsStore } from '../state/studyTabs';
import { isMinuteTimeframe, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';
import { StudyMemoPanel } from './StudyMemoPanel';
import { StudyReferenceDetailPanel } from './StudyReferenceDetailPanel';
import { StudyTabBar } from './StudyTabBar';
import { useStudyKeyboard } from './useStudyKeyboard';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';
import { useWarmStudyReferenceTabQueries } from './useWarmStudyReferenceTabQueries';
import {
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
} from './studyViewVariant';
import { studyActiveViewModel } from './studyActiveViewModel';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type ReferenceStudySaveSource,
} from './studySaveSource';
import { PanelCard } from '../ui/PageShell';
import { DropOverlay, IconToolbarButton, WorkspaceHeader, WorkspaceRoot, WorkspaceState } from '../ui/WorkspaceShell';

function StudyDropOverlay() {
  return <DropOverlay>여기에 놓아 학습뷰 열기</DropOverlay>;
}

function StudySearchHeader({
  label = '학습뷰',
  description = '저장된 복기뷰를 선택하세요.',
}: {
  label?: string;
  description?: string;
}) {
  return (
    <WorkspaceHeader className="min-h-12 px-4">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{label}</div>
        <div className="text-xs text-[var(--fg-dimmer)]">{description}</div>
      </div>
    </WorkspaceHeader>
  );
}

function StudyStateWorkspace({
  children,
  tone = 'neutral',
  testId,
  dropTargetRef,
  showDropOverlay,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'error';
  testId: string;
  dropTargetRef: RefObject<HTMLDivElement>;
  showDropOverlay: boolean;
}) {
  return (
    <WorkspaceRoot className="grid h-full grid-rows-[auto_minmax(0,1fr)] bg-transparent">
      <StudySearchHeader />
      <WorkspaceState
        testId={testId}
        tone={tone}
        className="min-h-0"
        dropTargetRef={dropTargetRef}
        showDropOverlay={showDropOverlay}
      >
        {children}
      </WorkspaceState>
    </WorkspaceRoot>
  );
}

function StudyPageStateShell({
  children,
  workspace,
}: {
  children: ReactNode;
  workspace: ReactNode;
}) {
  return (
    <PageContainer className="min-h-0">
      <PanelCard data-testid="study-page-primary" className="flex h-full min-h-0 flex-col overflow-hidden">
        {workspace}
        {children}
      </PanelCard>
    </PageContainer>
  );
}

export function StudyPage() {
  const [params] = useSearchParams();
  const queryViewId = params.get('view');
  const navigate = useNavigate();
  const [isCursorActive, setIsCursorActive] = useState(false);
  const [viewTimeframes, setViewTimeframes] = useState<Record<string, LiveTimeframe>>({});
  const [rememberedMinuteTimeframes, setRememberedMinuteTimeframes] = useState<Record<string, MinuteTimeframe>>({});
  const [activatedStudyTabIds, setActivatedStudyTabIds] = useState<Set<string>>(() => new Set());
  const savesQuery = useStudyViews();
  const mutations = useStudyViewMutations();
  const [isMemoOpen, setIsMemoOpen] = useState(false);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoError, setMemoError] = useState<string | null>(null);
  const tabs = useStudyTabsStore((state) => state.tabs);
  const activeTabId = useStudyTabsStore((state) => state.activeTabId);
  const ensureQuerySeed = useStudyTabsStore((state) => state.ensureQuerySeed);
  const openSaveInActiveTab = useStudyTabsStore((state) => state.openSaveInActiveTab);
  const focusTab = useStudyTabsStore((state) => state.focusTab);
  const closeTab = useStudyTabsStore((state) => state.closeTab);
  const reorderTabs = useStudyTabsStore((state) => state.reorderTabs);
  const updateTabTimeframe = useStudyTabsStore((state) => state.updateTabTimeframe);
  const updateTabViewport = useStudyTabsStore((state) => state.updateTabViewport);
  const initialQueryViewIdRef = useRef(queryViewId);
  const handledQueryViewIdRef = useRef(queryViewId);
  const routeSyncPendingRef = useRef(false);
  const studyDropTargetRef = useRef<HTMLDivElement>(null);
  const detailPanelScrollRef = useRef<HTMLElement>(null);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const activatedTabIds = useMemo(() => Array.from(activatedStudyTabIds), [activatedStudyTabIds]);
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
  const selectedTimeframe = activeViewId && referenceSave
    ? viewTimeframes[activeViewId] ?? referenceSave.timeframe
    : null;
  const rememberedMinuteTimeframe = activeViewId && referenceSave
    ? rememberedMinuteTimeframes[activeViewId]
      ?? (isMinuteTimeframe(referenceSave.timeframe) ? referenceSave.timeframe : '1m')
    : '1m';
  const displayedReferenceSave = useMemo(
    () => referenceSave && selectedTimeframe
      ? { ...referenceSave, timeframe: selectedTimeframe }
      : null,
    [referenceSave, selectedTimeframe],
  );
  const referenceQuery = useStudyReferenceBundle(displayedReferenceSave);
  const activeViewModel = useMemo(
    () => studyActiveViewModel({
      selectedSave: displayedReferenceSave ?? selectedSave,
      reference: referenceQuery,
    }),
    [
      displayedReferenceSave,
      referenceQuery.bundle,
      referenceQuery.chartBundle,
      referenceQuery.error,
      referenceQuery.isLoading,
      referenceQuery.pastDataWarnings,
      selectedSave,
    ],
  );
  const isLoadingActiveView = activeViewModel.status === 'loading';
  const isErrorActiveView = activeViewModel.status === 'error';
  const isStudyPageLoading = savesQuery.isLoading || isLoadingActiveView;
  const captureViewportRef = useRef<() => TabViewport | null>(() => null);
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overStudy = useEntryDragStore((s) => s.overStudy);
  const registerStudyTarget = useEntryDragStore((s) => s.registerStudyTarget);
  const clearStudyTarget = useEntryDragStore((s) => s.clearStudyTarget);
  const warmTabStatuses = useWarmStudyReferenceTabQueries({
    tabs,
    activeTabId,
    activatedTabIds,
    saves: savesQuery.data?.saves ?? [],
    viewTimeframes,
  });
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    captureViewportRef.current = capture;
  }, []);
  const captureActiveTabViewport = useCallback(() => {
    if (!activeTabId) return;
    const viewport = captureViewportRef.current();
    if (!viewport) return;
    updateTabViewport(activeTabId, viewport);
  }, [activeTabId, updateTabViewport]);
  const handleFocusTab = useCallback((id: string) => {
    if (id !== activeTabId) captureActiveTabViewport();
    focusTab(id);
  }, [activeTabId, captureActiveTabViewport, focusTab]);
  const handleCloseTab = useCallback((id: string) => {
    if (id === activeTabId) captureActiveTabViewport();
    closeTab(id);
  }, [activeTabId, captureActiveTabViewport, closeTab]);
  const openSaveInActiveTabWithViewportCapture = useCallback((save: Parameters<typeof openSaveInActiveTab>[0]) => {
    captureActiveTabViewport();
    openSaveInActiveTab(save);
  }, [captureActiveTabViewport, openSaveInActiveTab]);
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
  const changeTimeframe = useCallback((next: LiveTimeframe) => {
    if (!activeViewId) return;
    setViewTimeframes((current) => ({ ...current, [activeViewId]: next }));
    if (isMinuteTimeframe(next)) {
      setRememberedMinuteTimeframes((current) => ({ ...current, [activeViewId]: next }));
    }
    if (activeTab && activeTab.viewId === activeViewId) {
      updateTabTimeframe(activeTab.id, next);
    }
  }, [activeTab, activeViewId, updateTabTimeframe]);

  useEffect(() => {
    if (!activeTab) return;
    setViewTimeframes((current) => (
      current[activeTab.viewId] === activeTab.timeframe
        ? current
        : { ...current, [activeTab.viewId]: activeTab.timeframe }
    ));
    const tabTimeframe = activeTab.timeframe;
    if (isMinuteTimeframe(tabTimeframe)) {
      setRememberedMinuteTimeframes((current) => (
        current[activeTab.viewId] === tabTimeframe
          ? current
          : { ...current, [activeTab.viewId]: tabTimeframe }
      ));
    }
  }, [activeTab]);

  useEffect(() => {
    setActivatedStudyTabIds((current) => {
      const currentTabIds = new Set(tabs.map((tab) => tab.id));
      const next = new Set<string>();
      let changed = false;
      for (const id of current) {
        if (currentTabIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      if (activeTabId && currentTabIds.has(activeTabId) && !next.has(activeTabId)) {
        next.add(activeTabId);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [activeTabId, tabs]);

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
    openSaveInActiveTabWithViewportCapture(querySave);
  }, [activeTab?.viewId, openSaveInActiveTabWithViewportCapture, querySave, queryViewId]);

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
      if (nextTab) handleFocusTab(nextTab.id);
    },
  });

  useEffect(() => {
    if (!activeViewId) {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    if (activeViewModel.status === 'ready') {
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
    setCurrentStudySaveSource(null);
    return undefined;
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
      <StudyPageStateShell
        workspace={(
          <StudyStateWorkspace
            testId="study-page-empty"
            dropTargetRef={studyDropTargetRef}
            showDropOverlay={draggingEntry && overStudy}
          >
            저장된 학습뷰를 선택하세요.
          </StudyStateWorkspace>
        )}
      >
        {indicatorPanelOpen && (
          <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
        )}
        {settingsOpen && (
          <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
        )}
      </StudyPageStateShell>
    );
  }

  if (isStudyPageLoading && !selectedSave && tabs.length === 0) {
    return (
      <StudyPageStateShell
        workspace={(
          <StudyStateWorkspace
            testId="study-page-loading"
            dropTargetRef={studyDropTargetRef}
            showDropOverlay={draggingEntry && overStudy}
          >
            학습뷰 불러오는 중...
          </StudyStateWorkspace>
        )}
      >
        {indicatorPanelOpen && (
          <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
        )}
        {settingsOpen && (
          <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
        )}
      </StudyPageStateShell>
    );
  }

  if ((!selectedSave && !isStudyPageLoading) || isErrorActiveView) {
    return (
      <StudyPageStateShell
        workspace={(
          <StudyStateWorkspace
            testId="study-page-error"
            tone="error"
            dropTargetRef={studyDropTargetRef}
            showDropOverlay={draggingEntry && overStudy}
          >
            학습뷰를 찾을 수 없습니다.
          </StudyStateWorkspace>
        )}
      >
        {indicatorPanelOpen && (
          <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
        )}
        {settingsOpen && (
          <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
        )}
      </StudyPageStateShell>
    );
  }

  const headerLabel = selectedSave?.label ?? activeTab?.label ?? '학습뷰';
  const headerCode = selectedSave?.code ?? activeTab?.code ?? '';
  const headerTimeframe = selectedTimeframe ?? selectedSave?.timeframe ?? activeTab?.timeframe ?? null;
  const headerKindLabel = selectedSave ? studyViewKindLabel(selectedSave) : '복기뷰';
  const activeViewTimeframe = activeViewModel.status === 'ready' ? activeViewModel.save.timeframe : null;
  const activeTabViewport =
    activeTab?.viewId === activeViewId && activeTab.timeframe === activeViewTimeframe
      ? activeTab.viewport
      : null;
  const canUseSavedViewport =
    activeViewModel.status === 'ready' &&
    activeViewModel.save.timeframe === selectedSave?.timeframe;
  const restoreViewport = activeViewModel.status === 'ready'
    ? activeTabViewport
      ? {
          rightEdgeMs: activeTabViewport.rightEdgeMs,
          barSpan: activeTabViewport.barSpan,
          ...(activeTabViewport.rightOffset !== undefined ? { rightOffset: activeTabViewport.rightOffset } : {}),
          atLiveEdge: activeTabViewport.atLiveEdge,
          ...(activeTabViewport.userAdjusted !== undefined ? { userAdjusted: activeTabViewport.userAdjusted } : {}),
        }
      : canUseSavedViewport
        ? {
            rightEdgeMs: activeViewModel.save.viewport.right_edge_ms,
            barSpan: activeViewModel.save.viewport.bar_span,
            atLiveEdge: activeViewModel.save.viewport.at_live_edge,
          }
        : null
    : null;

  return (
    <PageContainer className="min-h-0">
      <PanelCard data-testid="study-page-primary" className="flex h-full min-h-0 flex-col overflow-hidden">
        <WorkspaceRoot testId="study-page" className="grid flex-1 grid-rows-[auto_auto_minmax(0,1fr)] bg-transparent">
          {tabs.length > 0 && (
            <div className="min-w-0 border-b border-[var(--border)]">
              <StudyTabBar
                tabs={tabs}
                activeTabId={activeTabId}
                activeLoading={isStudyPageLoading}
                tabStatuses={warmTabStatuses}
                onFocus={handleFocusTab}
                onClose={handleCloseTab}
                onReorder={reorderTabs}
                onNewTab={() => {}}
              />
            </div>
          )}
          <WorkspaceHeader className="min-h-12 px-4">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{headerLabel}</div>
              <div className="text-xs text-[var(--fg-dimmer)]">
                {headerCode} · {headerTimeframe ?? '-'} · {headerKindLabel}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerTimeframe && (
                <TimeframeControl
                  timeframe={headerTimeframe}
                  rememberedMinute={rememberedMinuteTimeframe}
                  onChange={changeTimeframe}
                />
              )}
              <LiveChartActionButtons
                onOpenIndicators={() => setIndicatorPanelOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
              />
              <IconToolbarButton onClick={() => setIsMemoOpen((value) => !value)} className="shrink-0">
                메모
              </IconToolbarButton>
            </div>
          </WorkspaceHeader>
          <div
            ref={studyDropTargetRef}
            data-testid="study-drop-target"
            className="relative grid min-h-0 grid-cols-[minmax(0,1fr)_var(--sidebar-w)]"
            onWheelCapture={handleWheelCapture}
          >
            <div className="min-h-0 min-w-0 overflow-hidden">
              {isStudyPageLoading ? (
                <div data-testid="study-page-loading" className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
                  학습뷰 불러오는 중...
                </div>
              ) : activeViewModel.status === 'ready' ? (
                <LiveChartRoot
                  code={activeViewModel.save.code}
                  timeframe={activeViewModel.save.timeframe}
                  viewIdentity={activeTabId ? `${activeTabId}:${activeViewId}:${activeViewModel.save.timeframe}` : `${activeViewId}:${activeViewModel.save.timeframe}`}
                  bundle={activeViewModel.bundle}
                  chartBundle={activeViewModel.chartBundle}
                  clampEngaged={false}
                  isPastCandlesLoading={false}
                  isExtending={false}
                  pastDataWarnings={activeViewModel.pastDataWarnings}
                  restoreViewport={restoreViewport}
                  dayAskPeaks={activeViewModel.bundle.ask_peaks}
                  dayBidPeaks={activeViewModel.bundle.bid_peaks}
                  todayKst={activeViewModel.save.range.to_date}
                  tradeVolumePocs={tradeVolumePocsFromWire(activeViewModel.bundle.trade_volume_pocs)}
                  forceHogaPanes
                  onViewportCaptureReady={handleViewportCaptureReady}
                  onCursorActiveChange={setIsCursorActive}
                />
              ) : null}
            </div>
            <aside
              ref={detailPanelScrollRef}
              role="complementary"
              aria-label="Study Detail Panel"
              data-testid={selectedSave ? studyReferenceDetailPanelTestId(selectedSave) : undefined}
              className="relative z-10 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-y-auto overflow-x-hidden border-l border-[var(--border)] bg-bg-subtle/40"
              style={{ scrollbarGutter: 'stable' }}
            >
              {activeViewModel.status === 'ready' && (
                <StudyReferenceDetailPanel
                  save={activeViewModel.save}
                  bundle={activeViewModel.bundle}
                  isCursorActive={isCursorActive}
                />
              )}
              {isMemoOpen && selectedSave && (
                <StudyMemoPanel
                  memo={selectedSave.memo}
                  isSaving={mutations.updateMetadata.isPending}
                  errorMessage={memoError}
                  onClose={() => setIsMemoOpen(false)}
                  onCommit={commitMemo}
                />
              )}
            </aside>
            {draggingEntry && overStudy && <StudyDropOverlay />}
          </div>
          {indicatorPanelOpen && (
            <IndicatorPanel onClose={() => setIndicatorPanelOpen(false)} />
          )}
          {settingsOpen && (
            <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
          )}
        </WorkspaceRoot>
      </PanelCard>
    </PageContainer>
  );
}

export default StudyPage;

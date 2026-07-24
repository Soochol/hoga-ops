import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { PageContainer } from '../layout/PageContainer';
import IndicatorPanel from '../live/indicators/IndicatorPanel';
import { LiveChartRoot } from '../live/LiveChartRoot';
import LiveSettingsModal from '../live/LiveSettingsModal';
import { ChartDrawingShell } from '../live/ChartDrawingShell';
import { DrawingMenu } from '../live/DrawingMenu';
import { TimeframeControl } from '../live/TimeframeControl';
import { IndicatorsButton, SettingsButton } from '../live/LiveToolbar';
import { tradeVolumePocsFromWire } from '../live/tradeVolumePocWire';
import type { TabViewport } from '../live/viewportAnchor';
import { useEntryDragStore } from '../state/entryDrag';
import { useStudyTabsStore } from '../state/studyTabs';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { isMinuteTimeframe, useLivePageStore, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';
import { useStudyLastMinuteTimeframeStore } from '../state/studyLastMinuteTimeframe';
import { StudyWorkspaceCanvas, StudyWindowAddMenu } from './StudyWorkspaceCanvas';
import { StudyWindowListMenu } from './StudyWindowListMenu';
import { requestWorkspaceTidy } from '../workspace/workspaceCanvasControls';
import { StudyTabBar } from './StudyTabBar';
import { useStudyKeyboard } from './useStudyKeyboard';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';
import { useStudyRangeCacheEviction } from './useStudyRangeCacheEviction';
import { useWarmStudyReferenceTabQueries } from './useWarmStudyReferenceTabQueries';
import {
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
} from './studyViewVariant';
import { studyActiveViewModel } from './studyActiveViewModel';
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
  const [viewTimeframes, setViewTimeframes] = useState<Record<string, LiveTimeframe>>({});
  const [rememberedMinuteTimeframes, setRememberedMinuteTimeframes] = useState<Record<string, MinuteTimeframe>>({});
  const [activatedStudyTabIds, setActivatedStudyTabIds] = useState<Set<string>>(() => new Set());
  const savesQuery = useStudyViews();
  const mutations = useStudyViewMutations();
  // 메모 = 창(ADR-0123) — aside 동거 시절의 "접힘 자동 펼침" 결합이 사라진다.
  // 버튼은 토글 유지: 메모 창이 있으면 닫고, 없으면 연다.
  const toggleMemoWindow = useCallback(() => {
    const workspace = useStudyWorkspaceStore.getState();
    const memoWindow = workspace.windows.find((w) => w.kind === 'memo');
    if (memoWindow) workspace.closeWindow(memoWindow.id);
    else workspace.addWindow('memo');
  }, []);
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
  const toggleTabPinned = useStudyTabsStore((state) => state.toggleTabPinned);
  const updateTabTimeframe = useStudyTabsStore((state) => state.updateTabTimeframe);
  const setLastMinuteTimeframe = useStudyLastMinuteTimeframeStore((state) => state.setLastMinuteTimeframe);
  const updateTabViewport = useStudyTabsStore((state) => state.updateTabViewport);
  const initialQueryViewIdRef = useRef(queryViewId);
  const handledQueryViewIdRef = useRef(queryViewId);
  const routeSyncPendingRef = useRef(false);
  const studyDropTargetRef = useRef<HTMLDivElement>(null);
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
  // 탭이 이 뷰를 들고 있으면 tab.timeframe이 렌더 시점 SSOT다. viewTimeframes는
  // effect로 한 커밋 늦게 동기화되므로, 그걸 먼저 읽으면 "열 때 기본 시간봉"
  // override로 연 첫 렌더가 save.timeframe으로 range 번들(수십 MB)을 한 벌
  // 더 fetch한다. viewTimeframes는 탭 없는 라우트 과도기 전용 폴백.
  const selectedTimeframe = activeViewId && referenceSave
    ? (activeTab?.viewId === activeViewId ? activeTab.timeframe : undefined)
      ?? viewTimeframes[activeViewId]
      ?? referenceSave.timeframe
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
  const indicatorPanelTimeframe = activeViewModel.status === 'ready'
    ? activeViewModel.save.timeframe
    : activeTab?.timeframe ?? selectedTimeframe ?? '1m';
  // /study 의 ambient 지표 봉 동기화(PR-A #699) — 활성 뷰의 timeframe 이 지표
  // 설정의 조회 키다. 렌더 중인 차트와 지표 드로어가 같은 값을 쓰므로 이 하나로 충분.
  const setIndicatorTimeframe = useLivePageStore((s) => s.setIndicatorTimeframe);
  useEffect(() => {
    setIndicatorTimeframe(indicatorPanelTimeframe);
  }, [setIndicatorTimeframe, indicatorPanelTimeframe]);
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
  });
  useStudyRangeCacheEviction(tabs);
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
      // 저장뷰 "설정된 분봉" 열기가 참조하는 전역 마지막 분봉. D/W/M 전환 땐 유지.
      setLastMinuteTimeframe(next);
    }
    if (activeTab && activeTab.viewId === activeViewId) {
      updateTabTimeframe(activeTab.id, next);
    }
  }, [activeTab, activeViewId, updateTabTimeframe, setLastMinuteTimeframe]);

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
    onNextTab: () => {
      if (!tabs.length) return;
      const activeIdx = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
      handleFocusTab(tabs[(activeIdx + 1) % tabs.length].id);
    },
    onPrevTab: () => {
      if (!tabs.length) return;
      const activeIdx = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
      handleFocusTab(tabs[(activeIdx - 1 + tabs.length) % tabs.length].id);
    },
  });

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
          <IndicatorPanel
            onClose={() => setIndicatorPanelOpen(false)}
            timeframe={indicatorPanelTimeframe}
          />
        )}
        {settingsOpen && (
          <LiveSettingsModal variant="study" onClose={() => setSettingsOpen(false)} />
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
          <IndicatorPanel
            onClose={() => setIndicatorPanelOpen(false)}
            timeframe={indicatorPanelTimeframe}
          />
        )}
        {settingsOpen && (
          <LiveSettingsModal variant="study" onClose={() => setSettingsOpen(false)} />
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
          <IndicatorPanel
            onClose={() => setIndicatorPanelOpen(false)}
            timeframe={indicatorPanelTimeframe}
          />
        )}
        {settingsOpen && (
          <LiveSettingsModal variant="study" onClose={() => setSettingsOpen(false)} />
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
          atLiveEdge: activeTabViewport.atLiveEdge,
          ...(activeTabViewport.rightPaddingBars !== undefined ? { rightPaddingBars: activeTabViewport.rightPaddingBars } : {}),
          ...(activeTabViewport.userAdjusted !== undefined ? { userAdjusted: activeTabViewport.userAdjusted } : {}),
        }
      : canUseSavedViewport
        ? {
            rightEdgeMs: activeViewModel.save.viewport.right_edge_ms,
            barSpan: activeViewModel.save.viewport.bar_span,
            atLiveEdge: activeViewModel.save.viewport.at_live_edge,
            ...(activeViewModel.save.viewport.right_padding_bars !== undefined && activeViewModel.save.viewport.right_padding_bars !== null
              ? { rightPaddingBars: activeViewModel.save.viewport.right_padding_bars }
              : {}),
          }
        : null
    : null;

  return (
    // bottom 여백만 제거(!pb-0) — 차트가 화면 하단까지 붙는다. 좌·우·상 p-md 는 유지.
    <PageContainer className="min-h-0 !pb-0">
      {/* 부유 카드 모델(2026-07-15, /live 통일) — 바깥 PanelCard 프레임 제거. 탭 바·헤더는
          --bg full-bleed 크롬이 되고, 차트·상세는 --bg 필드 위에 gap+shadow 로 떠 있는
          카드 2장이 된다. 분리는 톤+간격(gap+shadow-panel)이 담당(보더 없음). */}
      <div data-testid="study-page-primary" className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
        <div data-testid="study-page" className="grid flex-1 min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
          {tabs.length > 0 && (
            <div className="min-w-0">
              <StudyTabBar
                background="var(--bg)"
                tabs={tabs}
                activeTabId={activeTabId}
                activeLoading={isStudyPageLoading}
                tabStatuses={warmTabStatuses}
                onFocus={handleFocusTab}
                onClose={handleCloseTab}
                onReorder={reorderTabs}
                onTogglePin={toggleTabPinned}
                onNewTab={() => {}}
              />
            </div>
          )}
          <div className="flex items-center gap-3 min-h-12 px-3 bg-bg-card">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{headerLabel}</div>
              <div className="flex items-center gap-2 text-xs text-[var(--fg-dimmer)]">
                <span className="truncate">
                  {headerCode} · {headerTimeframe ?? '-'} · {headerKindLabel}
                </span>
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
              {/* 레일 폐기(#760)로 그리기가 툴바에 합류. /study 는 창 개념이
                  없어 봉·액션이 원래 한 툴바에 있었으므로 겉보기는 그대로다. */}
              {headerTimeframe && activeViewModel.status === 'ready' && (
                <DrawingMenu
                  code={activeViewModel.save.code}
                  timeframe={activeViewModel.save.timeframe}
                />
              )}
              <IndicatorsButton onClick={() => setIndicatorPanelOpen(true)} />
              <SettingsButton onClick={() => setSettingsOpen(true)} />
              <StudyWindowListMenu />
              <StudyWindowAddMenu />
              <IconToolbarButton
                data-testid="study-tidy"
                onClick={requestWorkspaceTidy}
                className="shrink-0"
              >
                정리
              </IconToolbarButton>
              <IconToolbarButton onClick={toggleMemoWindow} className="shrink-0">
                메모
              </IconToolbarButton>
            </div>
          </div>
          <div
            ref={studyDropTargetRef}
            data-testid="study-drop-target"
            className="relative min-h-0 px-1 pt-1"
          >
            {/* 창 워크스페이스(ADR-0123) — 배치는 studyWorkspace 스토어, 콘텐츠는
                활성 저장뷰(탭 = 콘텐츠 선택자). 구 2열 grid(차트 카드 + 상세 aside)의
                후계. */}
            <div
              data-testid={selectedSave ? studyReferenceDetailPanelTestId(selectedSave) : undefined}
              className="h-full min-h-0"
            >
              <StudyWorkspaceCanvas
                save={activeViewModel.status === 'ready' ? activeViewModel.save : null}
                bundle={activeViewModel.status === 'ready' ? activeViewModel.bundle : null}
                memo={selectedSave
                  ? {
                      memo: selectedSave.memo,
                      isSaving: mutations.updateMetadata.isPending,
                      errorMessage: memoError,
                      onCommit: commitMemo,
                    }
                  : null}
                chartContent={(
                  <div data-testid="study-chart-card" className="relative h-full min-h-0 min-w-0 overflow-hidden">
                    {isStudyPageLoading ? (
                      <div data-testid="study-page-loading" className="flex h-full items-center justify-center text-sm text-[var(--fg-dimmer)]">
                        학습뷰 불러오는 중...
                      </div>
                    ) : activeViewModel.status === 'ready' ? (
                      <ChartDrawingShell>
                        <LiveChartRoot
                          code={activeViewModel.save.code}
                          timeframe={activeViewModel.save.timeframe}
                          venue={referenceQuery.venue}
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
                          depthHeatmap={activeViewModel.bundle.depth_heatmap}
                          forceHogaPanes
                          dailyCandleKisEnabled={false}
                          onViewportCaptureReady={handleViewportCaptureReady}
                        />
                      </ChartDrawingShell>
                    ) : null}
                  </div>
                )}
              />
            </div>
            {draggingEntry && overStudy && <StudyDropOverlay />}
          </div>
          {indicatorPanelOpen && (
            <IndicatorPanel
              onClose={() => setIndicatorPanelOpen(false)}
              timeframe={indicatorPanelTimeframe}
            />
          )}
          {settingsOpen && (
            <LiveSettingsModal variant="study" onClose={() => setSettingsOpen(false)} />
          )}
        </div>
      </div>
    </PageContainer>
  );
}

export default StudyPage;

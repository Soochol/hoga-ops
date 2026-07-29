import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useDrawingToolContextMenuReset } from '../chart/drawing/contextMenuReset';
import { PageContainer } from '../layout/PageContainer';
import LiveSettingsModal from '../live/LiveSettingsModal';
import { SettingsButton } from '../live/LiveToolbar';
import { registerIndicatorDrawerOpener } from '../live/workspace/indicatorDrawerControls';
import { tradeVolumePocsFromWire } from '../live/tradeVolumePocWire';
import type { TabViewport } from '../live/viewportAnchor';
import { useEntryDragStore } from '../state/entryDrag';
import { useStudyTabsStore } from '../state/studyTabs';
import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { isMinuteTimeframe, useLivePageStore, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';
import {
  STUDY_DEFAULT_MINUTE_TIMEFRAME,
  useStudyLastMinuteTimeframeStore,
} from '../state/studyLastMinuteTimeframe';
import { StudyIndicatorDrawer } from './StudyIndicatorDrawer';
import { StudyWorkspaceCanvas, StudyWindowAddMenu } from './StudyWorkspaceCanvas';
import { StudyWindowListMenu } from './StudyWindowListMenu';
import { StudyLayoutPresetMenu } from './presets/StudyLayoutPresetMenu';
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
import {
  DropOverlay,
  IconToolbarButton,
  WorkspaceHeader,
  WorkspaceRoot,
  WorkspaceState,
  WorkspaceToolbar,
} from '../ui/WorkspaceShell';

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
  // min-h-12(54px)는 WorkspaceHeader 의 인라인 `height: var(--h-live-header)`(36px)를
  // 의도적으로 덮는다 — min-height 가 height 를 이긴다. 아래 식별부가 제목+설명 2줄이라
  // 36px 밴드에 들어가지 않기 때문(#900: "54px 원인은 버튼이 아니라 2줄 식별부").
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

  // 그리기 도구 활성 중 우클릭 = 해제(/live 와 동일 계약). 페이지 단위 1회.
  useDrawingToolContextMenuReset();
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
  // 보조지표 드로어는 /live 와 같은 명령 채널을 쓴다 — 창 헤더 버튼이 **대상 창을
  // 지정**하고(추론 금지) 페이지는 셸만 연다. 두 라우트가 동시에 마운트되지
  // 않으므로 모듈 슬롯 하나를 공유해도 안전하다.
  const [indicatorTargetId, setIndicatorTargetId] = useState<string | null>(null);
  useEffect(() => registerIndicatorDrawerOpener(setIndicatorTargetId), []);
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
  // 봉은 차트 창이 런타임 소유자고 탭은 탭별 저장소다(#902 write-through 거울).
  // v1 은 차트 창 1개 고정(ADR-0123).
  const chartWindowId = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.kind === 'chart')?.id ?? null,
  );
  const setChartTimeframe = useStudyWorkspaceStore((s) => s.setChartTimeframe);
  const chartWindowTimeframe = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.kind === 'chart')?.chart?.timeframe ?? null,
  );
  const chartWindowLastMinute = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.kind === 'chart')?.chart?.lastMinuteTimeframe ?? null,
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
  // 창 봉을 먼저 읽지 않는 이유: 탭을 바꾼 첫 커밋에는 창이 아직 이전 탭의 봉을
  // 들고 있다(재시드가 effect 라 한 커밋 늦다). 그때 창을 읽으면 엉뚱한 봉으로
  // 번들을 한 벌 더 fetch 한다. write-through 로 둘이 같게 유지되므로 탭을 먼저
  // 읽어도 창 소유와 어긋나지 않는다(#902).
  const selectedTimeframe = activeViewId && referenceSave
    ? (activeTab?.viewId === activeViewId ? activeTab.timeframe : undefined)
      ?? chartWindowTimeframe
      ?? viewTimeframes[activeViewId]
      ?? referenceSave.timeframe
    : null;
  // 창별 분봉 기억이 헤더 컨트롤의 분봉 슬롯을 정한다(#902 — 전역
  // studyLastMinuteTimeframe 은 서랍 "설정된 분봉으로 열기" 용으로 따로 산다).
  const rememberedMinuteTimeframe = chartWindowLastMinute
    ?? (activeViewId && referenceSave
      ? rememberedMinuteTimeframes[activeViewId]
        ?? (isMinuteTimeframe(referenceSave.timeframe) ? referenceSave.timeframe : '1m')
      : STUDY_DEFAULT_MINUTE_TIMEFRAME);
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
  /**
   * 봉 전환 — 창이 소유하고 활성 탭에 **즉시 되받아쓴다**(#902 write-through).
   *
   * 이탈 시 캡처(뷰포트 방식)로는 부족하다: 탭 라벨에 봉이 박혀 있고 그 라벨은
   * 비활성 탭에서도 보이므로, 지연 반영하면 활성 탭 라벨이 창 봉과 어긋난 채
   * 노출된다. 봉은 문자열 하나라 상시 쓰기 비용도 없다.
   */
  const changeTimeframe = useCallback((next: LiveTimeframe) => {
    if (chartWindowId) setChartTimeframe(chartWindowId, next);
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
  }, [activeTab, activeViewId, chartWindowId, setChartTimeframe, updateTabTimeframe, setLastMinuteTimeframe]);

  /**
   * 탭 재활성 시 창을 탭 값으로 **재시드**한다 — 탭 A(일봉)→B→A 로 돌아오면
   * 일봉이 유지되는 이유(#902). 창이 이미 같은 봉이면 스토어가 no-op 이 아니라
   * 백필 런타임을 건드리므로 여기서 먼저 걸러낸다.
   */
  useEffect(() => {
    if (!chartWindowId || !selectedTimeframe) return;
    if (chartWindowTimeframe === selectedTimeframe) return;
    setChartTimeframe(chartWindowId, selectedTimeframe);
  }, [chartWindowId, chartWindowTimeframe, selectedTimeframe, setChartTimeframe]);

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
        {settingsOpen && (
          <LiveSettingsModal variant="study" onClose={() => setSettingsOpen(false)} />
        )}
      </StudyPageStateShell>
    );
  }

  const headerLabel = selectedSave?.label ?? activeTab?.label ?? '학습뷰';
  const headerCode = selectedSave?.code ?? activeTab?.code ?? '';
  const headerKindLabel = selectedSave ? studyViewKindLabel(selectedSave) : '복기뷰';
  const activeViewTimeframe = activeViewModel.status === 'ready' ? activeViewModel.save.timeframe : null;
  // 가드의 실체는 "봉 전환 과도기에 옛 봉 번들 위로 새 봉 뷰포트가 새는 것" 차단이라
  // 우변은 **로드된 번들의 봉** 그대로다. 좌변만 창 봉으로 바꾼다(#902) —
  // selectedTimeframe 이 곧 창 봉이다(write-through 로 탭과 동치).
  const activeTabViewport =
    activeTab?.viewId === activeViewId && selectedTimeframe === activeViewTimeframe
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
          {/* 봉·그리기·보조지표가 차트 창 헤더로 내려간 뒤 남는 줄(#903).
              2줄 식별부를 한 줄로 눕히고 `WorkspaceToolbar`(36px 고정)를 쓴다 —
              54px 을 만들던 건 버튼이 아니라 2줄 식별부였다. `· 5m` 은 뺐다:
              창 헤더가 보여주고 탭 라벨에도 남아 손실이 없고, 멀티창에서
              "어느 창의 봉인가" 라는 답 없는 질문을 만들지 않는다. */}
          <WorkspaceToolbar testId="study-page-toolbar">
            <div className="min-w-0 truncate text-xs">
              <span className="font-semibold text-fg">{headerLabel}</span>
              <span className="text-[var(--fg-dimmer)]">
                {' '}{headerCode} · {headerKindLabel}
              </span>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <SettingsButton onClick={() => setSettingsOpen(true)} />
              <StudyWindowListMenu />
              <StudyWindowAddMenu />
              <StudyLayoutPresetMenu />
              <IconToolbarButton onClick={toggleMemoWindow} className="shrink-0">
                메모
              </IconToolbarButton>
            </div>
          </WorkspaceToolbar>
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
                chart={{
                  code: activeViewModel.status === 'ready' ? activeViewModel.save.code : null,
                  rememberedMinute: rememberedMinuteTimeframe,
                  onTimeframeChange: changeTimeframe,
                  targetLabel: headerLabel,
                  loading: isStudyPageLoading,
                  chart: activeViewModel.status === 'ready' ? {
                    code: activeViewModel.save.code,
                    timeframe: activeViewModel.save.timeframe,
                    venue: referenceQuery.venue,
                    // 창 id 를 키에 넣는다(#902) — #801 이 창을 늘리는 날 창마다
                    // 독립 리마운트 경계가 따라오게. 봉 세그먼트는 **로드된 번들의
                    // 봉**이라는 현행 의미를 유지한다(전환 과도기 리마운트 지연).
                    viewIdentity: [chartWindowId, activeTabId, activeViewId, activeViewModel.save.timeframe]
                      .filter(Boolean).join(':'),
                    bundle: activeViewModel.bundle,
                    chartBundle: activeViewModel.chartBundle,
                    clampEngaged: false,
                    isPastCandlesLoading: false,
                    isExtending: false,
                    pastDataWarnings: activeViewModel.pastDataWarnings,
                    restoreViewport,
                    dayAskPeaks: activeViewModel.bundle.ask_peaks,
                    dayBidPeaks: activeViewModel.bundle.bid_peaks,
                    todayKst: activeViewModel.save.range.to_date,
                    tradeVolumePocs: tradeVolumePocsFromWire(activeViewModel.bundle.trade_volume_pocs),
                    depthHeatmap: activeViewModel.bundle.depth_heatmap,
                    forceHogaPanes: true,
                    dailyCandleKisEnabled: false,
                    onViewportCaptureReady: handleViewportCaptureReady,
                  } : null,
                }}
              />
            </div>
            {draggingEntry && overStudy && <StudyDropOverlay />}
          </div>
          {indicatorTargetId != null && (
            <StudyIndicatorDrawer
              windowId={indicatorTargetId}
              code={selectedSave?.code ?? null}
              targetLabel={headerLabel}
              onClose={() => setIndicatorTargetId(null)}
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

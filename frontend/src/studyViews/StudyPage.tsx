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
import {
  focusedChartWindowId,
  useStudyWorkspaceStore,
} from '../state/studyWorkspace';
import { resolveIndicatorSettings } from '../state/indicatorSettingsV2';
import { isMinuteTimeframe, useLivePageStore, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';
import {
  STUDY_DEFAULT_MINUTE_TIMEFRAME,
  useStudyLastMinuteTimeframeStore,
} from '../state/studyLastMinuteTimeframe';
import type { StudyChartRootProps } from './StudyChartWindow';
import { StudyIndicatorDrawer } from './StudyIndicatorDrawer';
import { StudyWorkspaceCanvas, StudyWindowAddMenu } from './StudyWorkspaceCanvas';
import { StudyWindowListMenu } from './StudyWindowListMenu';
import { StudyLayoutPresetMenu } from './presets/StudyLayoutPresetMenu';
import { StudyTabBar } from './StudyTabBar';
import { useStudyKeyboard } from './useStudyKeyboard';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import {
  useStudyReferenceBundles,
  type StudyReferenceBundleResult,
} from './useStudyReferenceBundle';
import { useStudyRangeCacheEviction } from './useStudyRangeCacheEviction';
import { useWarmStudyReferenceTabQueries } from './useWarmStudyReferenceTabQueries';
import {
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
} from './studyViewVariant';
import { studyActiveViewModel } from './studyActiveViewModel';
import { studyDailyViewport, studySavedRangeMarks } from './studyDailyContext';
import { STUDY_VENUE } from './studyVenuePolicy';
import { PanelCard, ToolbarButton } from '../ui/PageShell';
import { useRightRailStore } from '../state/rightRail';
import {
  DropOverlay,
  IconToolbarButton,
  WorkspaceHeader,
  WorkspaceRoot,
  WorkspaceState,
  WorkspaceToolbar,
} from '../ui/WorkspaceShell';

/** 포커스 차트 창이 아직 없을 때의 중립값 — 페이지가 "로딩" 으로 읽는다. */
const EMPTY_BUNDLE_RESULT: StudyReferenceBundleResult = {
  bundle: null,
  chartBundle: null,
  isLoading: true,
  isSidecarLoading: false,
  error: null,
  sidecarError: null,
  pastDataWarnings: [],
  venue: STUDY_VENUE,
  displayedSave: null,
  dailyContext: null,
};

function StudyDropOverlay() {
  return <DropOverlay>여기에 놓아 학습뷰 열기</DropOverlay>;
}

function StudySearchHeader({
  label = '학습뷰',
  description = '저장된 복기뷰를 선택하세요',
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
        <div className="text-xs text-fg-dim">{description}</div>
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
  // 봉은 차트 창이 **유일한 소유자**고 탭은 그 라벨이다(#1326). 창이 여러 개면
  // (#801) **포커스된 창**이 탭과 거울을 이룬다 — 탭 라벨에 봉이 박혀 있으므로
  // "지금 보고 있는 창" 하나만 라벨을 쓸 수 있다.
  const chartWindowId = useStudyWorkspaceStore(focusedChartWindowId);
  const setChartTimeframe = useStudyWorkspaceStore((s) => s.setChartTimeframe);
  const chartWindowTimeframe = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === focusedChartWindowId(s))?.chart?.timeframe ?? null,
  );
  const chartWindowLastMinute = useStudyWorkspaceStore(
    (s) => s.windows.find((w) => w.id === focusedChartWindowId(s))?.chart?.lastMinuteTimeframe ?? null,
  );
  // 스토어의 `windows` 를 그대로 구독한다 — 셀렉터에서 미리 접으면 매 렌더 새 배열이
  // 나와 구독이 항상 깨진다. 접기는 아래 `chartWindowSpecs` 에서 한다.
  const workspaceWindows = useStudyWorkspaceStore((s) => s.windows);
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
  /**
   * 탭 재시드가 아직 안 끝난 창인가 — **탭 값이 창 값을 이기는 유일한 구간**이다.
   *
   * 탭을 바꾼 첫 커밋에는 창이 아직 이전 탭의 봉을 들고 있다(재시드가 effect 라 한
   * 커밋 늦다). 그때 창을 읽으면 엉뚱한 봉으로 번들(수십 MB)을 한 벌 더 fetch 한다.
   * 그래서 그 한 커밋 동안만 탭을 먼저 읽는다.
   *
   * ⚠ 이 구간을 "탭이 이 뷰를 들고 있으면 항상" 으로 넓히면 **창 포커스만 옮겨도
   * 탭이 들고 있는 봉이 그 창을 덮어쓴다**(#801 후속 버그). 탭 timeframe 은 포커스
   * 창의 거울이지 전 창의 명령이 아니다.
   */
  const tabSeedKey = `${activeTabId ?? ''}:${activeViewId ?? ''}`;
  const seededTabKeyRef = useRef<string | null>(null);
  /**
   * 지금 화면이 서 있는 봉 — **창이 유일한 소유자다**(#1326).
   *
   * 뒤의 폴백 사슬은 창이 아직 없거나(하이드레이션 전) 탭 없는 라우트로 들어온
   * 과도기에만 닿는다. 저장뷰의 봉(`referenceSave.timeframe`)은 사슬의 **맨 끝**이라
   * 열린 창이 하나라도 있으면 절대 이기지 못한다 — 그게 이 페이지의 계약이다.
   */
  const selectedTimeframe = activeViewId && referenceSave
    ? chartWindowTimeframe
      ?? (activeTab?.viewId === activeViewId ? activeTab.timeframe : undefined)
      ?? viewTimeframes[activeViewId]
      ?? referenceSave.timeframe
    : null;
  // 창별 분봉 기억이 헤더 컨트롤의 분봉 슬롯을 정한다(#902).
  const rememberedMinuteTimeframe = chartWindowLastMinute
    ?? (activeViewId && referenceSave
      ? rememberedMinuteTimeframes[activeViewId]
        ?? (isMinuteTimeframe(referenceSave.timeframe) ? referenceSave.timeframe : '1m')
      : STUDY_DEFAULT_MINUTE_TIMEFRAME);
  const indicatorsByTimeframe = useLivePageStore((s) => s.indicatorsByTimeframe);
  // 번들을 요구하는 창 목록 — 봉·지표가 곧 쿼리 키다(#904).
  //
  // **포커스 창만 `selectedTimeframe` 을 쓴다**: 탭을 바꾼 첫 커밋에는 창이 아직
  // 이전 탭의 봉을 들고 있고(재시드가 effect 라 한 커밋 늦다), 그때 창 값을 그대로
  // 쓰면 엉뚱한 봉으로 번들을 한 벌 더 fetch 한다(#902 의 그 함정). 나머지 창은
  // 자기 봉 그대로여야 멀티 타임프레임 배치가 유지된다.
  //
  // 창을 드래그하기만 해도 이 배열이 새로 만들어지지만 **쿼리 키는 그대로**라
  // 재fetch 는 나지 않는다(react-query 는 키로 판정한다).
  const chartWindowSpecs = useMemo(
    () => workspaceWindows
      .filter((w) => w.kind === 'chart')
      .map((w) => {
        const timeframe = w.id === chartWindowId && selectedTimeframe
          ? selectedTimeframe
          : w.chart?.timeframe ?? STUDY_DEFAULT_MINUTE_TIMEFRAME;
        return {
          windowId: w.id,
          timeframe,
          // 지표는 앱 전역 1세트 — 창마다 갈리는 것은 봉(=어느 버킷인가)뿐이다.
          indicators: resolveIndicatorSettings(indicatorsByTimeframe, timeframe),
        };
      }),
    [chartWindowId, selectedTimeframe, workspaceWindows, indicatorsByTimeframe],
  );
  const displayedReferenceSave = useMemo(
    () => referenceSave && selectedTimeframe
      ? { ...referenceSave, timeframe: selectedTimeframe }
      : null,
    [referenceSave, selectedTimeframe],
  );
  // 창마다 번들 한 벌(#801). 같은 봉·지표 창끼리는 쿼리 키가 같아 dedupe 된다.
  const bundlesByWindow = useStudyReferenceBundles(referenceSave, chartWindowSpecs);
  // 페이지 상태(로딩·에러·상세창 데이터)는 **포커스된 창**을 따른다 — 비포커스 창의
  // 에러가 페이지를 백지로 만들면 안 되고, 상세창은 커서를 주는 창과 같은 번들을
  // 봐야 한다.
  const referenceQuery = useMemo(
    () => (chartWindowId ? bundlesByWindow[chartWindowId] : undefined) ?? EMPTY_BUNDLE_RESULT,
    [bundlesByWindow, chartWindowId],
  );
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
  // 로딩·에러 구간의 폴백도 **창을 먼저 읽는다**(#1326) — 봉의 소유자가 창이므로
  // 탭을 먼저 읽으면 아직 되받아쓰기 전인 저장 봉이 지표 버킷으로 새어 나간다.
  const indicatorPanelTimeframe = activeViewModel.status === 'ready'
    ? activeViewModel.save.timeframe
    : selectedTimeframe ?? activeTab?.timeframe ?? '1m';
  // /study 의 ambient 지표 봉 동기화(PR-A #699) — 활성 뷰의 timeframe 이 지표
  // 설정의 조회 키다. 렌더 중인 차트와 지표 드로어가 같은 값을 쓰므로 이 하나로 충분.
  const setIndicatorTimeframe = useLivePageStore((s) => s.setIndicatorTimeframe);
  useEffect(() => {
    setIndicatorTimeframe(indicatorPanelTimeframe);
  }, [setIndicatorTimeframe, indicatorPanelTimeframe]);
  // 창별 뷰포트 캡처 함수 등록소(#801). 단일 ref 로 두면 창이 여러 개일 때
  // **마지막에 마운트된 창이 이긴다** — 탭이 저장하는 뷰포트가 보고 있던 창의 것이
  // 아니게 되고, 증상은 "탭을 돌아오면 엉뚱한 줌"으로 한참 뒤에 나타난다.
  const captureViewportRefs = useRef<Map<string, () => TabViewport | null>>(new Map());
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overStudy = useEntryDragStore((s) => s.overStudy);
  const registerStudyTarget = useEntryDragStore((s) => s.registerStudyTarget);
  const clearStudyTarget = useEntryDragStore((s) => s.clearStudyTarget);
  const warmTabStatuses = useWarmStudyReferenceTabQueries({
    tabs,
    activeTabId,
    activatedTabIds,
    saves: savesQuery.data?.saves ?? [],
    // 탭을 눌러도 창 봉이 안 바뀌므로 **활성 전환의 실제 쿼리 키는 창 봉**이다.
    // 비활성 탭이 든 저장 봉으로 워밍하면 받아 놓고 버리는 번들이 된다.
    warmTimeframe: chartWindowTimeframe,
  });
  // 축출은 (종목 × 봉)이다(#801) — 창이 여러 개면 같은 종목 아래 봉별 번들이 쌓인다.
  useStudyRangeCacheEviction(
    tabs,
    referenceSave?.code ?? null,
    chartWindowSpecs.map((w) => w.timeframe),
  );
  const registerViewportCapture = useCallback(
    (windowId: string, capture: () => TabViewport | null) => {
      captureViewportRefs.current.set(windowId, capture);
    },
    [],
  );
  // 탭이 들고 가는 뷰포트는 **포커스된 차트 창**의 것이다 — 탭 뷰포트는 한 벌이고
  // 탭 라벨의 봉도 포커스 창을 따르므로, 둘이 같은 창을 봐야 복원이 어긋나지 않는다.
  const captureActiveTabViewport = useCallback(() => {
    if (!activeTabId || !chartWindowId) return;
    const viewport = captureViewportRefs.current.get(chartWindowId)?.();
    if (!viewport) return;
    updateTabViewport(activeTabId, viewport);
  }, [activeTabId, chartWindowId, updateTabViewport]);
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
        onError: (error) => setMemoError(error instanceof Error ? error.message : '메모 저장에 실패했습니다'),
      },
    );
  }, [activeViewId, mutations.updateMetadata, selectedSave?.memo]);
  /**
   * 봉 전환 — 창이 소유하고 활성 탭에 **즉시 되받아쓴다**(#902 write-through).
   *
   * 이탈 시 캡처(뷰포트 방식)로는 부족하다: 탭 라벨에 봉이 박혀 있고 그 라벨은
   * 비활성 탭에서도 보이므로, 지연 반영하면 활성 탭 라벨이 창 봉과 어긋난 채
   * 노출된다. 봉은 문자열 하나라 상시 쓰기 비용도 없다.
   *
   * 창이 여러 개면(#801) 봉을 바꾼 **그 창**이 대상이고, 탭·전역 기억으로의
   * write-through 는 **포커스 창일 때만** 일어난다. 비포커스 창의 봉이 탭 라벨을
   * 갈아치우면 "안 만진 창 때문에 라벨이 바뀐다" 가 된다.
   */
  const changeTimeframe = useCallback((windowId: string, next: LiveTimeframe) => {
    setChartTimeframe(windowId, next);
    if (!activeViewId || windowId !== chartWindowId) return;
    setViewTimeframes((current) => ({ ...current, [activeViewId]: next }));
    if (isMinuteTimeframe(next)) {
      setRememberedMinuteTimeframes((current) => ({ ...current, [activeViewId]: next }));
      // 새 차트 창의 분봉 시드가 참조하는 전역 마지막 분봉(#906). D/W/M 전환 땐 유지.
      setLastMinuteTimeframe(next);
    }
    if (activeTab && activeTab.viewId === activeViewId) {
      updateTabTimeframe(activeTab.id, next);
    }
  }, [activeTab, activeViewId, chartWindowId, setChartTimeframe, updateTabTimeframe, setLastMinuteTimeframe]);

  /**
   * 탭/뷰가 바뀌면 **탭 라벨을 창 봉으로 되받아쓴다** — 거울의 방향이 여기다(#1326).
   *
   * 여기 있던 것은 반대 방향이었다: 탭이 든 봉으로 **창을 재시드**했다(#902). 그
   * 계약은 저장뷰가 봉을 정한다는 전제 위에 서 있었고, 창이 여럿이 되자(#801) 그
   * 전제가 배치를 무너뜨렸다 — "일봉+분봉으로 벌려 놨는데 저장뷰를 누르니 둘 다
   * 분봉". #1295 가 완화("요구 봉을 이미 띄운 창이 있으면 포커스만 이동")를 넣었지만
   * 봉이 **정확히** 일치할 때만 걸려서, `D` + `3m` 배치에 `1m` 저장뷰가 오면 그대로
   * 덮였다. 그래서 소유권 자체를 창으로 옮겼다.
   *
   * 이제 탭의 `timeframe` 은 명령이 아니라 **포커스 창의 라벨**이다. 탭 라벨에 봉이
   * 박혀 있으므로(`… · 5m`) 여기서 되받아쓰지 않으면 라벨이 실제 창과 어긋난 채
   * 노출된다.
   *
   * ⚠ **탭/뷰가 바뀔 때만** 돈다(`tabSeedKey`). 포커스가 바뀌었다는 이유로 돌면
   * 창을 클릭했을 뿐인데 탭 라벨이 흔들린다.
   */
  useEffect(() => {
    if (!chartWindowId || !chartWindowTimeframe) return;
    if (seededTabKeyRef.current === tabSeedKey) return;
    seededTabKeyRef.current = tabSeedKey;
    if (!activeTab || activeTab.viewId !== activeViewId) return;
    if (activeTab.timeframe === chartWindowTimeframe) return;
    updateTabTimeframe(activeTab.id, chartWindowTimeframe);
  }, [
    activeTab,
    activeViewId,
    chartWindowId,
    chartWindowTimeframe,
    tabSeedKey,
    updateTabTimeframe,
  ]);

  /** 닫힌 창의 캡처 함수를 걷어낸다 — 등록소가 죽은 클로저를 붙들고 있지 않게. */
  useEffect(() => {
    const live = new Set(chartWindowSpecs.map((w) => w.windowId));
    for (const id of captureViewportRefs.current.keys()) {
      if (!live.has(id)) captureViewportRefs.current.delete(id);
    }
  }, [chartWindowSpecs]);

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
            {/* 빈 상태 = "한 줄 설명 + 행동 1개" — 저장뷰 드로어가 다음 행동인데
                그 존재를 아는 사용자만 열 수 있었다. 버튼이 드로어를 직접 연다. */}
            <div className="flex flex-col items-center gap-md">
              <span>저장된 학습뷰를 선택하세요</span>
              <ToolbarButton
                tone="secondary"
                className="border border-border-strong"
                onClick={() => useRightRailStore.getState().setActivePanel('savedViews')}
              >
                저장뷰 열기
              </ToolbarButton>
            </div>
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
            학습뷰를 찾을 수 없습니다
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
  // 탭 뷰포트는 **포커스 창 하나에만** 적용된다(#801). 탭은 뷰포트를 한 벌만
  // 들고 있고 그건 캡처한 창의 것이므로, 다른 봉을 보는 창에 씌우면 엉뚱한 줌이 된다.
  // 봉 일치 조건은 기존 그대로 — "봉 전환 과도기에 옛 봉 번들 위로 새 봉 뷰포트가
  // 새는 것" 차단이 그 술어의 실체다(#902).
  const activeViewTimeframe = activeViewModel.status === 'ready' ? activeViewModel.save.timeframe : null;
  const focusedTabViewport =
    activeTab?.viewId === activeViewId && selectedTimeframe === activeViewTimeframe
      ? activeTab.viewport
      : null;

  // 창별 차트 props. 훅이 아니라 평범한 계산이다 — 위쪽 조기 return 들 뒤라
  // 여기서 훅을 부르면 렌더마다 훅 순서가 갈린다.
  const chartPropsByWindow: Record<string, StudyChartRootProps | null> = {};
  for (const spec of chartWindowSpecs) {
    const result = bundlesByWindow[spec.windowId];
    if (!result) continue;
    const model = studyActiveViewModel({
      selectedSave: result.displayedSave ?? selectedSave,
      reference: result,
    });
    if (model.status !== 'ready') {
      chartPropsByWindow[spec.windowId] = null;
      continue;
    }
    const isFocused = spec.windowId === chartWindowId;
    // 캘린더 봉의 저장 구간 마크 + 그 구간을 화면에 앉히는 초기 뷰포트(#1240).
    // 저장 봉이 분봉이든 일봉이든 **똑같이** `save.range` 를 표시한다.
    const band = result.dailyContext && referenceSave
      ? studySavedRangeMarks(referenceSave, model.chartBundle.candles)
      : null;
    // 맥락 창의 기본 뷰포트가 저장 뷰포트를 이긴다 — 저장 뷰포트는 좁은 창 시절의
    // 값이라 그대로 복원하면 맥락이 도로 사라진다. 탭 뷰포트(사용자가 팬·줌한 결과)는
    // 포커스 창에 한해 그보다 우선한다.
    const bandViewport = band
      ? studyDailyViewport(model.chartBundle.candles, band.fromMs, band.toMs)
      : null;
    const savedViewport =
      isFocused && model.save.timeframe === selectedSave?.timeframe
        ? {
            rightEdgeMs: model.save.viewport.right_edge_ms,
            barSpan: model.save.viewport.bar_span,
            atLiveEdge: model.save.viewport.at_live_edge,
            ...(model.save.viewport.right_padding_bars !== undefined && model.save.viewport.right_padding_bars !== null
              ? { rightPaddingBars: model.save.viewport.right_padding_bars }
              : {}),
          }
        : null;
    const tabViewport = isFocused && focusedTabViewport
      ? {
          rightEdgeMs: focusedTabViewport.rightEdgeMs,
          barSpan: focusedTabViewport.barSpan,
          atLiveEdge: focusedTabViewport.atLiveEdge,
          ...(focusedTabViewport.rightPaddingBars !== undefined ? { rightPaddingBars: focusedTabViewport.rightPaddingBars } : {}),
          ...(focusedTabViewport.userAdjusted !== undefined ? { userAdjusted: focusedTabViewport.userAdjusted } : {}),
        }
      : null;

    chartPropsByWindow[spec.windowId] = {
      code: model.save.code,
      timeframe: model.save.timeframe,
      venue: result.venue,
      // 창 id 가 키에 있어 창마다 독립 리마운트 경계가 선다(#902 가 예고한 자리).
      // 봉 세그먼트는 **로드된 번들의 봉**이라는 현행 의미를 유지한다.
      viewIdentity: [spec.windowId, activeTabId, activeViewId, model.save.timeframe]
        .filter(Boolean).join(':'),
      bundle: model.bundle,
      chartBundle: model.chartBundle,
      clampEngaged: false,
      isPastCandlesLoading: false,
      isExtending: false,
      pastDataWarnings: model.pastDataWarnings,
      restoreViewport: tabViewport ?? bandViewport ?? savedViewport,
      savedRangeBand: band,
      // 옆 분봉 창의 마우스 위치를 이 창(일봉일 때)의 크로스헤어로 받는다.
      cursorSyncCrosshair: true,
      dayAskPeaks: model.bundle.ask_peaks,
      dayBidPeaks: model.bundle.bid_peaks,
      todayKst: model.save.range.to_date,
      tradeVolumePocs: tradeVolumePocsFromWire(model.bundle.trade_volume_pocs),
      depthHeatmap: model.bundle.depth_heatmap,
      forceHogaPanes: true,
      dailyCandleKisEnabled: false,
      onViewportCaptureReady: (capture: () => TabViewport | null) => registerViewportCapture(spec.windowId, capture),
    };
  }

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
              식별부(`종목 코드 · 복기뷰`)는 그 뒤 차트 창 **타이틀바**로 이관했다 —
              `/live` 가 종목 식별을 창 타이틀바(TitleBarSymbolRow)에 두는 것과 같은
              자리다. 그래서 이 줄은 `/live` 툴바처럼 워크스페이스 관리 버튼만
              남고, 버튼은 좌측 정렬(`ml-auto` 없음)로 두 페이지가 같아진다. */}
          <WorkspaceToolbar testId="study-page-toolbar">
            <SettingsButton onClick={() => setSettingsOpen(true)} />
            <StudyWindowListMenu />
            <StudyWindowAddMenu />
            <StudyLayoutPresetMenu />
            <IconToolbarButton onClick={toggleMemoWindow} className="shrink-0">
              메모
            </IconToolbarButton>
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
                symbolLabel={headerLabel}
                symbolCode={headerCode}
                symbolKindLabel={headerKindLabel}
                memo={selectedSave
                  ? {
                      memo: selectedSave.memo,
                      isSaving: mutations.updateMetadata.isPending,
                      errorMessage: memoError,
                      onCommit: commitMemo,
                    }
                  : null}
                chartFor={(windowId) => ({
                  code: activeViewModel.status === 'ready' ? activeViewModel.save.code : null,
                  rememberedMinute: rememberedMinuteTimeframe,
                  onTimeframeChange: changeTimeframe,
                  targetLabel: headerLabel,
                  loading: isStudyPageLoading,
                  chart: chartPropsByWindow[windowId] ?? null,
                  // 사이드카 상태는 **창별**이다(#801: 창마다 번들이 따로다). 페이지
                  // 플래그를 쓰면 포커스 창 것이 옆 창 칩으로 새어 "이 창은 다 왔는데
                  // 불러오는 중" 이 뜬다.
                  sidecarLoading: bundlesByWindow[windowId]?.isSidecarLoading ?? false,
                  sidecarFailed: bundlesByWindow[windowId]?.sidecarError != null,
                })}
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

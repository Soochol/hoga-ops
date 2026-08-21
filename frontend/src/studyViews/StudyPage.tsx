import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useDrawingToolContextMenuReset } from '../chart/drawing/contextMenuReset';
import { registerIndicatorDrawerOpener } from '../live/workspace/indicatorDrawerControls';
import { tradeVolumePocsFromWire } from '../live/tradeVolumePocWire';
import { useEntryDragStore } from '../state/entryDrag';
import {
  activeStudyGroup,
  activeStudyView,
  focusedChartWindowId,
  studyGroupViewFromSave,
  useStudyWorkspaceStore,
  type GroupId,
} from '../state/studyWorkspace';
import { bucketsForScope, resolveIndicatorSettings } from '../state/indicatorSettingsV2';
import { windowScopeKey } from '../live/workspace/windowViewContext';
import { STUDY_WINDOW_WORKSPACE } from './studyWindowWorkspace';
import { isMinuteTimeframe, useLivePageStore, type LiveTimeframe, type MinuteTimeframe } from '../state/livePage';
import {
  resolveIndicatorPanelTimeframe,
  resolveRememberedMinuteTimeframe,
  resolveSelectedTimeframe,
} from './studyTimeframeResolution';
import {
  STUDY_DEFAULT_MINUTE_TIMEFRAME,
  useStudyLastMinuteTimeframeStore,
} from '../state/studyLastMinuteTimeframe';
import type { StudyViewReference } from '../api/studyViews';
import type { StudyChartRootProps } from './StudyChartWindow';
import { StudyIndicatorDrawer } from './StudyIndicatorDrawer';
import { StudyWorkspaceCanvas, StudyWindowAddMenu } from './StudyWorkspaceCanvas';
import { StudyWindowListMenu } from './StudyWindowListMenu';
import { StudyLayoutPresetMenu } from './presets/StudyLayoutPresetMenu';
import { useStudyViewMutations, useStudyViews } from './useStudyViews';
import {
  useStudyReferenceBundles,
  type StudyReferenceBundleResult,
} from './useStudyReferenceBundle';
import { useStudyRangeCacheEviction } from './useStudyRangeCacheEviction';
import {
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
} from './studyViewVariant';
import { studyActiveViewModel } from './studyActiveViewModel';
import { studyDocumentTitle } from './studyDocumentTitle';
import {
  studyDailyViewport,
  studySavedRangeCoverage,
  studySavedRangeMarks,
  type StudySavedRangeCoverageNotice,
} from './studyDailyContext';
import { STUDY_VENUE } from './studyVenuePolicy';
import { useStaticDocumentTitle } from '../util/useDocumentTitle';
import { PanelCard, ToolbarButton } from '../ui/PageShell';
import { useRightRailStore } from '../state/rightRail';
import {
  DropOverlay,
  IconToolbarButton,
  WorkspaceHeader,
  WorkspaceRoot,
  WorkspaceState,
  WorkspaceToolbar,
  WORKSPACE_PAGE_PAD,
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

/** 빈/로딩/에러 상태의 공용 프레임. `children` 슬롯이 있었지만 유일한 사용처가
 *  **상태별로 네 번 렌더되던 설정 모달**이었고, 그 소유권이 `App` 으로 올라가면서
 *  비었다 — 슬롯째 지운다(빈 children 을 넘기는 호출부가 남지 않게). */
function StudyPageStateShell({ workspace }: { workspace: ReactNode }) {
  return (
    // 여백은 성공 경로와 **같은 상수**를 쓴다 — 로딩·에러에서 창 화면으로 넘어갈 때
    // 프레임이 움직이지 않는다(종전엔 `PageContainer` 의 p-md 라 상단이 4px 튀었다).
    <div className={`h-full min-h-0 ${WORKSPACE_PAGE_PAD}`}>
      <PanelCard data-testid="study-page-primary" className="flex h-full min-h-0 flex-col overflow-hidden">
        {workspace}
      </PanelCard>
    </div>
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
  // 설정 관련 코드는 이 페이지에 **없다** — 드로어는 `App` 이 소유하고 진입점은 상단
  // TopNav 「설정」 하나다. 예전엔 레이아웃 분기 넷마다 같은 모달을 렌더했고 툴바 ⚙ 도
  // 있었는데, 둘 다 사라졌다(2026-08-16 · 08-17).
  const [memoError, setMemoError] = useState<string | null>(null);
  // 활성 그룹(=포커스 창의 그룹)이 보는 저장뷰. 페이지 헤더·탭 제목·라우트 sync 가
  // 이 하나를 따른다 — 창이 여럿이어도 "지금 어디에 서 있나" 는 하나여야 한다.
  const activeView = useStudyWorkspaceStore(activeStudyView);
  const activeGroup = useStudyWorkspaceStore(activeStudyGroup);
  const groupViews = useStudyWorkspaceStore((s) => s.groupViews);
  /**
   * 저장뷰를 **활성 그룹에** 연다(ADR-0155 — 드로어의 `openStudyView` 와 같은 규칙).
   *
   * 그룹을 렌더 값(`activeGroup`)이 아니라 `getState()` 로 읽는 이유: 이 함수를 부르는
   * 셋 다 effect 이고, 포커스가 같은 커밋에서 막 바뀌었을 수 있다. 한 틱 전 그룹에
   * 꽂으면 딥링크가 **엉뚱한 그룹**을 갈아치운다.
   */
  const openSave = useCallback((save: { id: string; code: string; label: string; name: string }) => {
    const workspace = useStudyWorkspaceStore.getState();
    workspace.setGroupView(activeStudyGroup(workspace), studyGroupViewFromSave(save));
  }, []);
  const setLastMinuteTimeframe = useStudyLastMinuteTimeframeStore((state) => state.setLastMinuteTimeframe);
  const initialQueryViewIdRef = useRef(queryViewId);
  const handledQueryViewIdRef = useRef(queryViewId);
  const routeSyncPendingRef = useRef(false);
  const studyDropTargetRef = useRef<HTMLDivElement>(null);
  // 봉은 차트 창이 **유일한 소유자**다(#1326). 창이 여러 개면(#801) **포커스된 창**이
  // 뷰포트 캡처·커서 해석의 기준이 된다.
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
  // 그룹별 포커스 차트를 되짚어야 하므로 zOrder 도 구독한다(데이터 창의 번들 소스).
  const workspaceZOrder = useStudyWorkspaceStore((s) => s.zOrder);
  // 그룹마다 저장뷰를 되짚어야 하므로 목록을 id 로 색인해 둔다(그룹 수만큼 `find` 를
  // 도는 것을 피한다).
  const savesById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof savesQuery.data>['saves'][number]>();
    for (const row of savesQuery.data?.saves ?? []) map.set(row.id, row);
    return map;
  }, [savesQuery.data?.saves]);
  const querySave = useMemo(
    () => savesById.get(queryViewId ?? '') ?? null,
    [queryViewId, savesById],
  );
  const initialQueryPending = initialQueryViewIdRef.current !== null && queryViewId === initialQueryViewIdRef.current;
  const unhandledRouteQuery = queryViewId !== null && queryViewId !== handledQueryViewIdRef.current;
  /**
   * 쿼리가 가리키는 저장뷰가 **아직 어느 그룹에도 안 들어갔다** — 딥링크가 도착했지만
   * `setGroupView` 가 아직 반영되지 않은 프레임.
   *
   * 그룹 도입 전에는 이 자리가 그냥 `?? queryViewId` 였다: 활성 뷰가 없으면 쿼리를
   * 쓰는 것이 무조건 옳았다(뷰 슬롯이 하나뿐이라 "쿼리가 이미 소비됐다" 는 상태가
   * 곧 "그 뷰가 활성" 이었다). 그룹이 여럿이면 그 전제가 깨진다 — **빈 그룹의 창으로
   * 포커스를 옮기면 URL 의 뷰가 그 그룹으로 새어 들어와** 두 그룹이 같은 것을 그린다
   * (2026-08-21 브라우저 실측: 그룹 2 차트가 그룹 1 의 종목을 그렸다).
   *
   * 판정을 `querySave`(=서버에 실재하는 저장뷰)로 하는 것이 요점이다. 없는 id 를 들고
   * 온 딥링크는 "영영 pending" 이 아니라 **처리 완료**로 다뤄야 아래 라우트 되감기가
   * 종전대로 `/study` 로 정리한다.
   */
  const queryPending = querySave !== null
    && !Object.values(groupViews).some((v) => v?.viewId === querySave.id);
  const activeViewId = initialQueryPending || unhandledRouteQuery
    ? queryViewId
    : activeView?.viewId ?? (queryPending ? queryViewId : null);
  const selectedSave = useMemo(
    () => savesById.get(activeViewId ?? '') ?? null,
    [activeViewId, savesById],
  );
  /**
   * 그룹 → 저장뷰 id. **라우트 쿼리 우선순위는 활성 그룹에만** 적용된다 — `?view=` 는
   * "지금 보고 있는 자리를 이걸로" 라는 뜻이지 모든 그룹을 갈아치우라는 뜻이 아니다.
   * 나머지 그룹은 스토어 값 그대로다.
   */
  const groupViewIdOf = useCallback((group: GroupId): string | null => (
    group === activeGroup ? activeViewId : groupViews[group]?.viewId ?? null
  ), [activeGroup, activeViewId, groupViews]);
  // 탭 제목의 소유자는 이 페이지다(`App` 의 PAGE_OWNED_TITLE_ROUTES) — nav 라벨
  // 「복기」 대신 **종목명 + 저장뷰 이름**이 뜬다. 아래 조기 return 셋(빈·로딩·에러)
  // 보다 **위에서** 불러야 상태에 따라 훅 순서가 갈리지 않는다.
  useStaticDocumentTitle(studyDocumentTitle(selectedSave, activeView));
  const referenceSave = referenceStudyView(selectedSave);
  /**
   * 지금 화면이 서 있는 봉 — **창이 유일한 소유자다**(#1326).
   *
   * 뒤의 폴백 사슬은 창이 아직 없는(하이드레이션 전) 과도기에만 닿는다. 저장뷰의
   * 봉(`referenceSave.timeframe`)은 사슬의 **맨 끝**이라 열린 창이 하나라도 있으면
   * 절대 이기지 못한다 — 그게 이 페이지의 계약이다.
   */
  const selectedTimeframe = resolveSelectedTimeframe({
    chartWindowTimeframe,
    activeViewId,
    viewTimeframes,
    savedTimeframe: referenceSave?.timeframe ?? null,
  });
  // 창별 분봉 기억이 헤더 컨트롤의 분봉 슬롯을 정한다(#902).
  const rememberedMinuteTimeframe = resolveRememberedMinuteTimeframe({
    chartWindowLastMinute,
    activeViewId,
    rememberedMinuteTimeframes,
    savedTimeframe: referenceSave?.timeframe ?? null,
  });
  const indicatorsByTimeframe = useLivePageStore((s) => s.indicatorsByTimeframe);
  const studyIndicators = useLivePageStore((s) => s.studyIndicatorsByTimeframe);
  const indicatorsByWindow = useLivePageStore((s) => s.indicatorsByWindow);
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
          group: w.group,
          // 저장뷰도 **창에서** 온다(ADR-0155) — 그룹마다 다를 수 있으므로 훅 인자로
          // 하나를 받아 전 창에 먹이던 구조가 여기서 끝난다.
          save: referenceStudyView(savesById.get(groupViewIdOf(w.group) ?? '')),
          timeframe,
          // 지표는 **그 창의 세트**에서 푼다(ADR-0152 — 없으면 `/study` 페이지 세트).
          // 페이지 세트로 일괄해 풀면 창별로 다르게 켠 지표의 데이터가 번들에 안
          // 실려 그 창에서 **"켰는데 안 보임"** 이 된다.
          indicators: resolveIndicatorSettings(
            bucketsForScope(indicatorsByTimeframe, studyIndicators, indicatorsByWindow, {
              page: 'study',
              windowKey: windowScopeKey(STUDY_WINDOW_WORKSPACE, w.id),
            }),
            timeframe,
          ),
        };
      }),
    [
      chartWindowId, selectedTimeframe, workspaceWindows,
      indicatorsByTimeframe, studyIndicators, indicatorsByWindow,
      savesById, groupViewIdOf,
    ],
  );
  const displayedReferenceSave = useMemo(
    () => referenceSave && selectedTimeframe
      ? { ...referenceSave, timeframe: selectedTimeframe }
      : null,
    [referenceSave, selectedTimeframe],
  );
  // 창마다 번들 한 벌(#801). 같은 저장뷰·봉·지표 창끼리는 쿼리 키가 같아 dedupe 된다 —
  // 그룹 둘이 우연히 같은 뷰를 보고 있어도 요청은 한 벌이다.
  const bundlesByWindow = useStudyReferenceBundles(chartWindowSpecs);
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
  // 로딩·에러 구간의 폴백도 **창을 먼저 읽는다**(#1326) — `selectedTimeframe` 이 이미
  // 창을 사슬 맨 앞에 두므로 그 값을 그대로 태운다.
  const indicatorPanelTimeframe = resolveIndicatorPanelTimeframe({
    readySavedTimeframe: activeViewModel.status === 'ready' ? activeViewModel.save.timeframe : null,
    selectedTimeframe,
  });
  // /study 의 ambient 지표 봉 동기화(PR-A #699) — 활성 뷰의 timeframe 이 지표
  // 설정의 조회 키다. 렌더 중인 차트와 지표 드로어가 같은 값을 쓰므로 이 하나로 충분.
  const setIndicatorTimeframe = useLivePageStore((s) => s.setIndicatorTimeframe);
  useEffect(() => {
    setIndicatorTimeframe(indicatorPanelTimeframe);
  }, [setIndicatorTimeframe, indicatorPanelTimeframe]);
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overStudy = useEntryDragStore((s) => s.overStudy);
  const registerStudyTarget = useEntryDragStore((s) => s.registerStudyTarget);
  const clearStudyTarget = useEntryDragStore((s) => s.clearStudyTarget);
  // 축출은 (종목 × 봉)이다(#801) — 창이 여러 개면 같은 종목 아래 봉별 번들이 쌓인다.
  // 보존 대상은 **어느 그룹이든 지금 보고 있는 종목 전부**다(ADR-0155). 활성 그룹
  // 하나만 남기면 다른 그룹의 번들이 매 포커스 전환마다 축출·재fetch 된다.
  useStudyRangeCacheEviction(
    useMemo(
      () => [...new Set(chartWindowSpecs.map((w) => w.save?.code).filter((c): c is string => !!c))],
      [chartWindowSpecs],
    ),
    chartWindowSpecs.map((w) => w.timeframe),
  );
  /** 메모 저장 — **어느 저장뷰인지 인자로 받는다**(ADR-0155: 메모 창도 그룹에 딸린다).
   *  활성 뷰를 클로저로 가두면 그룹 2 의 메모 창이 그룹 1 의 뷰에 쓴다. */
  const commitMemo = useCallback((viewId: string, current: string, memo: string) => {
    if (memo === current) return;
    setMemoError(null);
    mutations.updateMetadata.mutate(
      { id: viewId, body: { memo } },
      {
        onError: (error) => setMemoError(error instanceof Error ? error.message : '메모 저장에 실패했습니다'),
      },
    );
  }, [mutations.updateMetadata]);
  /**
   * 봉 전환 — **창이 소유한다**(#1326).
   *
   * 창이 여러 개면(#801) 봉을 바꾼 **그 창**이 대상이고, 뷰별·전역 기억으로의 반영은
   * **포커스 창일 때만** 일어난다. 비포커스 창의 봉이 뷰 기억을 갈아치우면 "안 만진
   * 창 때문에 다음에 열 봉이 바뀐다" 가 된다.
   *
   * 여기 있던 탭 라벨 write-through(#902)는 ADR-0149 로 사라졌다 — 탭 칩에 봉이
   * 박혀 있어서(`… · 5m`) 필요했던 거울이고, 칩이 없으면 비출 대상이 없다.
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
  }, [activeViewId, chartWindowId, setChartTimeframe, setLastMinuteTimeframe]);

  /**
   * 최초 진입의 `?view=` 를 활성 뷰로 심는다.
   *
   * **딥링크가 영속된 마지막 뷰를 이긴다** — 이 effect 와 아래 두 개가 그 우선순위를
   * 실현한다. 단일 뷰가 됐다고 가드(`initialQueryViewIdRef`/`handledQueryViewIdRef`/
   * `routeSyncPendingRef`)를 접으면 우선순위가 조용히 뒤집히거나 `navigate(replace)`
   * ↔ effect 핑퐁이 돈다.
   */
  useEffect(() => {
    if (initialQueryViewIdRef.current === null) return;
    if (queryViewId !== initialQueryViewIdRef.current) {
      initialQueryViewIdRef.current = null;
      return;
    }
    if (savesQuery.isLoading) return;
    if (querySave) openSave(querySave);
    initialQueryViewIdRef.current = null;
  }, [openSave, querySave, queryViewId, savesQuery.isLoading]);

  useEffect(() => {
    routeSyncPendingRef.current = false;
    if (initialQueryViewIdRef.current !== null) return;
    if (queryViewId === handledQueryViewIdRef.current) return;
    handledQueryViewIdRef.current = queryViewId;
    if (!querySave) return;
    if (activeView?.viewId === querySave.id) return;
    routeSyncPendingRef.current = true;
    openSave(querySave);
  }, [activeView?.viewId, openSave, querySave, queryViewId]);

  useEffect(() => {
    if (routeSyncPendingRef.current) return;
    if (initialQueryViewIdRef.current !== null) return;
    /**
     * 쿼리가 가리키는 저장뷰가 **아직 어느 그룹에도 반영되기 전이면 되감지 않는다.**
     *
     * 위 두 effect 는 `openSave` 를 부르지만 그 상태는 다음 렌더에나 온다. 같은
     * 커밋에서 이어 도는 이 effect 가 그 사이 값을 보고 URL 을 되감으면 **딥링크가
     * 영속된 마지막 뷰에 덮인다** — `?view=<B>` 로 들어왔는데 지난번에 보던 A 가
     * 열리고, URL 까지 A 로 바뀐다. 증상이 첫 렌더에만 나타나 재현이 어렵다.
     *
     * 술어가 `activeView?.viewId !== querySave.id` 에서 `queryPending` 으로 바뀐 이유:
     * 그룹이 여럿이면 **"활성 뷰가 쿼리와 다르다" 가 정상 상태**다(다른 그룹을 보고
     * 있으면 그렇다). 옛 술어를 두면 그때도 되감기가 막혀 URL 이 옆 그룹의 뷰를 가리킨
     * 채 굳고, 새로고침이 그 뷰를 **엉뚱한 그룹**에 심는다.
     */
    if (queryPending) return;
    if (activeView) {
      if (queryViewId === activeView.viewId) return;
      navigate(`/study?view=${activeView.viewId}`, { replace: true });
      return;
    }
    if (queryViewId !== null) {
      navigate('/study', { replace: true });
    }
  }, [activeView, navigate, queryPending, queryViewId]);

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

  /**
   * 페이지가 빈 상태로 가는 조건은 **어느 그룹에도 저장뷰가 없을 때**다(ADR-0155).
   *
   * 활성 그룹만 보면, 빈 그룹의 창을 클릭했다는 이유만으로 다른 그룹에서 보고 있던
   * 복기뷰가 화면에서 통째로 사라진다. 그룹별 안내는 창이 진다(`viewMissing`).
   */
  const anyGroupHasView = activeViewId !== null
    || Object.values(groupViews).some((v) => v != null);
  if (!anyGroupHasView) {
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
      />
    );
  }

  // 이 게이트에 닿는 유일한 경로는 "영속된 뷰/딥링크는 있는데 saves 가 아직" 이다
  // (`!activeViewId` 는 위에서 이미 걸렸다). 술어를 넓히면 새로고침마다 **전체 페이지**가
  // 로딩으로 교체된다 — 지금은 워크스페이스를 유지한 채 창 내부만 로딩한다.
  // 아래 두 게이트는 **활성 그룹에 뷰가 있을 때만** 판정한다. 그룹 도입 전에는 위
  // 게이트가 그걸 보장했다(`!activeViewId` 면 여기 못 왔다) — 그 불변식을 명시로
  // 되살린다. 빼면 "빈 활성 그룹 + 뷰가 있는 다른 그룹" 에서 페이지가 통째로
  // 로딩/에러가 된다.
  if (activeViewId !== null && isStudyPageLoading && !selectedSave && activeView === null) {
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
      />
    );
  }

  if (activeViewId !== null && ((!selectedSave && !isStudyPageLoading) || isErrorActiveView)) {
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
      />
    );
  }

  // 스토어의 label/code 는 saves 도착 전 한 프레임을 메우는 폴백이다 — 빼면 새로고침
  // 직후가 `'학습뷰'` + 빈 코드로 깜빡인다.
  const headerLabel = selectedSave?.label ?? activeView?.label ?? '학습뷰';

  /**
   * 창 → 그룹. 못 찾으면 활성 그룹으로 떨어진다(창이 막 닫힌 한 프레임).
   *
   * 아래 해석기들은 전부 **훅이 아니라 평범한 함수**다 — 위쪽 조기 return 들 뒤라
   * 훅을 부르면 렌더마다 순서가 갈린다. 신원이 매 렌더 새것이지만 `chartFor` 가
   * 원래부터 인라인 화살표였으므로 `itemCtx` 재생성 축은 늘지 않는다.
   */
  const groupOfWindow = (windowId: string): GroupId =>
    workspaceWindows.find((w) => w.id === windowId)?.group ?? activeGroup;
  const saveRowOfWindow = (windowId: string) =>
    savesById.get(groupViewIdOf(groupOfWindow(windowId)) ?? '') ?? null;
  const viewMissingOfWindow = (windowId: string) =>
    groupViewIdOf(groupOfWindow(windowId)) === null;
  /** 이 창의 그룹에서 데이터·메모 창에 번들을 먹이는 차트 창 = **그 그룹의 포커스 차트**. */
  const groupChartSource = (windowId: string): string | null => focusedChartWindowId(
    { windows: workspaceWindows, zOrder: workspaceZOrder },
    groupOfWindow(windowId),
  );
  /** 차트 창 타이틀바 식별 행. 스토어 값이 뒤에 오는 것은 헤더 폴백과 같은 이유다. */
  const symbolFor = (windowId: string) => {
    const group = groupOfWindow(windowId);
    const viewId = groupViewIdOf(group);
    if (!viewId) return null;
    const row = savesById.get(viewId) ?? null;
    const stored = groupViews[group] ?? null;
    return {
      label: row?.label ?? stored?.label ?? '학습뷰',
      code: row?.code ?? stored?.code ?? '',
      kindLabel: row ? studyViewKindLabel(row) : '복기뷰',
    };
  };

  // 창별 차트 props. 훅이 아니라 평범한 계산이다 — 위쪽 조기 return 들 뒤라
  // 여기서 훅을 부르면 렌더마다 훅 순서가 갈린다.
  const chartPropsByWindow: Record<string, StudyChartRootProps | null> = {};
  /** 창별 "표시 중인 봉으로 덮어쓴 저장뷰" — 데이터 창이 자기 그룹 것을 되짚는다. */
  const modelSaveByWindow: Record<string, StudyViewReference> = {};
  // 저장 구간이 캘린더 봉 코퍼스 밖일 때의 안내. 차트 props 가 아니라 **창 props** 로
  // 간다 — `LiveChartRoot` 에는 저장 구간이라는 개념이 없고(밴드 마크를 받아 그릴
  // 뿐이다), 이 사실은 `/study` 만 안다.
  const savedRangeNoticeByWindow: Record<string, StudySavedRangeCoverageNotice | null> = {};
  for (const spec of chartWindowSpecs) {
    const result = bundlesByWindow[spec.windowId];
    if (!result) continue;
    const model = studyActiveViewModel({
      // 폴백도 **이 창의 그룹** 저장뷰다(ADR-0155) — 활성 뷰로 떨어뜨리면 그룹 2 창이
      // 한 프레임 동안 그룹 1 의 종목을 그린다.
      selectedSave: result.displayedSave ?? spec.save,
      reference: result,
    });
    if (model.status !== 'ready') {
      chartPropsByWindow[spec.windowId] = null;
      continue;
    }
    modelSaveByWindow[spec.windowId] = model.save;
    const isFocused = spec.windowId === chartWindowId;
    // 캘린더 봉의 저장 구간 마크 + 그 구간을 화면에 앉히는 초기 뷰포트(#1240).
    // 저장 봉이 분봉이든 일봉이든 **똑같이** `save.range` 를 표시한다.
    const band = result.dailyContext && spec.save
      ? studySavedRangeMarks(spec.save, model.chartBundle.candles)
      : null;
    // 코퍼스 커버리지 안내는 **밴드와 같은 게이트**를 쓴다(그 함수의 「호출부 의존」
    // 절). 분봉 경로는 캔들이 저장 구간으로 클립돼 있어 판정이 성립하지 않는다.
    savedRangeNoticeByWindow[spec.windowId] = result.dailyContext && spec.save
      ? studySavedRangeCoverage(spec.save, model.chartBundle.candles, model.save.timeframe)
      : null;
    // 맥락 창의 기본 뷰포트가 저장 뷰포트를 이긴다 — 저장 뷰포트는 좁은 창 시절의
    // 값이라 그대로 복원하면 맥락이 도로 사라진다.
    //
    // 사슬 맨 앞에 **탭 뷰포트**(사용자가 팬·줌한 결과를 탭 전환 직전에 캡처한 것)가
    // 하나 더 있었다. ADR-0149 로 사라졌다 — 뷰 슬롯이 하나뿐이면 "이탈 시 캡처 →
    // 복귀 시 복원" 이 성립하지 않는다(캡처한 뷰와 복원 대상이 같다는 보장이 없다).
    // 복기뷰에서는 이쪽이 오히려 옳다: 저장 뷰포트는 사용자가 명시적으로 정한 값이다.
    const bandViewport = band
      ? studyDailyViewport(model.chartBundle.candles, band.fromMs, band.toMs)
      : null;
    const savedViewport =
      isFocused && model.save.timeframe === spec.save?.timeframe
        ? {
            rightEdgeMs: model.save.viewport.right_edge_ms,
            barSpan: model.save.viewport.bar_span,
            atLiveEdge: model.save.viewport.at_live_edge,
            ...(model.save.viewport.right_padding_bars !== undefined && model.save.viewport.right_padding_bars !== null
              ? { rightPaddingBars: model.save.viewport.right_padding_bars }
              : {}),
          }
        : null;

    chartPropsByWindow[spec.windowId] = {
      code: model.save.code,
      timeframe: model.save.timeframe,
      venue: result.venue,
      // 창 id 가 키에 있어 창마다 독립 리마운트 경계가 선다(#902 가 예고한 자리).
      // 봉 세그먼트는 **로드된 번들의 봉**이라는 현행 의미를 유지한다.
      viewIdentity: [spec.windowId, spec.save?.id, model.save.timeframe]
        .filter(Boolean).join(':'),
      bundle: model.bundle,
      chartBundle: model.chartBundle,
      // 미캡처 안내는 **여기서만** 켠다. 저장뷰는 사용자가 구간을 명시적으로 정한
      // 것이라 "그 구간에 아직 안 받은 날이 있다" 가 행동으로 이어지는 정보다.
      // `/live` 는 임의 종목을 훑는 자리라 미캡처가 정상이고, 거기서 켜면 배너가
      // 상시 들어와 진짜 결손이 묻힌다(hogaMissingNotice.ts 의 근거 주석).
      showNotCapturedNotice: true,
      clampEngaged: false,
      isPastCandlesLoading: false,
      // `/study` 는 `historicalFromDate` 를 소비하는 쿼리가 없어 backfill 이 비활성
      // 경로다(캘린더 봉은 전체 히스토리를 한 번에 받는다 — `studyDailyContextWindow`).
      // 최좌단 캔들 왼쪽 여백으로 팬하면 `viewport_backfill_extend` perf 로그 1건이
      // 남지만 inert(fetch 0)이니 백필 디버깅 시그널로 읽지 말 것.
      isExtending: false,
      pastDataWarnings: model.pastDataWarnings,
      restoreViewport: bandViewport ?? savedViewport,
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
    };
  }

  return (
    // 여백 소유자는 `WORKSPACE_PAGE_PAD` 한 곳이다 — `/live` 와 같은 상수를 쓴다
    // (2026-08-17). `PageContainer` 를 떼어낸 이유는 그쪽 기본 `p-md` 가 여백을 두 번째로
    // 소유해 상단이 `/live` 와 8 vs 12 로 갈렸기 때문이다.
    <div className={`h-full min-h-0 ${WORKSPACE_PAGE_PAD}`}>
      {/* 부유 카드 모델(2026-07-15, /live 통일) — 바깥 PanelCard 프레임 제거. 헤더는
          --bg full-bleed 크롬이 되고, 차트·상세는 --bg 필드 위에 gap+shadow 로 떠 있는
          카드 2장이 된다. 분리는 톤+간격(gap+shadow-panel)이 담당(보더 없음).
          저장뷰 탭 스트립이 이 위에 한 줄 더 있었다(ADR-0149 로 제거 — 툴바 + 캔버스 2행). */}
      <div data-testid="study-page-primary" className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-fg">
        <div data-testid="study-page" className="grid flex-1 min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          {/* 봉·그리기·보조지표가 차트 창 헤더로 내려간 뒤 남는 줄(#903).
              식별부(`종목 코드 · 복기뷰`)는 그 뒤 차트 창 **타이틀바**로 이관했다 —
              `/live` 가 종목 식별을 창 타이틀바(TitleBarSymbolRow)에 두는 것과 같은
              자리다. 그래서 이 줄은 `/live` 툴바처럼 워크스페이스 관리 버튼만
              남고, 버튼은 좌측 정렬(`ml-auto` 없음)로 두 페이지가 같아진다. */}
          <WorkspaceToolbar testId="study-page-toolbar">
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
            // 여백 없음 — 캔버스가 이 칸을 그대로 쓴다. 종전엔 `px-1 pt-1`(#806 의 `p-1`
            // 잔여)이 페이지 패딩 위에 4px 링을 더 얹어 `/live` 보다 캔버스가 8×8 작았다.
            className="relative min-h-0"
          >
            {/* 창 워크스페이스(ADR-0123) — 배치는 studyWorkspace 스토어, 콘텐츠는
                활성 저장뷰(탭 = 콘텐츠 선택자). 구 2열 grid(차트 카드 + 상세 aside)의
                후계. */}
            <div
              data-testid={selectedSave ? studyReferenceDetailPanelTestId(selectedSave) : undefined}
              className="h-full min-h-0"
            >
              <StudyWorkspaceCanvas
                // 데이터·메모 창은 **자기 그룹의 포커스 차트 창** 번들을 먹는다(ADR-0155).
                saveFor={(windowId) => {
                  const sourceId = groupChartSource(windowId);
                  return sourceId ? modelSaveByWindow[sourceId] ?? null : null;
                }}
                bundleFor={(windowId) => {
                  const sourceId = groupChartSource(windowId);
                  return sourceId ? chartPropsByWindow[sourceId]?.bundle ?? null : null;
                }}
                viewMissing={viewMissingOfWindow}
                groupHasChart={(windowId) => groupChartSource(windowId) !== null}
                symbolFor={symbolFor}
                memoFor={(windowId) => {
                  const row = saveRowOfWindow(windowId);
                  if (!row) return null;
                  return {
                    memo: row.memo,
                    isSaving: mutations.updateMetadata.isPending,
                    errorMessage: memoError,
                    // 저장 대상을 **값으로 묶는다** — 활성 뷰를 클로저로 가두면 그룹 2 의
                    // 메모 창이 그룹 1 의 뷰에 쓴다.
                    onCommit: (text: string) => commitMemo(row.id, row.memo, text),
                  };
                }}
                chartFor={(windowId) => ({
                  code: modelSaveByWindow[windowId]?.code ?? null,
                  rememberedMinute: rememberedMinuteTimeframe,
                  onTimeframeChange: changeTimeframe,
                  targetLabel: symbolFor(windowId)?.label ?? null,
                  // 페이지 게이트가 아니라 **목록 도착 여부**만 본다 — 창별 준비 상태는
                  // 아래 `chart === null` 이 이미 표현한다. 페이지 플래그를 쓰면 활성
                  // 그룹의 로딩이 다른 그룹 창까지 덮는다.
                  loading: savesQuery.isLoading,
                  viewMissing: viewMissingOfWindow(windowId),
                  chart: chartPropsByWindow[windowId] ?? null,
                  // 사이드카 상태는 **창별**이다(#801: 창마다 번들이 따로다). 페이지
                  // 플래그를 쓰면 포커스 창 것이 옆 창 칩으로 새어 "이 창은 다 왔는데
                  // 불러오는 중" 이 뜬다.
                  sidecarLoading: bundlesByWindow[windowId]?.isSidecarLoading ?? false,
                  sidecarFailed: bundlesByWindow[windowId]?.sidecarError != null,
                  savedRangeNotice: savedRangeNoticeByWindow[windowId] ?? null,
                })}
              />
            </div>
            {draggingEntry && overStudy && <StudyDropOverlay />}
          </div>
          {indicatorTargetId != null && (
            <StudyIndicatorDrawer
              windowId={indicatorTargetId}
              // 드로어는 **버튼을 누른 창**을 대상으로 연다(추론 금지) — 대상이 정해져
              // 있으므로 종목·이름도 그 창의 그룹에서 푼다.
              code={saveRowOfWindow(indicatorTargetId)?.code ?? null}
              targetLabel={symbolFor(indicatorTargetId)?.label ?? headerLabel}
              onClose={() => setIndicatorTargetId(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default StudyPage;

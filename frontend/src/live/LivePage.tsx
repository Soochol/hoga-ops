import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { activeGroupOf, useWorkspaceStore, type GroupSymbol } from '../state/workspace';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveStatusProjection } from './liveStatusProjection';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveStateBanner } from './LiveStateBanner';
import { activateLiveCode, activateLiveInstrument, mirrorActiveGroupToLivePage } from './liveNavigate';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLiveVenueStore } from '../state/liveVenue';
import { LiveStudyViewSaveButton } from '../studyViews/LiveStudyViewSaveButton';
import LiveSettingsModal from './LiveSettingsModal';
import { SingleCodeCollectDialog } from '../heatmap/CollectDialog';
import { useSymbols } from '../capture/useSymbols';
import { useDocumentTitle } from '../util/useDocumentTitle';
import { indexInstrument, isLiveIndexId } from './liveInstrument';
import { WorkspaceCanvas } from './workspace/WorkspaceCanvas';
import { WorkspaceLiveToolbar } from './workspace/WorkspaceLiveToolbar';
import {
  WorkspaceIndicatorDrawer,
  targetChartWindow,
  useFocusedChartWindowView,
} from './workspace/WorkspaceIndicatorDrawer';
import { WindowViewContext } from './workspace/windowView';
import { useLiveWindowStatus } from './workspace/liveWindowStatusSource';

/**
 * /live page — 멀티창 워크스페이스 셸 (ADR-0119 C2c-2d 플립).
 *
 * Four-row grid (symbol search lives in the global TopNav header line):
 *   1. LiveStateBanner (auto)                  — empty/error state matrix
 *   2. LiveStatusBar   (var(--h-pricestrip))   — 포커스 차트 창 발행 채널 구독
 *   3. WorkspaceLiveToolbar (auto)             — 창 추가·정리·지표·설정·수집·저장뷰·프리셋
 *   4. WorkspaceCanvas (1fr)                   — 창들(차트·데이터) + 자석 스냅 엔진
 *
 * 종목 SSOT = 워크스페이스 **활성 그룹**(#711): 검색·관심종목·딥링크가
 * `setGroupSymbol(활성 그룹)` 으로 교체하고(liveNavigate), 레거시 읽기 15곳이
 * 보는 `useLivePageStore.activeCode` 는 단방향 미러 effect 가 동기화한다
 * (workspace→livePage, ADR-0119 호환층). 데이터 파이프라인은 각 차트 창 안
 * (`ChartWindowInner`)에서 돌고, 셸은 발행 채널로 상태바만 받는다.
 */
/**
 * 상태바 전용 발행 구독 호스트 — 구독을 LivePage 에 두면 발행(창 파이프라인) →
 * LivePage 재렌더 → 캔버스(발행자) 재렌더 → 재발행의 피드백 루프가 생긴다
 * (파이프라인 산출물 일부는 렌더마다 identity 가 바뀔 수 있음). 구독을 이
 * 리프에 격리하면 발행은 상태바만 다시 그린다.
 */
function WorkspaceStatusBar({ fallbackCode, captureHealth, venue }: {
  fallbackCode: string | null;
  captureHealth: Parameters<typeof LiveStatusBar>[0]['captureHealth'];
  venue: Parameters<typeof LiveStatusBar>[0]['venue'];
}) {
  const windowStatus = useLiveWindowStatus();
  return (
    <LiveStatusBar
      activeCode={windowStatus?.workareaCode ?? fallbackCode}
      captureHealth={captureHealth}
      bundle={windowStatus?.bundle ?? null}
      venue={venue}
      hogaGapDates={windowStatus?.hogaGapDates}
      liveTradePrice={windowStatus?.liveTradePrice}
      isExtending={windowStatus?.isExtending ?? false}
    />
  );
}

export function LivePage() {
  const [params] = useSearchParams();
  const queryCode = params.get('code');
  const queryIndex = params.get('index');

  // 1회 시드: URL ?code=/?index= 딥링크는 활성 그룹 종목을 그 종목으로 교체한다.
  // 딥링크가 없으면 live.workspace.v1 의 groupSymbols 복원이 그대로 화면이 된다
  // (구 live.page.v1 복원 분기는 폐지 — 워크스페이스가 종목 SSOT).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (queryCode) { activateLiveCode(queryCode); return; }
    if (isLiveIndexId(queryIndex)) activateLiveInstrument(indexInstrument(queryIndex, queryIndex));
  }, [queryCode, queryIndex]);

  const { data: status } = useLiveStatus();
  const liveStatus = useLiveStatusProjection(status);
  const banner = liveStatus.banner;
  const liveVenue = useLiveVenueStore((s) => s.venue);

  // 활성 그룹 종목 + 포커스 차트 창 tf — 미러·수집·타이틀·상태바 폴백의 원천.
  const activeSymbol: GroupSymbol | null = useWorkspaceStore(
    (s) => s.groupSymbols[activeGroupOf(s)] ?? null,
  );
  const focusedChartTf = useWorkspaceStore(
    (s) => targetChartWindow(s.windows, s.zOrder)?.chart?.timeframe,
  );

  // 레거시 미러(ADR-0119 호환층): 활성 그룹 종목·포커스 봉 → livePage. 관심종목
  // 하트·검색 하이라이트·/study 왕복 상태가 플립 후에도 활성 그룹을 본다.
  // 단방향(workspace→livePage) + 동등 비교 no-op 이라 루프 없음 — liveNavigate 의
  // 원자적 이중 쓰기(진입점)와 이 미러(포커스 전환)가 같은 상태로 수렴한다.
  useEffect(() => {
    mirrorActiveGroupToLivePage(
      activeSymbol,
      focusedChartTf ?? useLivePageStore.getState().candleTimeframe,
    );
  }, [activeSymbol, focusedChartTf]);

  const activeStockCode = activeSymbol && activeSymbol.kind !== 'index' ? activeSymbol.code : null;
  useDocumentTitle(activeStockCode);

  const statusFallbackCode = activeSymbol
    ? (activeSymbol.kind === 'index' ? `index:${activeSymbol.code}` : activeSymbol.code)
    : null;

  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 활성 그룹 종목 지난 N일 hogaplay 수집(히트맵 CollectDialog 재사용) — 주식 한정.
  const [collectOpen, setCollectOpen] = useState(false);
  useEffect(() => {
    if (!activeStockCode) setCollectOpen(false);
  }, [activeStockCode]);
  // 딥링크(?code=) 시드는 name=code 라, 수집 다이얼로그 제목은 상태바와 동일
  // 소스(심볼 마스터)에서 실명을 보강한다.
  const { data: symbolsData } = useSymbols();
  const collectSymbolName = useMemo(
    () => (activeStockCode ? symbolsData?.symbols.find((s) => s.code === activeStockCode)?.name : undefined),
    [symbolsData, activeStockCode],
  );

  // Shift+숫자 = 포커스 차트 창의 timeframe 슬롯(스펙 §2 — 창별 배선).
  useLiveKeyboard({
    onSelectTimeframeShortcut: (slot) => {
      const ws = useWorkspaceStore.getState();
      const target = targetChartWindow(ws.windows, ws.zOrder);
      if (!target?.chart) return;
      const next = slot === 'minute' ? target.chart.lastMinuteTimeframe ?? '1m' : slot;
      ws.setChartTimeframe(target.id, next);
    },
  });

  // 설정 모달도 포커스 차트 창 스코프로 감싼다 — viLimit 등 지표 필드 편집이
  // 드로어와 같은 창을 향하게(#712). 차트 창이 없으면 전역 폴백 그대로.
  const focusedView = useFocusedChartWindowView();

  return (
    <div
      className="h-full grid"
      style={{
        // minmax(0, 1fr) on the canvas row prevents chart canvases' intrinsic
        // size from pushing the row past viewport height.
        gridTemplateRows: 'auto var(--h-pricestrip) auto minmax(0, 1fr)',
      }}
    >
      <LiveStateBanner
        primary={activeSymbol && banner.primary === 'watchlist_empty' ? null : banner.primary}
        stack={banner.stack}
      />
      <WorkspaceStatusBar
        fallbackCode={statusFallbackCode}
        captureHealth={liveStatus.captureHealth}
        venue={liveVenue}
      />
      <WorkspaceLiveToolbar
        onOpenIndicators={() => setIndicatorPanelOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenCollect={activeStockCode ? () => setCollectOpen(true) : undefined}
        studySaveControl={<LiveStudyViewSaveButton />}
      />
      <WorkspaceCanvas />
      {indicatorPanelOpen && (
        <WorkspaceIndicatorDrawer onClose={() => setIndicatorPanelOpen(false)} />
      )}
      {settingsOpen && (
        focusedView ? (
          <WindowViewContext.Provider value={focusedView.view}>
            <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
          </WindowViewContext.Provider>
        ) : (
          <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
        )
      )}
      {collectOpen && activeStockCode && (
        <SingleCodeCollectDialog
          // 다이얼로그가 열린 채 종목이 바뀌면 remount 로 미리보기·기간 상태를 초기화한다.
          key={activeStockCode}
          code={activeStockCode}
          name={collectSymbolName ?? activeSymbol?.name ?? activeStockCode}
          onClose={() => setCollectOpen(false)}
        />
      )}
    </div>
  );
}

export default LivePage;

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { activeGroupOf, useWorkspaceStore, type GroupSymbol } from '../state/workspace';
import { requestWorkspaceTidy } from '../workspace/workspaceCanvasControls';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveStatusProjection } from './liveStatusProjection';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveStateBanner } from './LiveStateBanner';
import { activateLiveCode, activateLiveInstrument, mirrorActiveGroupToLivePage } from './liveNavigate';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLiveVenueStore } from '../state/liveVenue';
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
} from './workspace/WorkspaceIndicatorDrawer';
import { registerIndicatorDrawerOpener } from './workspace/indicatorDrawerControls';
import { registerCollectDialogOpener, type CollectTarget } from './workspace/collectDialogControls';
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
      historicalFromDate={windowStatus?.historicalFromDate ?? null}
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

  // 지표 드로어 = 전역 1개 + **대상 창 id**(#759 결정 3). boolean 이던 시절엔
  // 대상을 z-최상위로 추론했는데, 트리거가 창 헤더로 내려오며 추론이 불필요해졌다.
  const [indicatorTargetId, setIndicatorTargetId] = useState<string | null>(null);
  useEffect(() => registerIndicatorDrawerOpener(setIndicatorTargetId), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 지난 N일 hogaplay 수집(히트맵 CollectDialog 재사용) — 대상 종목은 **차트 창
  // 헤더의 수집 버튼**이 실어 보낸다. 전역 툴바에 있던 시절엔 "활성 그룹의 종목"
  // 이라 다른 종목을 수집하려면 그 창을 먼저 활성화해야 했다.
  const [collectTarget, setCollectTarget] = useState<CollectTarget | null>(null);
  useEffect(() => registerCollectDialogOpener(setCollectTarget), []);
  // 딥링크(?code=) 시드는 name=code 라, 수집 다이얼로그 제목은 상태바와 동일
  // 소스(심볼 마스터)에서 실명을 보강한다.
  const { data: symbolsData } = useSymbols();
  const collectSymbolName = useMemo(
    () => (collectTarget
      ? symbolsData?.symbols.find((s) => s.code === collectTarget.code)?.name ?? collectTarget.name
      : undefined),
    [symbolsData, collectTarget],
  );

  // Shift+숫자 = 포커스 차트 창의 timeframe 슬롯(스펙 §2 — 창별 배선).
  // n = 차트 창 추가·t = 정리·[/] = 포커스 순환(PR-E 창 관리 단축키).
  useLiveKeyboard({
    onSelectTimeframeShortcut: (slot) => {
      const ws = useWorkspaceStore.getState();
      const target = targetChartWindow(ws.windows, ws.zOrder);
      if (!target?.chart) return;
      const next = slot === 'minute' ? target.chart.lastMinuteTimeframe ?? '1m' : slot;
      ws.setChartTimeframe(target.id, next);
    },
    onAddChartWindow: () => useWorkspaceStore.getState().addWindow('chart'),
    onTidy: () => requestWorkspaceTidy(),
    onCycleFocus: (dir) => {
      const ws = useWorkspaceStore.getState();
      // 창 목록(안정 순서)에서 현재 포커스의 다음/이전을 focus. 창 0·1개면 no-op.
      const { windows, zOrder } = ws;
      if (windows.length < 2) return;
      const focusedId = zOrder[zOrder.length - 1];
      const idx = windows.findIndex((w) => w.id === focusedId);
      const base = idx < 0 ? 0 : idx;
      const nextIdx = (base + dir + windows.length) % windows.length;
      ws.focusWindow(windows[nextIdx].id);
    },
  });

  // 드로어 latch 방지(#712 리뷰 #3): 열린 채 대상 창이 닫히면 드로어는 null
  // 렌더로 사라지지만 대상 id 가 남아 이후 유령 재등장한다 — 대상이 사라지면
  // id 도 정리한다. 게이트가 "차트 창 0개" 에서 "내 대상 창이 없어짐" 으로
  // 좁아졌다(#759 결정 5) — 다른 창은 남아 있어도 내 대상이 닫혔으면 닫는다.
  const indicatorTargetAlive = useWorkspaceStore(
    (s) => indicatorTargetId != null && s.windows.some(
      (w) => w.id === indicatorTargetId && w.kind === 'chart',
    ),
  );
  useEffect(() => {
    if (indicatorTargetId != null && !indicatorTargetAlive) setIndicatorTargetId(null);
  }, [indicatorTargetId, indicatorTargetAlive]);

  return (
    <div
      className="h-full grid"
      style={{
        // minmax(0, 1fr) on the canvas row prevents chart canvases' intrinsic
        // size from pushing the row past viewport height.
        gridTemplateRows: 'auto var(--h-pricestrip) auto minmax(0, 1fr)',
        // 열 축도 같은 이유로 명시해야 한다. 비워두면 grid-auto-columns:auto 가 되고,
        // 그 트랙은 가장 넓은 자식의 min-content 폭에서 바닥을 친다. WorkspaceLiveToolbar 와
        // WorkspaceCanvas 는 각자 overflow 로 빠져나가지만 LiveStatusBar 는 그런 탈출구가
        // 없어 트랙을 고정시킨다. 그러면 캔버스가 컨테이너보다 넓게 늘어난 채 App 의
        // <main overflow-hidden> 에 잘린다 — 좁힐수록 차트가 줄지 않고 우측이 사라진다
        // (관심 드로어 연 상태에서 viewport ~815px 부터, 700px 에서 129px 잘림).
        gridTemplateColumns: 'minmax(0, 1fr)',
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
      <WorkspaceLiveToolbar onOpenSettings={() => setSettingsOpen(true)} />
      <WorkspaceCanvas />
      {indicatorTargetId != null && (
        <WorkspaceIndicatorDrawer
          windowId={indicatorTargetId}
          onClose={() => setIndicatorTargetId(null)}
        />
      )}
      {/* 설정 모달은 순수 전역 — 창 Provider 래핑도 key 재마운트도 필요 없다.
          유일한 창 소유 필드였던 VI 선 스타일이 자기 토글 옆(전역 chartPrefs)
          으로 옮겨가면서 이 모달은 앱 설정만 편집한다(#759). */}
      {settingsOpen && <LiveSettingsModal onClose={() => setSettingsOpen(false)} />}
      {collectTarget && (
        <SingleCodeCollectDialog
          // 다이얼로그가 열린 채 종목이 바뀌면 remount 로 미리보기·기간 상태를 초기화한다.
          key={collectTarget.code}
          code={collectTarget.code}
          name={collectSymbolName ?? collectTarget.name}
          onClose={() => setCollectTarget(null)}
        />
      )}
    </div>
  );
}

export default LivePage;

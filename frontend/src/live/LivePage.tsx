import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useDrawingToolContextMenuReset } from '../chart/drawing/contextMenuReset';
import { useLivePageStore } from '../state/livePage';
import { activeGroupOf, useWorkspaceStore, type GroupSymbol } from '../state/workspace';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveStatusProjection } from './liveStatusProjection';
import { LiveStateBanner } from './LiveStateBanner';
import { activateLiveCode, activateLiveInstrument, mirrorActiveGroupToLivePage } from './liveNavigate';
import { useLiveKeyboard } from './useLiveKeyboard';
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
import { liveOpenCodesKey, useLiveRangeCacheEviction } from './useLiveRangeCacheEviction';

/**
 * /live page — 멀티창 워크스페이스 셸 (ADR-0119 C2c-2d 플립).
 *
 * Three-row grid (symbol search lives in the global TopNav header line):
 *   1. LiveStateBanner (auto)                  — empty/error state matrix
 *   2. WorkspaceLiveToolbar (auto)             — 창 추가·프리셋·캡처헬스
 *   3. WorkspaceCanvas (1fr)                   — 창들(차트·데이터) + 자석 스냅 엔진
 *
 * 종목 식별·현재가·등락률·히트맵·경고는 각 차트 창 **타이틀바**(TitleBarSymbolRow)가
 * 소유한다 — 페이지 상태바(LiveStatusBar)는 폐지됐다. 현재가·등락률·히트맵은 타이틀바가
 * code 로 self-fetch 하고, 번들 파생 경고칩만 ChartWindow 가 windowWarnings 채널로
 * 올려 타이틀바가 windowId 로 구독한다(타이틀바가 창 데이터 스코프의 부모라 불가피).
 * 전역인 캡처 헬스만 툴바가 소유한다.
 *
 * 종목 SSOT = 워크스페이스 **활성 그룹**(#711): 검색·관심종목·딥링크가
 * `setGroupSymbol(활성 그룹)` 으로 교체하고(liveNavigate), 레거시 읽기 15곳이
 * 보는 `useLivePageStore.activeCode` 는 단방향 미러 effect 가 동기화한다
 * (workspace→livePage, ADR-0119 호환층). 데이터 파이프라인은 각 차트 창 안
 * (`ChartWindowInner`)에서 돈다.
 */
export function LivePage() {
  const [params] = useSearchParams();
  const queryCode = params.get('code');
  const queryIndex = params.get('index');

  // 그리기 도구 활성 중 우클릭 = 해제. 페이지 단위 1회 — 창·오버레이에 걸면
  // 그 노드 밖(다른 창·워크스페이스 배경·nav)이 전부 사각지대로 남는다.
  useDrawingToolContextMenuReset();

  // 심볼 마스터 = 그룹 종목 실명의 단일 출처. 시드가 캐시를 읽어야 하므로 훅 순서상
  // 시드 effect 보다 먼저 부른다(staleTime 1일이라 재방문이면 대개 이미 따뜻하다).
  const { data: symbolsData } = useSymbols();
  const symbolNameOf = useCallback(
    (code: string) => symbolsData?.symbols.find((s) => s.code === code)?.name,
    [symbolsData],
  );

  // 1회 시드: URL ?code=/?index= 딥링크는 활성 그룹 종목을 그 종목으로 교체한다.
  // 딥링크가 없으면 live.workspace.v1 의 groupSymbols 복원이 그대로 화면이 된다
  // (구 live.page.v1 복원 분기는 폐지 — 워크스페이스가 종목 SSOT).
  //
  // 실명을 심볼 마스터에서 뽑아 넘긴다 — 안 넘기면 activateLiveCode 의 `label ?? code`
  // 폴백이 종목명 자리에 코드를 저장해 창 헤더가 `005930(005930)` 이 된다. 마스터가
  // 아직 로딩 중이면 undefined → 종전대로 코드로 시드되고, 아래 보강 effect 가 응답
  // 도착 시점에 고친다(시드는 1회뿐이라 스스로는 못 되돌아온다).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (queryCode) { activateLiveCode(queryCode, symbolNameOf(queryCode)); return; }
    if (isLiveIndexId(queryIndex)) activateLiveInstrument(indexInstrument(queryIndex, queryIndex));
  }, [queryCode, queryIndex, symbolNameOf]);

  // 실명 보강 — 시드가 놓친 경우 + 검색창의 "6자리 코드 + Enter"(드롭다운이 비어
  // 있을 때만 타는 경로라 마스터 로딩 중에 발화한다) + 이름 없는 드롭이 남긴 값,
  // 그리고 **이미 sessionStorage 에 저장돼 있던 오염된 값**까지 한 곳에서 치유한다.
  // 표시 시점 보강이 아니라 스토어 보강이라 창 헤더·창 목록·지표 드로어·수집 버튼이
  // 전부 같은 실명을 본다.
  useEffect(() => {
    if (!symbolsData) return;
    useWorkspaceStore.getState().backfillSymbolNames(symbolNameOf);
  }, [symbolsData, symbolNameOf]);

  const { data: status } = useLiveStatus();
  const liveStatus = useLiveStatusProjection(status);
  const banner = liveStatus.banner;

  // 활성 그룹 종목 + 포커스 차트 창 tf — 미러·수집·타이틀·상태바 폴백의 원천.
  const activeSymbol: GroupSymbol | null = useWorkspaceStore(
    (s) => s.groupSymbols[activeGroupOf(s)] ?? null,
  );
  const focusedChartTf = useWorkspaceStore(
    (s) => targetChartWindow(s.windows, s.zOrder)?.chart?.timeframe,
  );

  // 열린 창에서 빠진 종목의 /live 캐시 회수 — 장시간 세션 힙 누적 방지.
  // 셀렉터가 문자열을 돌려주므로 창 이동·리사이즈로는 재렌더가 안 난다.
  useLiveRangeCacheEviction(
    useWorkspaceStore((s) => liveOpenCodesKey(s.windows, s.groupSymbols)),
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

  // 지표 드로어 = 전역 1개 + **대상 창 id**(#759 결정 3). boolean 이던 시절엔
  // 대상을 z-최상위로 추론했는데, 트리거가 창 헤더로 내려오며 추론이 불필요해졌다.
  const [indicatorTargetId, setIndicatorTargetId] = useState<string | null>(null);
  useEffect(() => registerIndicatorDrawerOpener(setIndicatorTargetId), []);
  // 설정 드로어는 여기 없다 — 열림 상태도 렌더도 `App` 이 소유하고, 진입점은 상단
  // TopNav 「설정」 하나다(툴바 ⚙ 는 2026-08-17 에 제거). 이 페이지에 남은 트리거는
  // 차트 창의 캔들 빈 상태뿐이고, 그건 `CandleEmptyState` 가 직접 요청을 보낸다.
  // 지난 N일 hogaplay 수집(히트맵 CollectDialog 재사용) — 대상 종목은 **차트 창
  // 헤더의 수집 버튼**이 실어 보낸다. 전역 툴바에 있던 시절엔 "활성 그룹의 종목"
  // 이라 다른 종목을 수집하려면 그 창을 먼저 활성화해야 했다.
  const [collectTarget, setCollectTarget] = useState<CollectTarget | null>(null);
  useEffect(() => registerCollectDialogOpener(setCollectTarget), []);
  // 제목 실명 보강 — 스토어 보강(위 backfillSymbolNames)이 붙은 뒤로는 대개
  // collectTarget.name 이 이미 실명이지만, 심볼 마스터가 아직 안 온 순간에 다이얼로그가
  // 열리면 코드가 실려 온다. 그 창을 메우는 폴백으로 남긴다(같은 출처라 값은 항상 일치).
  const collectSymbolName = useMemo(
    () => (collectTarget ? symbolNameOf(collectTarget.code) ?? collectTarget.name : undefined),
    [symbolNameOf, collectTarget],
  );

  // Shift+숫자 = 포커스 차트 창의 timeframe 슬롯(스펙 §2 — 창별 배선).
  // n = 차트 창 추가·[/] = 포커스 순환(PR-E 창 관리 단축키).
  useLiveKeyboard({
    onSelectTimeframeShortcut: (slot) => {
      const ws = useWorkspaceStore.getState();
      const target = targetChartWindow(ws.windows, ws.zOrder);
      if (!target?.chart) return;
      const next = slot === 'minute' ? target.chart.lastMinuteTimeframe ?? '1m' : slot;
      ws.setChartTimeframe(target.id, next);
    },
    onAddChartWindow: () => useWorkspaceStore.getState().addWindow('chart'),
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
      // /study 통일(2026-07-23): full-bleed → 좌·우 p-md 여백 + 하단 flush(!pb-0).
      // 상단은 밀도 개편으로 pt-sm(9px) — nav 와 시세 스트립 사이 최소 숨.
      // 여백은 그리드 컨테이너에 두므로 트랙(minmax)·캔버스 clamp 는 그대로다.
      className="h-full grid px-md pt-sm !pb-0"
      style={{
        // minmax(0, 1fr) on the canvas row prevents chart canvases' intrinsic
        // size from pushing the row past viewport height. 상태바 폐지로 행이 3개로
        // 줄었다(배너·툴바·캔버스) — 폐지된 시세 스트립 행만큼 차트가 넓어진다.
        gridTemplateRows: 'auto auto minmax(0, 1fr)',
        // 열 축도 명시해야 한다. 비워두면 grid-auto-columns:auto 가 되고, 그 트랙은
        // 가장 넓은 자식의 min-content 폭에서 바닥을 친다. WorkspaceLiveToolbar 와
        // WorkspaceCanvas 는 각자 overflow 로 빠져나가므로 트랙을 minmax(0,1fr) 로
        // 고정해 캔버스가 컨테이너를 넘겨 <main overflow-hidden> 에 잘리는 걸 막는다.
        gridTemplateColumns: 'minmax(0, 1fr)',
      }}
    >
      <LiveStateBanner
        primary={activeSymbol && banner.primary === 'watchlist_empty' ? null : banner.primary}
        stack={banner.stack}
      />
      <WorkspaceLiveToolbar
        captureHealth={liveStatus.captureHealth}
      />
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
      {collectTarget && (
        <SingleCodeCollectDialog
          // 다이얼로그가 열린 채 종목이 바뀌면 remount 로 미리보기·기간 상태를 초기화한다.
          key={collectTarget.code}
          code={collectTarget.code}
          name={collectSymbolName ?? collectTarget.name}
          visibleRange={collectTarget.visibleRange ?? null}
          onClose={() => setCollectTarget(null)}
        />
      )}
    </div>
  );
}

export default LivePage;

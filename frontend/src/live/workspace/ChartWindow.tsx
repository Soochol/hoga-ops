/**
 * ChartWindow — 워크스페이스 차트 창의 실 콘텐츠 (ADR-0119 PR-C2b·C2c-2c).
 *
 * 창의 (group→종목, timeframe, indicators)로 창별 독립 데이터 파이프라인
 * (`useLiveChartData`)을 돌리고 실제 `LiveChartRoot` 를 렌더한다. 여기서 멀티창
 * 시맨틱이 처음 활성화된다.
 *
 * **Provider 경계**: 컴포넌트는 자신이 렌더하는 Provider 의 *바깥*이므로, 훅 호출을
 * Provider 안으로 넣으려면 바깥(`ChartWindow`, Provider 설정)과 안쪽(`ChartWindowInner`,
 * Provider 자식에서 훅 호출)으로 쪼갠다. 안쪽에서 `useWindowView`/`useWindowIndicators`
 * 가 창의 값을 보고, `useLiveChartData` 내부의 `useLiveBundle` 도 같은 컨텍스트라 창의
 * 지표/historicalFromDate 로 페치한다.
 *
 * C2c-2c: 지수 심볼(GroupSymbol.kind='index') 1급 지원 — livePage 시맨틱 미러
 * (view.code=null·instrument=index, 파이프라인의 activeIndexId 분기 재사용).
 * 창 내 봉 컨트롤(TimeframeControl→setChartTimeframe) + 포커스 창의 상태바 발행.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { LiveChartRoot } from '../LiveChartRoot';
import { ChartDrawingShell } from '../ChartDrawingShell';
import ChartErrorBoundary from '../../chart/ChartErrorBoundary';
import { useLiveChartData } from '../useLiveChartData';
import {
  WindowViewContext,
  useWindowView,
  useWindowIndicators,
  type WindowViewValue,
} from './windowView';
import {
  FACTORY_INDICATOR_SETTINGS,
  resolveIndicatorSettings,
} from '../../state/indicatorSettingsV2';
import { indexInstrument, isLiveIndexId, stockInstrument } from '../liveInstrument';
import { useLiveVenueStore } from '../../state/liveVenue';
import {
  groupTargetChartWindow,
  useWorkspaceStore,
  type GroupSymbol,
  type WorkspaceWindow,
} from '../../state/workspace';
import {
  publishGroupChartLink,
  clearGroupChartLink,
  type GroupChartLink,
} from './groupChartLinkSource';
import { TimeframeControl } from '../TimeframeControl';
import { DrawingMenu } from '../DrawingMenu';
import { IndicatorsButton } from '../LiveToolbar';
import { requestIndicatorDrawer } from './indicatorDrawerControls';
import { useChartHeaderFold } from './useChartHeaderCompact';
import {
  publishWindowWarnings,
  clearWindowWarnings,
  type WindowWarnings,
} from './windowWarningsSource';
import type { LiveStudySaveSource } from '../../studyViews/studySaveCommand';
import { LiveStudyViewSaveButton } from '../../studyViews/LiveStudyViewSaveButton';
import { CollectButton } from './CollectButton';
import type { CollectVisibleRange } from './collectDialogControls';
import { unixMsToKSTDate } from '../../util/time';
import { clearWindowFlagLegendValues } from '../indicators/flagLegendValueRegistry';
import type { TabViewport } from '../viewportAnchor';

/** 빈 호가갭 배열 상수 — 경고 발행 동등성 비교가 매 렌더 새 [] 로 깨지지 않게 안정 참조. */
const EMPTY_GAP_DATES: readonly string[] = [];

export function ChartWindow({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  const timeframe = win.chart?.timeframe ?? '1m';
  const byTimeframe = win.chart?.indicators.byTimeframe;
  const resolved = useMemo(
    () => (byTimeframe ? resolveIndicatorSettings(byTimeframe, timeframe) : FACTORY_INDICATOR_SETTINGS),
    [byTimeframe, timeframe],
  );
  // 창별 팬 백필 from-date — 비영속 런타임(#713 뷰포트 비저장, 세션 한정).
  // 좌측 팬이 useHistoricalRangeActions 로 확장하면 이 값이 창의 페치를 re-key 한다.
  const historicalFromDate = useWorkspaceStore(
    (s) => s.chartRuntime[win.id]?.historicalFromDate ?? null,
  );
  const isIndex = symbol?.kind === 'index';
  const view: WindowViewValue = useMemo(
    () => ({
      windowId: win.id,
      group: win.group,
      // 지수는 activeCode=null 시맨틱 미러(전역 instrumentToActiveCode 와 동일) —
      // 수집·WS·드로잉 등 code 게이트가 그대로 동작한다.
      code: isIndex ? null : symbol?.code ?? null,
      timeframe,
      historicalFromDate,
      indicators: resolved,
    }),
    [win.id, win.group, isIndex, symbol?.code, timeframe, historicalFromDate, resolved],
  );

  // 창 닫힘 시 이 창의 flag 레전드 provider 정리(비반응형 모듈 Map — 누수 방지).
  // 오버레이 4종은 자기 effect cleanup 으로도 해제하지만, ratio 의 broker late-entry
  // 는 projector 경로라 언마운트 훅이 없다. 언마운트 cleanup 은 자식 → 부모 순이라
  // 이 정리는 항상 자식들의 해제 뒤에 돌고, 재마운트 시엔 자식 등록이 먼저다.
  useEffect(() => () => clearWindowFlagLegendValues(win.id), [win.id]);

  return (
    <WindowViewContext.Provider value={view}>
      <ChartWindowInner win={win} symbol={symbol} />
    </WindowViewContext.Provider>
  );
}

function ChartWindowInner({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  const view = useWindowView(); // 창의 값(Provider 안)
  const ind = useWindowIndicators();
  const venue = useLiveVenueStore((s) => s.venue);
  // 그룹 차트 링크 발행자 게이트(ADR-0119 PR-D) — 그룹당 하나(z-최상위 차트 창).
  const isGroupLink = useWorkspaceStore(
    (s) => groupTargetChartWindow(s.windows, s.zOrder, win.group)?.id === win.id,
  );
  // 같은 그룹 데이터 창의 sidecar 수요 — 발행 창만 fetch 를 확장한다(중복 fetch 방지).
  const groupNeedsVdist = useWorkspaceStore(
    (s) => s.windows.some((w) => w.group === win.group && w.kind === 'vdist'),
  );
  const groupNeedsProgram = useWorkspaceStore(
    (s) => s.windows.some((w) => w.group === win.group && w.kind === 'program'),
  );
  const sidecarDemands = useMemo(
    () =>
      isGroupLink && (groupNeedsVdist || groupNeedsProgram)
        ? { programTrade: groupNeedsProgram, volumeDistribution: groupNeedsVdist }
        : undefined,
    [isGroupLink, groupNeedsVdist, groupNeedsProgram],
  );
  const setChartTimeframe = useWorkspaceStore((s) => s.setChartTimeframe);
  const rememberedMinute = useWorkspaceStore(
    (s) => s.windows.find((w) => w.id === win.id)?.chart?.lastMinuteTimeframe ?? '1m',
  );
  const investorNetEnabled = ind.foreignNetEnabled || ind.institutionNetEnabled;
  const instrument = useMemo(() => {
    if (!symbol) return null;
    if (symbol.kind === 'index') {
      return isLiveIndexId(symbol.code) ? indexInstrument(symbol.code, symbol.name) : null;
    }
    return stockInstrument(symbol.code, symbol.name);
  }, [symbol]);
  const d = useLiveChartData({
    activeCode: view.code,
    activeInstrument: instrument,
    timeframe: view.timeframe,
    historicalFromDate: view.historicalFromDate,
    venue,
    investorNetEnabled,
    sidecarDemands,
  });

  // 헤더가 좁아지면 액션 라벨을 접는다(#762) — 관측 대상은 컨테이너 폭이라
  // 접힘이 관측값을 되바꾸지 않는다(피드백 루프 없음).
  const headerRef = useRef<HTMLDivElement>(null);
  const headerFold = useChartHeaderFold(headerRef);

  // 저장뷰 캡처용 뷰포트 ref — LiveChartRoot 가 마운트 시 캡처 함수를 공급한다.
  const viewportCaptureRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    viewportCaptureRef.current = capture;
  }, []);

  // 수집 버튼용 '보이는 구간' 스냅샷 — 이 창의 뷰포트에서 양 끝 캔들의 KST 거래일을
  // 읽는다. 저장뷰 캡처와 같은 소스(viewportCaptureRef)라 창별로 정확하다. leftEdgeMs 는
  // 라이브 캡처엔 항상 채워지지만(콜드/빈 차트면 캡처 자체가 null) 없으면 null 로 폴백해
  // 다이얼로그가 칩을 숨긴다. 우측 여백(rightOffset)이 미래로 넘칠 수 있어 end 는 오늘로
  // 클램프한다 — YYYYMMDD 는 사전식 비교가 곧 날짜 순서라 문자열 min 으로 충분.
  const todayKst = d.today;
  const getCollectVisibleRange = useCallback((): CollectVisibleRange | null => {
    const vp = viewportCaptureRef.current();
    if (!vp || vp.leftEdgeMs == null || !Number.isFinite(vp.rightEdgeMs)) return null;
    const startYmd = unixMsToKSTDate(vp.leftEdgeMs);
    const rawEndYmd = unixMsToKSTDate(vp.rightEdgeMs);
    const endYmd = todayKst && rawEndYmd > todayKst ? todayKst : rawEndYmd;
    if (startYmd > endYmd) return null;
    return { startYmd, endYmd };
  }, [todayKst]);

  // 그룹 차트 링크 발행(ADR-0119 PR-D) — 같은 그룹 데이터 창(매물대·프로그램 실
  // 콘텐츠, 10호가·거래원 스팟 모드)이 소비한다. 상태바 발행과 같은 규율: deps 없는
  // effect + 값 동등성 가드(bundle 은 참조 동등성)로 변경시에만 발행 — 발행 구독은
  // 데이터 창 리프에 격리돼 있어 재렌더 루프가 없다(#706 함정).
  const lastLinkRef = useRef<GroupChartLink | null>(null);
  useEffect(() => {
    if (!isGroupLink) return;
    const next: GroupChartLink = {
      windowId: win.id,
      group: win.group,
      code: view.code,
      timeframe: view.timeframe,
      bundle: d.workareaChartBundle ?? d.workareaBundle,
      todayKst: d.today,
      vdist: {
        rangeCount: ind.volumeDistributionRangeCount,
        color: ind.volumeDistributionColor,
        maxColor: ind.volumeDistributionMaxColor,
        hoverCutoffEnabled: ind.volumeDistributionHoverCutoffEnabled,
      },
    };
    const prev = lastLinkRef.current;
    const same = prev !== null
      && prev.windowId === next.windowId
      && prev.group === next.group
      && prev.code === next.code
      && prev.timeframe === next.timeframe
      && prev.bundle === next.bundle
      && prev.todayKst === next.todayKst
      && prev.vdist.rangeCount === next.vdist.rangeCount
      && prev.vdist.color === next.vdist.color
      && prev.vdist.maxColor === next.vdist.maxColor
      && prev.vdist.hoverCutoffEnabled === next.vdist.hoverCutoffEnabled;
    if (!same) {
      lastLinkRef.current = next;
      publishGroupChartLink(next);
    }
  });
  // 링크 철회 — 게이트 이탈·그룹 이동·언마운트 시 자기 발행만 걷는다.
  useEffect(() => {
    if (!isGroupLink) return undefined;
    return () => {
      lastLinkRef.current = null;
      clearGroupChartLink(win.group, win.id);
    };
  }, [isGroupLink, win.group, win.id]);

  // 저장뷰 소스 — 이 창의 것. 헤더 버튼에 직접 넘긴다(전역 1슬롯 발행 폐지).
  // 슬롯 시절엔 z-최상위 창만 발행해서 "어느 창을 저장하나" 를 추론해야 했는데,
  // 버튼이 창 안으로 들어오며 그 추론이 통째로 사라졌다(#759 와 같은 단순화).
  const { liveSaveBundle, activeLabel, capabilities } = d;
  const studySaveSource: LiveStudySaveSource | null = useMemo(() => {
    if (!view.code || !liveSaveBundle || !capabilities.studySave) return null;
    return {
      origin: 'live',
      code: view.code,
      label: activeLabel || view.code,
      timeframe: view.timeframe,
      bundle: liveSaveBundle,
      captureViewport: () => viewportCaptureRef.current(),
    };
  }, [view.code, view.timeframe, liveSaveBundle, activeLabel, capabilities.studySave]);

  // 캔들 레전드 최상단 종목 식별 행 입력(#865 후속). 지수(view.code=null)는 종목
  // 행 없음. 백필 진행 게이트(isExtending·historicalFromDate·segments)는 여기서
  // 타이틀바 종목 행 경고칩(호가 미수집·과거 로딩) 발행 — 번들 파생값은 타이틀바
  // (WindowFrame, 이 창의 부모) 스코프 밖이라 windowWarnings 채널로 올린다. 현재가·
  // 등락률·히트맵은 타이틀바가 code 로 self-fetch 하므로 여기 싣지 않는다. 백필 진행
  // 게이트(extending·historicalFromDate·segments)는 여기서 판정해 결과 날짜만 넘긴다.
  // deps 없는 effect + 동등성 가드로 변경시에만 발행(발행→구독은 타이틀바 리프에
  // 격리돼 재렌더 루프 없음 — #865 liveWindowStatusSource 규율과 동일).
  const extending = d.activeIndexId ? d.indexExtending : d.isExtending;
  const lastWarningsRef = useRef<WindowWarnings | null>(null);
  useEffect(() => {
    const segs = d.workareaBundle?.segments;
    const next: WindowWarnings = {
      hogaGapDates: d.activeIndexId ? EMPTY_GAP_DATES : (d.hogaCoverageGapDates ?? EMPTY_GAP_DATES),
      backfillEarliestDate:
        extending && view.historicalFromDate != null && segs && segs.length > 0
          ? segs[0].date
          : null,
    };
    const prev = lastWarningsRef.current;
    const same = prev !== null
      && prev.backfillEarliestDate === next.backfillEarliestDate
      && prev.hogaGapDates.length === next.hogaGapDates.length
      && prev.hogaGapDates.every((v, i) => v === next.hogaGapDates[i]);
    if (!same) {
      lastWarningsRef.current = next;
      publishWindowWarnings(win.id, next);
    }
  });
  useEffect(() => () => {
    lastWarningsRef.current = null;
    clearWindowWarnings(win.id);
  }, [win.id]);

  if (!instrument) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-xs text-fg-dimmer">
        <span className="font-data">종목 없음 · 그룹 {view.group}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* 창 헤더 — 이 창의 차트 조작 진입로를 모두 소유한다(#758).
          봉은 창 소유(#708)였고, 여기에 그리기(레일 폐기분)와 보조지표가
          합류했다. 설정(⚙)은 편집 값이 앱 전역이라 전역 툴바에 남는다(#759). */}
      <div
        ref={headerRef}
        data-testid="chart-window-header"
        data-compact={headerFold.compactActions ? '' : undefined}
        data-compact-timeframe={headerFold.compactTimeframe ? '' : undefined}
        className="flex shrink-0 items-center gap-1 overflow-hidden bg-bg-card px-1 py-0.5"
      >
        {/* 종목 식별·현재가·경고는 창 타이틀바(TitleBarSymbolRow)로 이관됐다.
            이 헤더는 봉·그리기·보조지표·저장·수집만 소유한다. */}
        {/* 2단계 접힘(#762) — 기능 손실 없이 폭만 줄인다.
            ① 좁아지면 액션 라벨을 접고 아이콘만(요구폭 ~213px)
            ② 더 좁아지면 일·주·월을 분봉 드롭다운에 합친다(~110px)
            창은 MIN_W=160px 까지 좁아지므로 ②가 없으면 다시 잘린다. */}
        <TimeframeControl
          timeframe={view.timeframe}
          rememberedMinute={rememberedMinute}
          onChange={(tf) => setChartTimeframe(win.id, tf)}
          compact={headerFold.compactTimeframe}
        />
        <div className="ml-auto flex items-center gap-0.5">
          <DrawingMenu
            code={d.workareaCode}
            timeframe={view.timeframe}
            showLabel={!headerFold.compactActions}
          />
          <IndicatorsButton
            onClick={() => requestIndicatorDrawer(win.id)}
            showLabel={!headerFold.compactActions}
          />
          <LiveStudyViewSaveButton
            source={studySaveSource}
            showLabel={!headerFold.compactActions}
          />
          {/* 수집 대상은 이 창의 종목 — 지수 창은 코드가 없어 비활성. */}
          <CollectButton
            code={symbol?.kind === 'index' ? null : symbol?.code ?? null}
            name={symbol?.name ?? null}
            showLabel={!headerFold.compactActions}
            getVisibleRange={getCollectVisibleRange}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ChartErrorBoundary>
          <ChartDrawingShell>
            <LiveChartRoot
              code={d.workareaCode}
              timeframe={view.timeframe}
              venue={venue}
              viewIdentity={d.workareaCode ? `${d.workareaCode}:${venue}` : venue}
              bundle={d.workareaBundle}
              chartBundle={d.workareaChartBundle}
              hogaPaneBundle={d.workareaHogaBundle}
              clampEngaged={d.clampEngaged}
              isPastCandlesLoading={d.workareaLoading}
              isHogaLoading={d.activeIndexId ? false : d.isHogaLoading}
              isSidecarLoading={d.activeIndexId ? false : (d.isSidecarLoading || d.isDailyMaLoading)}
              isExtending={d.activeIndexId ? d.indexExtending : d.isExtending}
              indicatorCoverageFromDate={d.activeIndexId ? null : d.indicatorCoverageFromDate}
              rangeWindowFromDate={d.activeIndexId ? null : d.rangeWindowFromDate}
              pastDataWarnings={[...d.workareaDataWarnings]}
              dayAskPeaks={d.dayAskPeaks}
              todayAllPriceAskPeak={d.todayAllPriceAskPeak}
              todayAskPeakInput={d.liveInitial?.ask_peak_today ?? null}
              dayBidPeaks={d.dayBidPeaks}
              todayAllPriceBidPeak={d.todayAllPriceBidPeak}
              todayBidPeakInput={d.liveInitial?.bid_peak_today ?? null}
              liveObSnapshots={d.live.ob}
              liveTradeSnapshots={d.live.trade}
              todayKst={d.today}
              tradeVolumePocs={d.tradeVolumePocs}
              depthHeatmap={(d.workareaChartBundle ?? d.workareaBundle)?.depth_heatmap}
              depthDeltaToday={d.depthDeltaToday}
              onViewportCaptureReady={handleViewportCaptureReady}
              paneTogglesOverride={{ hogaPanes: d.capabilities.hogaPanes }}
            />
          </ChartDrawingShell>
        </ChartErrorBoundary>
      </div>
    </div>
  );
}

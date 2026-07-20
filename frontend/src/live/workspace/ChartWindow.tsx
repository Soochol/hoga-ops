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
  targetChartWindow,
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
import {
  publishLiveWindowStatus,
  clearLiveWindowStatus,
  type LiveWindowStatus,
} from './liveWindowStatusSource';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type LiveStudySaveSource,
} from '../../studyViews/studySaveSource';
import { clearWindowFlagLegendValues } from '../indicators/flagLegendValueRegistry';
import type { TabViewport } from '../viewportAnchor';

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
  // 발행 게이트 = "대상 차트 창"(포커스가 데이터 창이면 z-최상위 차트) — 드로어와
  // 같은 규칙. 엄격 포커스로 걸면 데이터 창 포커스 동안 상태바/저장뷰가 빈다.
  const isTargetChart = useWorkspaceStore(
    (s) => targetChartWindow(s.windows, s.zOrder)?.id === win.id,
  );
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

  // 저장뷰 캡처용 뷰포트 ref — LiveChartRoot 가 마운트 시 캡처 함수를 공급한다.
  const viewportCaptureRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    viewportCaptureRef.current = capture;
  }, []);

  // 포커스 차트 창 = 상태바 발행자(C2c-2c). 파이프라인 산출물 일부(경고·갭 배열)는
  // 렌더마다 새 identity 일 수 있어 deps 로 걸면 발행→구독 재렌더→재발행 루프가
  // 된다 — deps 없는 effect + 값 동등성 가드로 변경시에만 발행한다.
  const { workareaCode, workareaBundle, liveTradePrice, isExtending, indexExtending,
    activeIndexId, hogaCoverageGapDates } = d;
  const lastPublishedRef = useRef<LiveWindowStatus | null>(null);
  useEffect(() => {
    if (!isTargetChart) return;
    const next: LiveWindowStatus = {
      windowId: win.id,
      workareaCode,
      bundle: workareaBundle,
      liveTradePrice: liveTradePrice ?? null,
      isExtending: activeIndexId ? indexExtending : isExtending,
      historicalFromDate: view.historicalFromDate,
      hogaGapDates: activeIndexId ? [] : hogaCoverageGapDates ?? [],
    };
    const prev = lastPublishedRef.current;
    const same = prev !== null
      && prev.windowId === next.windowId
      && prev.workareaCode === next.workareaCode
      && prev.bundle === next.bundle
      && prev.liveTradePrice === next.liveTradePrice
      && prev.isExtending === next.isExtending
      && prev.historicalFromDate === next.historicalFromDate
      && prev.hogaGapDates.length === next.hogaGapDates.length
      && prev.hogaGapDates.every((v, i) => v === next.hogaGapDates[i]);
    if (!same) {
      lastPublishedRef.current = next;
      publishLiveWindowStatus(next);
    }
  });
  // 발행 철회는 대상 이탈/언마운트에서만 — 자기 발행일 때만 걷는다(교체 경합 무해).
  useEffect(() => {
    if (!isTargetChart) return undefined;
    return () => {
      lastPublishedRef.current = null;
      clearLiveWindowStatus(win.id);
    };
  }, [isTargetChart, win.id]);

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

  // 저장뷰 save source — 포커스 차트 창만 발행(전역 1슬롯, 스펙 §2). LivePage 의
  // 기존 발행 effect 를 창으로 이관 — clear 는 자기 source 일 때만(계약 동일).
  const { liveSaveBundle, activeLabel, capabilities } = d;
  useEffect(() => {
    if (!isTargetChart || !view.code || !liveSaveBundle || !capabilities.studySave) {
      return undefined;
    }
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: view.code,
      label: activeLabel || view.code,
      timeframe: view.timeframe,
      bundle: liveSaveBundle,
      captureViewport: () => viewportCaptureRef.current(),
    };
    setCurrentStudySaveSource(source);
    return () => {
      clearCurrentStudySaveSource(source);
    };
  }, [isTargetChart, view.code, view.timeframe, liveSaveBundle, activeLabel, capabilities.studySave]);

  if (!instrument) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-xs text-fg-dimmer">
        <span className="font-mono">종목 없음 · 그룹 {view.group}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* 창별 봉 컨트롤(C2c-2c) — timeframe 은 창 소유(#708), 전역 툴바에서 이전. */}
      <div className="flex shrink-0 items-center border-b border-border bg-bg-card/60 px-1 py-0.5">
        <TimeframeControl
          timeframe={view.timeframe}
          rememberedMinute={rememberedMinute}
          onChange={(tf) => setChartTimeframe(win.id, tf)}
        />
      </div>
      <div className="min-h-0 flex-1">
        <ChartErrorBoundary>
          <ChartDrawingShell code={d.workareaCode} timeframe={view.timeframe}>
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

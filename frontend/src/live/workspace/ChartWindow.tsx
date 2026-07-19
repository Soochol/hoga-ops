/**
 * ChartWindow — 워크스페이스 차트 창의 실 콘텐츠 (ADR-0119 PR-C2b).
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
 * 알려진 한계(C2b 범위): LiveChartRoot 의 **pane 렌더**(어느 지표 pane·paneOrder)는 아직
 * 전역 스토어 직독(#709 cut #7 — 후속 PR). 데이터 페치는 창별이나 pane 표시는 전역 공유.
 */
import { useMemo } from 'react';
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
import { stockInstrument } from '../liveInstrument';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useWorkspaceStore, type GroupSymbol, type WorkspaceWindow } from '../../state/workspace';

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
  const view: WindowViewValue = useMemo(
    () => ({
      windowId: win.id,
      group: win.group,
      code: symbol?.code ?? null,
      timeframe,
      historicalFromDate,
      indicators: resolved,
    }),
    [win.id, win.group, symbol?.code, timeframe, historicalFromDate, resolved],
  );

  return (
    <WindowViewContext.Provider value={view}>
      <ChartWindowInner symbol={symbol} />
    </WindowViewContext.Provider>
  );
}

function ChartWindowInner({ symbol }: { symbol: GroupSymbol | null }) {
  const view = useWindowView(); // 창의 값(Provider 안)
  const ind = useWindowIndicators();
  const venue = useLiveVenueStore((s) => s.venue);
  const investorNetEnabled = ind.foreignNetEnabled || ind.institutionNetEnabled;
  const instrument = useMemo(
    () => (symbol ? stockInstrument(symbol.code, symbol.name) : null),
    [symbol],
  );
  const d = useLiveChartData({
    activeCode: view.code,
    activeInstrument: instrument,
    timeframe: view.timeframe,
    historicalFromDate: view.historicalFromDate,
    venue,
    investorNetEnabled,
  });

  if (!view.code) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-[11px] text-fg-dimmer">
        <span className="font-mono">종목 없음 · 그룹 {view.group}</span>
      </div>
    );
  }

  return (
    <ChartErrorBoundary>
      <ChartDrawingShell>
        <LiveChartRoot
          code={view.code}
          timeframe={view.timeframe}
          venue={venue}
          viewIdentity={`${view.code}:${venue}`}
          bundle={d.workareaBundle}
          chartBundle={d.workareaChartBundle}
          hogaPaneBundle={d.workareaHogaBundle}
          clampEngaged={d.clampEngaged}
          isPastCandlesLoading={d.workareaLoading}
          isHogaLoading={d.isHogaLoading}
          isSidecarLoading={d.isSidecarLoading || d.isDailyMaLoading}
          isExtending={d.isExtending}
          indicatorCoverageFromDate={d.indicatorCoverageFromDate}
          rangeWindowFromDate={d.rangeWindowFromDate}
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
          paneTogglesOverride={{ hogaPanes: d.capabilities.hogaPanes }}
        />
      </ChartDrawingShell>
    </ChartErrorBoundary>
  );
}

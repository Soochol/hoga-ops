import { peakWallInstancePoints } from './peakWallInstancePoints';
import { useActivePrefs } from '../../state/chartPrefs';
import { useMemo } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle, AskPeak, BidPeak } from '../../api/types';
import type { PaneSeriesMap } from '../../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { LiveTimeframe } from '../../state/livePage';
import { isMinuteTimeframe } from '../../state/livePage';
import type { LiveVenueOption } from '../../state/liveVenue';
import { useWindowIndicator, useWindowScopeId } from '../workspace/windowView';
import type { CategoryId } from './IndicatorPanelHelpers';
import MovingAverageOverlay from './MovingAverageOverlay';
import DailyMovingAverageOverlay from './DailyMovingAverageOverlay';
import BollingerOverlay from './BollingerOverlay';
import EnvelopeOverlay from './EnvelopeOverlay';
import SupertrendOverlay from './SupertrendOverlay';
import DepthHeatmapOverlay from '../DepthHeatmapOverlay';
import type { DepthHeatmapPoint } from '../depthHeatmapWire';
import TradeVolumePocOverlay from '../TradeVolumePocOverlay';
import type { TradeSnapshot } from '../bucketHogaSeries';
import QuoteLevelLines from '../QuoteLevelLines';
import { basePaneId } from '../../chart/paneOrder';
import { usePeakDailyMaFilters } from '../peakWallDailyMaFilter';
import { usePeakWallRender } from '../usePeakWallRender';
import LivePeakWallSegments from '../LivePeakWallSegments';
import LivePeakWallDockedLabels from '../LivePeakWallDockedLabels';
import { candleExtremesByVirtualSec } from '../peakWallRankArrows';
import { usePeakWallStepsPublisher } from './peakWallStepsRegistry';
import { usePeakWallCountsPublisher } from './peakWallCountsRegistry';
import type { TradeVolumePoc } from '../tradeVolumePoc';

export type InstanceOverlayProps = {
  adjustFactors?: import('../scaleRangeBundlePrices').AdjustFactors;
  pocs: readonly TradeVolumePoc[]; category: CategoryId; chart: IChartApi; bundle: RangeBundle; liveBundle: RangeBundle; axis: VirtualAxis;
  paneSeries: PaneSeriesMap; code: string | null; timeframe: LiveTimeframe; venue: LiveVenueOption; todayKst: string;
  dayAskPeaks: readonly AskPeak[]; dayBidPeaks: readonly BidPeak[]; liveTradeSnapshots: readonly TradeSnapshot[];
  dailyCandleKisEnabled: boolean; dailyMaWindowFloorDate: string | null; depthHeatmapPoints: readonly DepthHeatmapPoint[];
};
export function IndicatorInstanceOverlays(props: InstanceOverlayProps) {
  const { category, chart, bundle, axis } = props;
  const behindSeries = useActivePrefs(s => s.candleAlwaysOnTop);
  if (category === 'moving-average') return <MovingAverageOverlay chart={chart} bundle={bundle} axis={axis} />;
  if (category === 'bollinger') return <BollingerOverlay chart={chart} bundle={bundle} axis={axis} />;
  if (category === 'envelope') return <EnvelopeOverlay chart={chart} bundle={bundle} axis={axis} />;
  if (category === 'supertrend') return <SupertrendOverlay chart={chart} bundle={bundle} axis={axis} />;
  if (category === 'daily-moving-average') return <DailyMovingAverageOverlay chart={chart} bundle={bundle} axis={axis}
    code={props.code} timeframe={props.timeframe} venue={props.venue} todayKst={props.todayKst}
    dailyCandleKisEnabled={props.dailyCandleKisEnabled} dailyMaWindowFloorDate={props.dailyMaWindowFloorDate} />;
  if (!isMinuteTimeframe(props.timeframe)) return null;
  if (category === 'peak-walls') return <PeakWallInstance {...props} />;
  if (category === 'trade-volume-poc') return <TradeVolumePocOverlay paneSeries={props.paneSeries} axis={axis}
    pocs={props.pocs} behindSeries={behindSeries} candles={bundle.candles} segments={bundle.segments} todayKst={props.todayKst} />;
  if (category === 'depth-heatmap') return <DepthHeatmapOverlay chart={chart} paneSeries={props.paneSeries} axis={axis} points={props.depthHeatmapPoints} />;

  if (category === 'quote-totals' || category === 'ratio') return <InstanceLevelLines {...props} />;
  return null;
}

function InstanceLevelLines({ paneSeries, liveBundle, axis }: InstanceOverlayProps) {
  const scope = useWindowScopeId();
  const id = scope?.split(':indicator:')[1];
  const own = useMemo(() => {
    const map = new Map();
    for (const [name, series] of paneSeries) if (id && name.startsWith(`indicator:${id}:`)) map.set(basePaneId(name), series);
    return map;
  }, [id, paneSeries]);
  return <QuoteLevelLines paneSeries={own} bundle={liveBundle} axis={axis} />;
}

function PeakWallInstance(props: InstanceOverlayProps) {
  const { bundle: cb, axis, todayKst, code, venue, dailyCandleKisEnabled, dailyMaWindowFloorDate } = props;
  const prefPeakWallPaneEnabled = useWindowIndicator(s => s.peakWallPaneEnabled);
  const prefPeakWallPaneMode = useWindowIndicator(s => s.peakWallPaneMode);
  const peakDailyMaInput = { code, venue, todayKst, candles: cb.candles, enabled: true, kisEnabled: dailyCandleKisEnabled, displayFloorDate: dailyMaWindowFloorDate };
  const askPeakDailyMaFilters = usePeakDailyMaFilters({ ...peakDailyMaInput, side: 'ask' });
  const bidPeakDailyMaFilters = usePeakDailyMaFilters({ ...peakDailyMaInput, side: 'bid' });
  const common = { segments: cb.segments, candles: cb.candles, axis, todayKst, applicable: true, needStepSegments: prefPeakWallPaneEnabled };
  const askWall = usePeakWallRender({ ...common, side: 'ask', peaks: props.dayAskPeaks, dailyMaFilters: askPeakDailyMaFilters });
  const bidWall = usePeakWallRender({ ...common, side: 'bid', peaks: props.dayBidPeaks, dailyMaFilters: bidPeakDailyMaFilters });
  const scope = useWindowScopeId();
  const peakWallStepPoints = useMemo(() => peakWallInstancePoints({
    askWall, bidWall, candles: cb.candles, axis,
    mode: prefPeakWallPaneMode, enabled: prefPeakWallPaneEnabled,
  }), [prefPeakWallPaneEnabled, prefPeakWallPaneMode, cb.candles, axis, askWall, bidWall]);

  // 발행은 훅이 쥔다 — **쓰기 조건**(점 배열이 그대로면 쓰지 않는다)이 이 기능의
  // 위험 전부라, 그 조건을 테스트가 잡을 수 있는 자리에 둔다. 종전에 여기서 매 커밋
  // `{ points }` 를 새로 만들어 등록하던 것이 "Maximum update depth exceeded" 의
  // 연료였다(2026-09-01, 덫 실측 20 writes/frame) — 사유는 훅 머리말.
  usePeakWallStepsPublisher(scope, peakWallStepPoints);

  // ── 최대벽 개수 발행 (설정 패널의 깔때기·리드아웃) ────────────────────────
  // deps 계약(원시값 12개)이 이 기능의 성능 위험 전부라, 그 계약을 테스트가 잡을 수
  // 있도록 훅으로 빼 뒀다 — `usePeakWallCountsPublisher` 머리말 참조.
  usePeakWallCountsPublisher(scope, true, {
    'ask-traded': { shown: askWall.tradedShownCount, hiddenByFilter: askWall.tradedHiddenByFilterCount },
    'ask-all': { shown: askWall.allWallShownCount, hiddenByFilter: askWall.allWallHiddenByFilterCount },
    'ask-unreached': { shown: askWall.unreachedShownCount, hiddenByFilter: askWall.unreachedHiddenByFilterCount },
    'bid-traded': { shown: bidWall.tradedShownCount, hiddenByFilter: bidWall.tradedHiddenByFilterCount },
    'bid-all': { shown: bidWall.allWallShownCount, hiddenByFilter: bidWall.allWallHiddenByFilterCount },
    'bid-unreached': { shown: bidWall.unreachedShownCount, hiddenByFilter: bidWall.unreachedHiddenByFilterCount },
  });

  const extremes = useMemo(() => candleExtremesByVirtualSec(cb.candles, axis), [cb.candles, axis]);
  return <>
    <LivePeakWallSegments paneSeries={props.paneSeries} side="ask" wall={askWall} candleExtremes={extremes} />
    <LivePeakWallSegments paneSeries={props.paneSeries} side="bid" wall={bidWall} candleExtremes={extremes} />
    <LivePeakWallDockedLabels paneSeries={props.paneSeries} askWall={askWall} bidWall={bidWall} />
  </>;
}

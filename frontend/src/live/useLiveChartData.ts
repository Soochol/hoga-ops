/**
 * useLiveChartData — /live 차트 데이터 파이프라인 (ADR-0119 PR-C2a).
 *
 * `LivePage` 가 인라인으로 갖고 있던 ~130줄의 데이터 파이프라인(useLiveSeries +
 * useLiveBundle + 지수 번들 + ask/bid peaks + trade-volume POC + liveSaveBundle +
 * workarea 파생)을 **창별 재사용 가능한 훅**으로 추출한다. LivePage 는 활성 뷰의
 * (code, timeframe, historicalFromDate) 로 이 훅을 호출해 기능 무변경을 유지하고,
 * 멀티창의 `ChartWindow`(C2b) 는 창의 값으로 같은 훅을 호출해 창별 독립 파이프라인을
 * 얻는다 — 두 번째 소비자를 만들되 로직 중복이 없다.
 *
 * 순수 이동(behavior-preserving refactor): 기존 useLiveBundle/LiveWorkarea 테스트가
 * 이 출력을 고정한다. index/save-source/viewport 는 LivePage 에 남는 페이지 관심사와
 * 무관하게 여기서 파생되는 값만 반환한다.
 */
import { useMemo } from 'react';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { useLiveBundle, type SidecarDemands } from './useLiveBundle';
import { useLiveSeries } from '../api/liveSeries';
import { useDayAskPeaks, useTodayAllPriceAskPeak } from './useDayAskPeaks';
import { useDayBidPeaks, useTodayAllPriceBidPeak } from './useDayBidPeaks';
import { useTradeVolumePocs } from './useTradeVolumePoc';
import type {
  AskPeak,
  BidPeak,
  Candle,
  DepthHeatmapPointWire,
  RangeBundle,
  TradeVolumePocWire,
} from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from './liveDateTime';
import type { LiveVenueOption } from '../state/liveVenue';
import { freshLiveTradePrice } from './deriveCurrentPriceLine';
import { instrumentLabel, type LiveInstrument } from './liveInstrument';
import { useLiveIndexCandles, useLiveIndexInvestorNet } from '../api/liveIndices';
import { buildIndexBundle } from './buildIndexBundle';
import { capabilitiesForInstrument } from './liveInstrumentCapabilities';
import { useDailyMaRevealGate } from './indicators/useDailyMaRevealGate';

/** 안정 빈 배열 — 매 렌더 새 [] 가 peaks 훅의 메모 deps 를 churn 하지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_CANDLES: readonly Candle[] = [];
const EMPTY_OB_SNAPSHOTS: readonly ObSnapshot[] = [];
const EMPTY_TRADE_SNAPSHOTS: readonly TradeSnapshot[] = [];
const EMPTY_DEPTH_HEATMAP: readonly DepthHeatmapPointWire[] = [];

const INDEX_BUCKET_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  D: 86_400_000,
  W: 7 * 86_400_000,
  M: 31 * 86_400_000,
} as const;

function tradeVolumePocsToWire(pocs: readonly {
  date: string;
  centerPrice: number;
  lowPrice: number;
  highPrice: number;
  qty: number;
  t_ms: number;
  bandPct: number;
}[]): TradeVolumePocWire[] {
  return pocs.map((poc) => ({
    date: poc.date,
    center_price: poc.centerPrice,
    low_price: poc.lowPrice,
    high_price: poc.highPrice,
    qty: poc.qty,
    t_ms: poc.t_ms,
    band_pct: poc.bandPct,
  }));
}

export interface UseLiveChartDataArgs {
  activeCode: string | null;
  activeInstrument: LiveInstrument | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  venue: LiveVenueOption;
  /** 활성 지표에서 파생한 투자자 순매수 게이트(호출측이 공급 — 전역/창별). */
  investorNetEnabled: boolean;
  /** 같은 그룹 데이터 창의 sidecar 강제 fetch 수요(ADR-0119 PR-D) — 그룹 링크
   *  발행 차트 창만 공급. useLiveBundle 로 그대로 전달된다. */
  sidecarDemands?: SidecarDemands;
}

export function useLiveChartData(args: UseLiveChartDataArgs) {
  const { activeCode, activeInstrument, timeframe, historicalFromDate, venue, investorNetEnabled, sidecarDemands } = args;

  const today = todayKstYyyymmdd();
  const live = useLiveSeries(activeCode ?? '', venue);
  const {
    bundle,
    chartBundle,
    hogaBundle,
    hogaMissingDates,
    candleEmpty,
    refetchCandles,
    depthDeltaToday,
    clampEngaged,
    isPastCandlesLoading,
    isHogaLoading,
    isExtending,
    isSidecarLoading,
    pastDataWarnings,
    indicatorCoverageFromDate,
    rangeWindowFromDate,
  } = useLiveBundle(activeCode, timeframe, today, live, { investorNetEnabled, venue, sidecarDemands });
  const liveInitial = live.initial?.code === activeCode ? live.initial : undefined;
  const stockBundle = activeCode && bundle?.code === activeCode ? bundle : null;
  const stockChartBundle = activeCode && chartBundle?.code === activeCode ? chartBundle : null;
  const stockHogaBundle = activeCode && hogaBundle?.code === activeCode ? hogaBundle : null;
  const activeIndexId = activeInstrument?.kind === 'index' ? activeInstrument.id : null;
  const isDailyMaLoading = useDailyMaRevealGate({ code: activeCode, timeframe, venue, todayKst: today });
  const capabilities = useMemo(() => capabilitiesForInstrument(activeInstrument), [activeInstrument]);
  const indexFrom = historicalFromDate ?? subtractDaysKst(today, initialHistoricalDaysFor(timeframe));
  const indexCandles = useLiveIndexCandles(activeIndexId, timeframe, indexFrom, today);
  const indexInvestorFrom = indexCandles.data?.from ?? indexFrom;
  const indexInvestorTo = indexCandles.data?.to ?? today;
  const indexInvestorNet = useLiveIndexInvestorNet(
    activeIndexId && timeframe === 'D' && capabilities.investorNet === 'market' ? activeIndexId : null,
    indexInvestorFrom,
    indexInvestorTo,
    timeframe === 'D' && capabilities.investorNet === 'market' && investorNetEnabled,
  );
  const indexBundle = useMemo<RangeBundle | null>(() => {
    if (!activeIndexId || !indexCandles.data) return null;
    return buildIndexBundle({
      indexId: activeIndexId,
      from: indexCandles.data.from,
      to: indexCandles.data.to,
      bucketMs: INDEX_BUCKET_MS[timeframe],
      candles: indexCandles.data.candles,
      investorPoints: indexInvestorNet.data?.points ?? [],
    });
  }, [activeIndexId, timeframe, indexCandles.data, indexInvestorNet.data?.points]);
  const activeLabel = activeInstrument ? instrumentLabel(activeInstrument) : activeCode;
  // 상태바 현재가용 fresh 체결가 — 타임프레임 무관(live.trade 는 code 단위 구독).
  const liveTradePrice = freshLiveTradePrice(live.trade, venue, Date.now());
  const askPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const askPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const askPeakSeeds = (stockChartBundle ?? stockBundle)?.ask_peaks ?? EMPTY_ASK_PEAKS;
  const askPeakCandles = isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayAskPeaks = useDayAskPeaks(
    askPeakOb,
    askPeakTrade,
    askPeakSeeds,
    today,
    activeCode,
    liveInitial?.ask_peak_today ?? null,
    askPeakCandles,
  );
  const todayAllPriceAskPeak = useTodayAllPriceAskPeak(
    askPeakOb,
    askPeakSeeds,
    today,
    activeCode,
    liveInitial?.ask_peak_today ?? null,
  );
  const bidPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const bidPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const bidPeakSeeds = (stockChartBundle ?? stockBundle)?.bid_peaks ?? EMPTY_BID_PEAKS;
  const bidPeakCandles = isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayBidPeaks = useDayBidPeaks(
    bidPeakOb,
    bidPeakTrade,
    bidPeakSeeds,
    today,
    activeCode,
    liveInitial?.bid_peak_today ?? null,
    bidPeakCandles,
  );
  const todayAllPriceBidPeak = useTodayAllPriceBidPeak(
    bidPeakOb,
    bidPeakSeeds,
    today,
    activeCode,
    liveInitial?.bid_peak_today ?? null,
  );
  const tradeVolumePocs = useTradeVolumePocs(
    isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS,
    (stockChartBundle ?? stockBundle)?.trade_volume_pocs ?? [],
    today,
    activeCode,
    isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES,
    isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.segments ?? []) : [],
    isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS,
  );
  const liveSaveBundle = useMemo<RangeBundle | null>(() => {
    if (!stockBundle) return null;
    const base = stockChartBundle ?? stockBundle;
    return {
      ...stockBundle,
      from_date: base.from_date,
      to_date: base.to_date,
      bucket_ms: base.bucket_ms,
      segments: base.segments,
      candles: base.candles,
      volume_profile_range: base.volume_profile_range,
      volume_profile_by_day: base.volume_profile_by_day,
      volume_distributions: base.volume_distributions ?? [],
      investorPoints: base.investorPoints,
      ask_peaks: dayAskPeaks,
      bid_peaks: dayBidPeaks,
      broker_late_entries: base.broker_late_entries ?? [],
      trade_volume_pocs: tradeVolumePocsToWire(tradeVolumePocs),
      // ⚠️ `base`(=chartBundle 우선) 가 아니라 병합 번들에서 가져온다 — 아래
      // workareaDepthHeatmap 과 같은 이유다. 저장 뷰는 "지금 화면"의 스냅샷이라
      // 오버레이가 그린 것과 같은 배열이어야 한다.
      depth_heatmap: stockBundle.depth_heatmap ?? [],
    };
  }, [stockBundle, stockChartBundle, dayAskPeaks, dayBidPeaks, tradeVolumePocs]);
  const workareaCode = activeCode ?? (activeIndexId ? `index:${activeIndexId}` : null);
  const workareaBundle = activeIndexId ? indexBundle : stockBundle;
  const workareaChartBundle = activeIndexId ? indexBundle : stockChartBundle;
  const workareaHogaBundle = activeIndexId ? indexBundle : stockHogaBundle;
  /**
   * 호가 잔량 히트맵 오버레이의 소스. **반드시 병합 번들(`workareaBundle`)에서** 온다.
   *
   * 왜 훅이 배열째 내보내나: 소비처(ChartWindow)가 `chartBundle ?? bundle` 로 고르면
   * 종목 뷰에서는 `chartBundle` 이 항상 non-null 이라 **sidecar 전용 배열**이 잡히고,
   * `useLiveBundle` 의 `mergeDepthHeatmapToday`(오늘 SSE 버킷 overlay)가 통째로
   * 버려진다 — 2026-07-20 멀티창 플립(#719) 때 그렇게 배선돼 있었다. 그 상태에서
   * 히트맵은 디스크 승격 주기(5분)로만 갱신돼, 승격 직전에는 최신(형성 중) 캔들 포함
   * 4~5개 버킷이 항상 비어 보였다(2026-08-04 실측: 11:21~11:24 마지막 버킷 11:20 고정
   * → 11:25 에 5칸 동시 등장). 선택을 창 밖에서 없애 잘못 고를 여지 자체를 지운다.
   *
   * `chartBundle`/`bundle` 분리는 SSE 틱이 캔들·세그먼트 경로를 churn 하지 않게 하는
   * **성능** 분기지, 데이터 분기가 아니다. 라이브 성분이 필요한 필드를 `chartBundle`
   * 에서 뽑으면 조용히 과거분만 얻는다.
   */
  const workareaDepthHeatmap: readonly DepthHeatmapPointWire[] =
    (activeIndexId ? indexBundle : stockBundle)?.depth_heatmap ?? EMPTY_DEPTH_HEATMAP;
  const workareaLoading = activeIndexId ? indexCandles.isLoading : isPastCandlesLoading;
  const indexExtending = activeIndexId ? historicalFromDate !== null && indexCandles.isFetching : false;
  const workareaDataWarnings = activeIndexId ? indexCandles.data?.data_warnings ?? [] : pastDataWarnings;

  return {
    today,
    live,
    liveInitial,
    liveTradePrice,
    activeIndexId,
    activeLabel,
    capabilities,
    clampEngaged,
    isHogaLoading,
    isSidecarLoading,
    isExtending,
    indexExtending,
    isDailyMaLoading,
    indicatorCoverageFromDate,
    rangeWindowFromDate,
    dayAskPeaks,
    todayAllPriceAskPeak,
    dayBidPeaks,
    todayAllPriceBidPeak,
    tradeVolumePocs,
    liveSaveBundle,
    // 지수(index) 워크에어리어는 호가장이 없어 증감 소스도 없다 — 종목일 때만 흘린다.
    depthDeltaToday: activeIndexId ? [] : depthDeltaToday,
    workareaCode,
    workareaBundle,
    workareaChartBundle,
    workareaHogaBundle,
    /** 호가 결손 사유 — 번들과 **따로** 흘린다(#1133). 지수 워크에어리어는 호가장이
     *  없어 결손이라는 개념 자체가 없으므로 빈 배열이다(`depthDeltaToday` 와 같은 규율). */
    workareaHogaMissingDates: activeIndexId ? [] : hogaMissingDates,
    /** 캔들 빈 상태 — 지수 워크에어리어는 캔들 파이프라인이 달라(indexBundle) 이
     *  판별의 대상이 아니다. `workareaHogaMissingDates` 와 같은 규율. */
    workareaCandleEmpty: activeIndexId ? null : candleEmpty,
    refetchCandles,
    workareaDepthHeatmap,
    workareaLoading,
    workareaDataWarnings,
  } as const;
}

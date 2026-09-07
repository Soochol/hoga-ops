import { useMemo } from 'react';
import { useRangeSidecarDelta, type RangeRequestOptions } from '../api/range';
import type { RangeBundle } from '../api/types';
import type { LiveRangeRequestPlan } from './useLiveBundle';

/** 가격 범위만 기다리는 매물대 때문에 최대벽·히트맵까지 직렬화하지 않는다.
 * 각 요청은 기존 delta hook의 캐시·취소·promotion 갱신을 그대로 사용한다. */
export function useLiveSidecars(plan: LiveRangeRequestPlan, waitingForPrice: boolean) {
  const independentEnabled = !!(plan.code && (
    plan.options.askPeaksEnabled || plan.options.bidPeaksEnabled
    || plan.options.depthHeatmapEnabled || plan.options.brokerLateEntriesEnabled
    || plan.options.programTradeEnabled
  ));
  const priceWanted = !!(plan.code && (
    plan.options.volumeDistributionBins != null || plan.options.tradeVolumePocEnabled
  ));
  const priceEnabled = priceWanted && !waitingForPrice;
  const independentOptions = useMemo<RangeRequestOptions>(() => ({
    mode: 'sidecar',
    ...plan.options,
    volumeDistributionBins: null,
    volumeDistributionPriceRange: null,
    tradeVolumePocEnabled: false,
    tradeVolumePocBins: null,
  }), [plan.options]);
  const priceOptions = useMemo<RangeRequestOptions>(() => ({
    mode: 'sidecar',
    ...plan.options,
    askPeaksEnabled: false,
    bidPeaksEnabled: false,
    depthHeatmapEnabled: false,
    brokerLateEntriesEnabled: false,
    brokerLateEntryStartHHMM: null,
    programTradeEnabled: false,
    barPeaksEnabled: false,
    allBarPeaksEnabled: false,
    unreachedBarPeaksEnabled: false,
  }), [plan.options]);
  const independent = useRangeSidecarDelta(
    independentEnabled ? plan.code : null,
    independentEnabled ? plan.from : null,
    independentEnabled ? plan.to : null,
    independentEnabled ? plan.timeframe : null,
    undefined,
    independentEnabled ? plan.todayKst : null,
    independentOptions,
  );
  const price = useRangeSidecarDelta(
    priceEnabled ? plan.code : null,
    priceEnabled ? plan.from : null,
    priceEnabled ? plan.to : null,
    priceEnabled ? plan.timeframe : null,
    undefined,
    priceEnabled ? plan.todayKst : null,
    priceOptions,
  );
  const independentData = independentEnabled ? independent.data : undefined;
  const priceData = priceEnabled ? price.data : undefined;
  // 한 쪽의 완료를 전체 지표 커버리지로 읽으면 좌측 백필이 너무 일찍 멎는다.
  // 아직 안 온 활성 레인은 요청 우단까지만 덮은 것으로 취급한다.
  const coverageFrom = [
    independentEnabled ? independentData?.from_date ?? plan.to : null,
    priceWanted ? priceData?.from_date ?? plan.to : null,
  ].filter((date): date is string => date != null).sort().at(-1) ?? null;
  const data = useMemo<RangeBundle | null>(() => {
    const base = independentData ?? priceData;
    if (!base) return null;
    return {
      ...base,
      from_date: coverageFrom ?? base.from_date,
      ask_peaks: independentData?.ask_peaks ?? [],
      bid_peaks: independentData?.bid_peaks ?? [],
      depth_heatmap: independentData?.depth_heatmap ?? [],
      broker_late_entries: independentData?.broker_late_entries ?? [],
      program_trade: independentData?.program_trade ?? { points: [] },
      volume_distributions: priceData?.volume_distributions ?? [],
      trade_volume_pocs: priceData?.trade_volume_pocs ?? [],
    };
  }, [independentData, priceData, coverageFrom]);
  return {
    data,
    enabled: independentEnabled || priceWanted,
    error: (independentEnabled ? independent.error : null) ?? (priceEnabled ? price.error : null),
    // Pending covers the enabled-but-not-fetching frame. Errors settle this
    // flag and therefore cannot wedge the chart's bounded reveal gate.
    isLoading: (independentEnabled && independent.isPending && independentData == null)
      || (priceWanted && waitingForPrice)
      || (priceEnabled && price.isPending && priceData == null),
    isHistoricalDeltaFetching: (independentEnabled && independent.isHistoricalDeltaFetching)
      || (priceEnabled && price.isHistoricalDeltaFetching),
  };
}

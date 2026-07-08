import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useLiveSettings } from '../api/liveSettings';
import { useLivePastCandles } from '../api/livePastCandles';
import { rangeBundleQueryOptions } from '../api/range';
import { useScreenerDailyCandles } from '../api/screenerDailyCandles';
import {
  type LivePastCandlesWarning,
  type LivePastDailyCandlesWarning,
} from '../api/studyPastCandles';
import { useLiveVenueStore } from '../state/liveVenue';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle, RangeBundle } from '../api/types';
import { buildStudyReferenceBundleModel, studyReferenceQueryInputs } from './studyReferenceBundleModel';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

function mergeStudyRangeBundles(
  hoga: RangeBundle | null,
  sidecars: RangeBundle | null,
): RangeBundle | null {
  if (!hoga) return sidecars;
  if (!sidecars) return hoga;
  return {
    ...hoga,
    ask_peaks: sidecars.ask_peaks ?? [],
    bid_peaks: sidecars.bid_peaks ?? [],
    broker_late_entries: sidecars.broker_late_entries ?? [],
    trade_volume_pocs: sidecars.trade_volume_pocs ?? [],
    volume_distributions: sidecars.volume_distributions ?? [],
  };
}

function rangeCandleToStudyBar(candle: Candle) {
  return {
    t_ms: candle.ts_ms,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.vol_a + candle.vol_b,
  };
}

export function useStudyReferenceBundle(save: StudyViewReference | null) {
  const venue = useLiveVenueStore((s) => s.venue);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryStartHHMM = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  useLiveSettings();
  const inputs = useMemo(() => studyReferenceQueryInputs(save), [save]);
  const queryOptions = useMemo(
    () => studyReferenceQueryOptions(save, {
      venue,
      sourcePref,
      brokerLateEntryEnabled,
      brokerLateEntryStartHHMM,
      tradeVolumePocEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    }),
    [
      save,
      brokerLateEntryEnabled,
      brokerLateEntryStartHHMM,
      sourcePref,
      tradeVolumePocEnabled,
      venue,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    ],
  );
  const rangeCandlesOptions = useMemo(
    () => rangeBundleQueryOptions({
      code: inputs.range.code,
      from: inputs.range.from,
      to: inputs.range.to,
      timeframe: inputs.range.timeframe,
      todayKst: null,
      sourcePref,
      options: {
        mode: 'candles',
        brokerLateEntriesEnabled: false,
        brokerLateEntryStartHHMM: null,
        volumeDistributionBins: null,
        tradeVolumePocBins: null,
        volumeDistributionPriceRange: null,
      },
    }),
    [inputs.range.code, inputs.range.from, inputs.range.timeframe, inputs.range.to, sourcePref],
  );

  const pastHoga = useQuery(queryOptions.rangeHoga);
  const pastSidecars = useQuery(queryOptions.rangeSidecars);
  const rangeCandles = useQuery(rangeCandlesOptions);
  // ADR-0091: 저장 기간이 백엔드 fetch 예산(12거래일)을 넘으면 단일 호출은
  // fetch_budget_exhausted로 부분 응답이 온다. /live의 청크 워크백 훅을
  // 그대로 재사용해 seed까지 자동 전진 + blocking 응답 비박제로 회복한다.
  // (queryOptions.minuteCandles 옵션 빌더는 warm 프리페치가 계속 사용.)
  const minuteCandles = useLivePastCandles(
    inputs.minuteCandles.code,
    inputs.minuteCandles.from,
    inputs.minuteCandles.to,
    venue,
  );
  const dailyCandles = useQuery(queryOptions.dailyCandles);
  const screenerDailyCandles = useScreenerDailyCandles(
    !inputs.isMinute ? inputs.dailyCandles.code : null,
    !inputs.isMinute ? save?.range.from_date ?? null : null,
    !inputs.isMinute ? inputs.dailyCandles.to : null,
  );
  const pastBundle = useMemo(
    () => mergeStudyRangeBundles(pastHoga.data ?? null, pastSidecars.data ?? null),
    [pastHoga.data, pastSidecars.data],
  );
  const minuteCandleData = minuteCandles.data?.candles ?? [];
  const fallbackMinuteCandles = (rangeCandles.data?.candles ?? []).map(rangeCandleToStudyBar);
  const dailyCandleData = dailyCandles.data?.candles ?? [];
  const screenerDailyCandleData = screenerDailyCandles.data?.candles ?? [];

  const model = useMemo(
    () => buildStudyReferenceBundleModel({
      save,
      venue,
      pastBundle,
      minuteCandles: minuteCandleData.length > 0 ? minuteCandleData : fallbackMinuteCandles,
      dailyCandles: dailyCandleData.length > 0 ? dailyCandleData : screenerDailyCandleData,
      minuteEffectiveSessions: minuteCandles.data?.effective_sessions ?? [],
    }),
    [
      dailyCandleData,
      fallbackMinuteCandles,
      minuteCandleData,
      minuteCandles.data?.effective_sessions,
      pastBundle,
      save,
      screenerDailyCandleData,
      venue,
    ],
  );

  const warnings: Array<LivePastCandlesWarning | LivePastDailyCandlesWarning> = inputs.isMinute
    ? minuteCandles.data?.data_warnings ?? []
    : dailyCandles.data?.data_warnings ?? [];

  return {
    bundle: model.bundle,
    chartBundle: model.chartBundle,
    isLoading: pastHoga.isLoading || rangeCandles.isLoading || minuteCandles.isLoading || dailyCandles.isLoading || screenerDailyCandles.isLoading,
    error: pastHoga.error ?? rangeCandles.error ?? minuteCandles.error ?? dailyCandles.error ?? screenerDailyCandles.error ?? pastSidecars.error ?? null,
    pastDataWarnings: warnings,
    venue,
  };
}

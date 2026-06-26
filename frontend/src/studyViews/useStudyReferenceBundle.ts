import { useMemo } from 'react';

import { useRange } from '../api/range';
import {
  useStudyPastCandles,
  useStudyPastDailyCandles,
  type LivePastCandlesWarning,
  type LivePastDailyCandlesWarning,
} from '../api/studyPastCandles';
import { useLiveVenueStore } from '../state/liveVenue';
import { useLivePageStore } from '../state/livePage';
import type { StudyViewReference } from '../api/studyViews';
import { buildStudyReferenceBundleModel, studyReferenceQueryInputs } from './studyReferenceBundleModel';

export function useStudyReferenceBundle(save: StudyViewReference | null) {
  const venue = useLiveVenueStore((s) => s.venue);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const inputs = useMemo(() => studyReferenceQueryInputs(save), [save]);

  const past = useRange(
    inputs.range.code,
    inputs.range.from,
    inputs.range.to,
    inputs.range.timeframe,
    undefined,
    null,
    {
      volumeDistributionBins: null,
      tradeVolumePocBins: tradeVolumePocEnabled ? volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: null,
    },
  );
  const minuteCandles = useStudyPastCandles(
    inputs.minuteCandles.code,
    inputs.minuteCandles.from,
    inputs.minuteCandles.to,
    venue,
  );
  const dailyCandles = useStudyPastDailyCandles(
    inputs.dailyCandles.code,
    inputs.dailyCandles.from,
    inputs.dailyCandles.to,
    venue,
  );

  const model = useMemo(
    () => buildStudyReferenceBundleModel({
      save,
      venue,
      pastBundle: past.data ?? null,
      minuteCandles: minuteCandles.data?.candles ?? [],
      dailyCandles: dailyCandles.data?.candles ?? [],
    }),
    [dailyCandles.data?.candles, minuteCandles.data?.candles, past.data, save, venue],
  );

  const warnings: Array<LivePastCandlesWarning | LivePastDailyCandlesWarning> = inputs.isMinute
    ? minuteCandles.data?.data_warnings ?? []
    : dailyCandles.data?.data_warnings ?? [];

  return {
    bundle: model.bundle,
    chartBundle: model.chartBundle,
    isLoading: past.isLoading || minuteCandles.isLoading || dailyCandles.isLoading,
    error: past.error ?? minuteCandles.error ?? dailyCandles.error ?? null,
    pastDataWarnings: warnings,
  };
}

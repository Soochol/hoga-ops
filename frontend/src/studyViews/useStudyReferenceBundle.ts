import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  type LivePastCandlesWarning,
  type LivePastDailyCandlesWarning,
} from '../api/studyPastCandles';
import { useLiveVenueStore } from '../state/liveVenue';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { StudyViewReference } from '../api/studyViews';
import { buildStudyReferenceBundleModel, studyReferenceQueryInputs } from './studyReferenceBundleModel';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

export function useStudyReferenceBundle(save: StudyViewReference | null) {
  const venue = useLiveVenueStore((s) => s.venue);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const inputs = useMemo(() => studyReferenceQueryInputs(save), [save]);
  const queryOptions = useMemo(
    () => studyReferenceQueryOptions(save, {
      venue,
      sourcePref,
      tradeVolumePocEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    }),
    [
      save,
      sourcePref,
      tradeVolumePocEnabled,
      venue,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    ],
  );

  const past = useQuery(queryOptions.range);
  const minuteCandles = useQuery(queryOptions.minuteCandles);
  const dailyCandles = useQuery(queryOptions.dailyCandles);

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

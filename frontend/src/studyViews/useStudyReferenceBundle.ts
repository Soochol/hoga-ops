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
import type { RangeBundle } from '../api/types';
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

export function useStudyReferenceBundle(save: StudyViewReference | null) {
  const venue = useLiveVenueStore((s) => s.venue);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryStartHHMM = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
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

  const pastHoga = useQuery(queryOptions.rangeHoga);
  const pastSidecars = useQuery(queryOptions.rangeSidecars);
  const minuteCandles = useQuery(queryOptions.minuteCandles);
  const dailyCandles = useQuery(queryOptions.dailyCandles);
  const pastBundle = useMemo(
    () => mergeStudyRangeBundles(pastHoga.data ?? null, pastSidecars.data ?? null),
    [pastHoga.data, pastSidecars.data],
  );

  const model = useMemo(
    () => buildStudyReferenceBundleModel({
      save,
      venue,
      pastBundle,
      minuteCandles: minuteCandles.data?.candles ?? [],
      dailyCandles: dailyCandles.data?.candles ?? [],
      minuteEffectiveSessions: minuteCandles.data?.effective_sessions ?? [],
    }),
    [dailyCandles.data?.candles, minuteCandles.data?.candles, minuteCandles.data?.effective_sessions, pastBundle, save, venue],
  );

  const warnings: Array<LivePastCandlesWarning | LivePastDailyCandlesWarning> = inputs.isMinute
    ? minuteCandles.data?.data_warnings ?? []
    : dailyCandles.data?.data_warnings ?? [];

  return {
    bundle: model.bundle,
    chartBundle: model.chartBundle,
    isLoading: pastHoga.isLoading || minuteCandles.isLoading || dailyCandles.isLoading,
    error: pastHoga.error ?? minuteCandles.error ?? dailyCandles.error ?? pastSidecars.error ?? null,
    pastDataWarnings: warnings,
    venue,
  };
}

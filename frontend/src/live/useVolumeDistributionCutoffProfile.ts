import { useMemo } from 'react';

import { useRange } from '../api/range';
import type { Candle, DayVolumeDistribution, RangeSegment, Timeframe } from '../api/types';
import type { SourcePreference } from '../state/sourcePreference';
import {
  computeContinuousTradeVolumeDistribution,
  mergeVolumeDistributionTail,
} from './continuousTradeVolumeDistribution';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

export function useVolumeDistributionCutoffProfile(args: {
  enabled: boolean;
  code: string | null;
  timeframe: Timeframe | null;
  date: string | null;
  cursorMs: number | null;
  todayKst: string | null;
  rangeCount: number;
  sourcePref: SourcePreference;
  finalProfile: DayVolumeDistribution | null | undefined;
  priceRange: { min: number; max: number } | null;
  liveTrades?: readonly ContinuousTradeLike[];
  candles?: readonly Candle[];
  segment?: RangeSegment | null;
}): DayVolumeDistribution | null | undefined {
  const queryEnabled = args.enabled && !!(
    args.code
    && args.timeframe
    && args.date
    && args.cursorMs != null
  );
  const query = useRange(
    queryEnabled ? args.code : null,
    queryEnabled ? args.date : null,
    queryEnabled ? args.date : null,
    queryEnabled ? args.timeframe : null,
    undefined,
    args.todayKst,
    {
      mode: 'sidecar',
      volumeDistributionBins: args.rangeCount,
      volumeDistributionCutoffMs: queryEnabled ? args.cursorMs : null,
      volumeDistributionPriceRange: args.priceRange,
    },
  );

  return useMemo(() => {
    if (!args.enabled || !queryEnabled) return args.finalProfile;

    const sidecarProfile = query.data?.volume_distributions.find((profile) => profile.date === args.date) ?? null;
    const liveTrades = args.liveTrades ?? [];

    if (sidecarProfile) {
      return mergeVolumeDistributionTail(sidecarProfile, liveTrades, args.cursorMs);
    }

    if (
      args.date === args.todayKst
      && args.segment
      && args.candles
      && liveTrades.length > 0
      && args.cursorMs != null
    ) {
      return computeContinuousTradeVolumeDistribution({
        date: args.date,
        candles: args.candles,
        trades: liveTrades,
        rangeCount: args.rangeCount,
        segment: args.segment,
        cutoffMs: args.cursorMs,
      }) ?? args.finalProfile;
    }

    return args.finalProfile;
  }, [
    args.candles,
    args.cursorMs,
    args.date,
    args.enabled,
    args.finalProfile,
    args.liveTrades,
    args.rangeCount,
    args.segment,
    args.sourcePref,
    args.todayKst,
    query.data,
    queryEnabled,
  ]);
}

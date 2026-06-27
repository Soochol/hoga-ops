import { useMemo } from 'react';

import { useRange } from '../api/range';
import type { Candle, DayVolumeDistribution, RangeSegment, Timeframe } from '../api/types';
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

    const date = args.date;
    const sidecarProfile = query.data?.volume_distributions.find((profile) => profile.date === date) ?? null;
    const liveTrades = args.liveTrades ?? [];

    if (sidecarProfile) {
      return mergeVolumeDistributionTail(sidecarProfile, liveTrades, args.cursorMs);
    }

    if (
      date
      && date === args.todayKst
      && args.segment
      && args.candles
      && liveTrades.length > 0
      && args.cursorMs != null
    ) {
      const computedProfile = computeContinuousTradeVolumeDistribution({
        date,
        candles: args.candles,
        trades: liveTrades,
        rangeCount: args.rangeCount,
        segment: args.segment,
        cutoffMs: args.cursorMs,
      });
      return computedProfile?.last_trade_ms != null
        ? computedProfile
        : args.finalProfile;
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
    args.todayKst,
    query.data,
    queryEnabled,
  ]);
}

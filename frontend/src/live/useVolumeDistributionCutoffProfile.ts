import { useMemo, useRef } from 'react';

import { useRange } from '../api/range';
import { TIMEFRAME_TO_MS, type Candle, type DayVolumeDistribution, type RangeSegment, type Timeframe } from '../api/types';
import {
  buildContinuousTradeVolumeDistributionIndex,
  computeContinuousTradeVolumeDistribution,
  mergeVolumeDistributionTail,
} from './continuousTradeVolumeDistribution';

type ContinuousTradeLike = {
  t_ms: number;
  price: number;
  qty: number;
  side: number;
};

const EMPTY_TRADES: readonly ContinuousTradeLike[] = [];

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
  const lastCutoffProfileRef = useRef<{
    scope: string;
    profile: DayVolumeDistribution;
  } | null>(null);
  const queryEnabled = args.enabled && !!(
    args.code
    && args.timeframe
    && args.date
    && args.cursorMs != null
  );
  const bucketMs = args.timeframe ? TIMEFRAME_TO_MS[args.timeframe] : null;
  const alignedCursorMs =
    args.cursorMs != null && bucketMs != null
      ? Math.floor(args.cursorMs / bucketMs) * bucketMs
      : null;
  const liveTrades = args.liveTrades ?? EMPTY_TRADES;
  const scope = [
    args.code ?? '',
    args.timeframe ?? '',
    args.date ?? '',
    args.rangeCount,
    args.priceRange?.min ?? '',
    args.priceRange?.max ?? '',
  ].join('|');
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
      volumeDistributionCutoffMs: queryEnabled ? alignedCursorMs : null,
      volumeDistributionPriceRange: args.priceRange,
    },
  );
  const liveFallbackIndex = useMemo(() => {
    if (
      !args.date
      || args.date !== args.todayKst
      || !args.segment
      || !args.candles
      || liveTrades.length === 0
    ) {
      return null;
    }
    return buildContinuousTradeVolumeDistributionIndex({
      date: args.date,
      candles: args.candles,
      trades: liveTrades,
      rangeCount: args.rangeCount,
      segment: args.segment,
    });
  }, [
    args.candles,
    args.date,
    args.rangeCount,
    args.segment,
    args.todayKst,
    liveTrades,
  ]);

  return useMemo(() => {
    if (!args.enabled || !queryEnabled) {
      lastCutoffProfileRef.current = null;
      return args.finalProfile;
    }

    const date = args.date;
    const sidecarProfile = query.data?.volume_distributions.find((profile) => profile.date === date) ?? null;

    if (sidecarProfile) {
      const profile = mergeVolumeDistributionTail(sidecarProfile, liveTrades, args.cursorMs);
      lastCutoffProfileRef.current = { scope, profile };
      return profile;
    }

    if (query.isFetching || query.data === undefined) {
      if (lastCutoffProfileRef.current?.scope === scope) {
        return lastCutoffProfileRef.current.profile;
      }
      return args.finalProfile;
    }

    if (
      date
      && date === args.todayKst
      && args.segment
      && args.candles
      && liveTrades.length > 0
      && args.cursorMs != null
    ) {
      const computedProfile = liveFallbackIndex?.profileAt(args.cursorMs) ?? computeContinuousTradeVolumeDistribution({
        date,
        candles: args.candles,
        trades: liveTrades,
        rangeCount: args.rangeCount,
        segment: args.segment,
        cutoffMs: args.cursorMs,
      });
      if (computedProfile?.last_trade_ms != null) {
        lastCutoffProfileRef.current = { scope, profile: computedProfile };
        return computedProfile;
      }
    }

    return args.finalProfile;
  }, [
    args.candles,
    args.cursorMs,
    args.date,
    args.enabled,
    args.finalProfile,
    args.rangeCount,
    args.segment,
    args.todayKst,
    alignedCursorMs,
    liveFallbackIndex,
    liveTrades,
    query.data,
    query.isFetching,
    queryEnabled,
    scope,
  ]);
}

import { useMemo, useRef } from 'react';

import { useRange } from '../api/range';
import {
  scaleRangeBundlePrices,
  unscalePriceForRequest,
  type AdjustFactors,
} from './scaleRangeBundlePrices';
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
  /** 봉에 곱해진 날짜별 수정계수(`/api/live/past-candles`). 이 훅은 `/api/range` 를
   *  **자체 호출**하므로 `useLiveBundle` 의 환산을 지나지 않는다 — 계수를 안 받으면
   *  이 경로만 원주가로 남아 옆문으로 어긋남이 되살아난다. 근거는
   *  `scaleRangeBundlePrices` 모듈 주석. */
  adjustFactors?: AdjustFactors;
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
  const dateFactor = args.date ? args.adjustFactors?.[args.date] : undefined;
  const scope = [
    args.code ?? '',
    args.timeframe ?? '',
    args.date ?? '',
    args.rangeCount,
    args.priceRange?.min ?? '',
    args.priceRange?.max ?? '',
    // 계수가 늦게 도착하면 같은 스코프로 **환산 전 프로파일이 재사용된다** — 척도를
    // 스코프에 넣어야 도착 전후가 다른 캐시 슬롯이 된다.
    dateFactor ?? '',
  ].join('|');
  // 화면(환산가) → 서버(원주가). 서버의 매물대 격자는 디스크 캡처 공간에 있으므로
  // 밴드를 그대로 보내면 계수 ≠ 1 인 날짜에서 **엉뚱한 가격대**를 계산해 온다.
  const requestPriceRange = useMemo(
    () =>
      args.priceRange
        ? {
            min: unscalePriceForRequest(args.priceRange.min, args.adjustFactors, args.date ?? undefined),
            max: unscalePriceForRequest(args.priceRange.max, args.adjustFactors, args.date ?? undefined),
          }
        : args.priceRange,
    [args.priceRange, args.adjustFactors, args.date],
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
      volumeDistributionCutoffMs: queryEnabled ? alignedCursorMs : null,
      volumeDistributionPriceRange: requestPriceRange,
    },
  );
  // 응답도 환산한다 — 요청만 되돌리면 절반이다. 돌아온 격자는 원주가 공간이라, 화면의
  // 나머지(이제 환산가)와 나란히 놓으면 이 프로파일만 옛 척도로 남는다.
  const scaledQueryData = useMemo(
    () => (query.data ? scaleRangeBundlePrices(query.data, args.adjustFactors) : query.data),
    [query.data, args.adjustFactors],
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
    const sidecarProfile = scaledQueryData?.volume_distributions.find((profile) => profile.date === date) ?? null;

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

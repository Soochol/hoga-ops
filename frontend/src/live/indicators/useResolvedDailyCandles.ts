import { useMemo } from 'react';

import { useLiveSettings } from '../../api/liveSettings';
import {
  useLivePastDailyCandles,
  type LivePastDailyCandle,
  type LivePastDailyCandlesWarning,
} from '../../api/livePastDailyCandles';
import { useScreenerDailyCandles } from '../../api/screenerDailyCandles';
import type { LiveVenueOption } from '../../state/liveVenue';
import { unixMsToKSTDate } from '../../util/time';
import { isNonDomesticStockCode, usStockFromKey, isUsIndexId, isLiveIndexId } from '../liveInstrument';
import { useUsStockDaily } from '../../api/usDailyCandles';
import { useLiveIndexCandles } from '../../api/liveIndices';

export type ResolvedDailyCandleSource = 'kis_daily' | 'screener_daily' | 'us_daily';

export type ResolvedDailyWarning =
  | LivePastDailyCandlesWarning
  | { batch: string; reason: string; msg: string };

export type UseResolvedDailyCandlesInput = {
  code: string | null;
  from: string | null;
  to: string | null;
  venue: LiveVenueOption;
  enabled: boolean;
  /** KIS 일봉 fetch 허용 여부(기본 true). /study는 false로 넘겨 KIS 호출을 막고
   * 스크리너 일봉만 쓴다(디스크 온리 계약). */
  kisEnabled?: boolean;
};

export type UseResolvedDailyCandlesResult = {
  candles: LivePastDailyCandle[];
  candleBasis?: { price_basis: string; adjusted_as_of: string | null };
  dataWarnings: ResolvedDailyWarning[];
  isLoading: boolean;
  error: unknown;
  sourceByDate: Map<string, ResolvedDailyCandleSource>;
};

const EMPTY_CANDLES: LivePastDailyCandle[] = [];
const EMPTY_WARNINGS: ResolvedDailyWarning[] = [];

function resolveInputs(input: UseResolvedDailyCandlesInput): { code: string; from: string; to: string } | null {
  if (!input.enabled || !input.code || isNonDomesticStockCode(input.code)
      || !input.from || !input.to || input.from > input.to) return null;
  return { code: input.code, from: input.from, to: input.to };
}

export function useResolvedDailyCandles(input: UseResolvedDailyCandlesInput): UseResolvedDailyCandlesResult {
  const resolvedInput = resolveInputs(input);
  const stock = input.code ? usStockFromKey(input.code) : null;
  const indexId = input.code?.startsWith('index:') ? input.code.slice(6) : null;
  const usIndex = indexId !== null && isLiveIndexId(indexId) && isUsIndexId(indexId) ? indexId : null;
  const usEnabled = input.enabled && !!input.from && !!input.to && input.from <= input.to && !!(stock || usIndex);
  const stockQuery = useUsStockDaily(usEnabled ? stock : null, 'D', input.from ?? '', input.to ?? '');
  const indexQuery = useLiveIndexCandles(usEnabled ? usIndex : null, 'D', input.from, input.to);
  const overseasQuery = stock ? stockQuery : indexQuery;
  // KIS 일봉 fetch 허용 = 명시적 kisEnabled(=/study false) AND 우회 OFF. 우회 ON이면
  // /live 캔들이 스크리너로 전환되므로 일봉 MA도 KIS를 꺼 소스를 일치시킨다. 훅 내부에서
  // 우회를 읽어 소비처 2곳(오버레이·reveal 게이트)의 쿼리키가 자동으로 lockstep 유지된다.
  const { data: liveSettings } = useLiveSettings();
  const kisAllowed = input.kisEnabled !== false && !(liveSettings?.rest_bypass_enabled ?? false);
  const kisQuery = useLivePastDailyCandles(
    kisAllowed ? resolvedInput?.code ?? null : null,
    kisAllowed ? resolvedInput?.from ?? null : null,
    kisAllowed ? resolvedInput?.to ?? null : null,
    input.venue,
  );
  const screenerQuery = useScreenerDailyCandles(
    resolvedInput?.code ?? null,
    resolvedInput?.from ?? null,
    resolvedInput?.to ?? null,
  );

  return useMemo(() => {
    const sourceByDate = new Map<string, ResolvedDailyCandleSource>();
    if (usEnabled) {
      const candles = overseasQuery.data?.candles ?? EMPTY_CANDLES;
      for (const row of candles) sourceByDate.set(unixMsToKSTDate(row.t_ms), 'us_daily');
      return { candles, candleBasis: stockQuery.data?.daily_metadata ? {
        price_basis: stockQuery.data.daily_metadata.price_basis,
        adjusted_as_of: stockQuery.data.daily_metadata.adjusted_as_of ?? null,
      } : undefined, dataWarnings: EMPTY_WARNINGS, isLoading: overseasQuery.isLoading,
        error: overseasQuery.error, sourceByDate };
    }
    const mergedByDate = new Map<string, LivePastDailyCandle>();
    const screenerRows = screenerQuery.data?.candles ?? EMPTY_CANDLES;
    const kisRows = kisQuery.data?.candles ?? EMPTY_CANDLES;

    for (const row of screenerRows) {
      const date = unixMsToKSTDate(row.t_ms);
      mergedByDate.set(date, row);
      sourceByDate.set(date, 'screener_daily');
    }

    for (const row of kisRows) {
      const date = unixMsToKSTDate(row.t_ms);
      mergedByDate.set(date, row);
      sourceByDate.set(date, 'kis_daily');
    }

    const candles = Array.from(mergedByDate.values()).sort((a, b) => a.t_ms - b.t_ms);
    const dataWarnings = [
      ...(kisQuery.data?.data_warnings ?? EMPTY_WARNINGS),
      ...(screenerQuery.data?.data_warnings ?? EMPTY_WARNINGS),
    ];
    const hasCandles = candles.length > 0;

    return {
      candles,
      dataWarnings,
      isLoading: !hasCandles && (kisQuery.isLoading || screenerQuery.isLoading),
      error: kisQuery.error ?? screenerQuery.error ?? null,
      sourceByDate,
    };
  }, [
    usEnabled, overseasQuery.data, stockQuery.data?.daily_metadata, overseasQuery.isLoading, overseasQuery.error,
    kisQuery.data?.candles,
    kisQuery.data?.data_warnings,
    kisQuery.error,
    kisQuery.isLoading,
    screenerQuery.data?.candles,
    screenerQuery.data?.data_warnings,
    screenerQuery.error,
    screenerQuery.isLoading,
  ]);
}

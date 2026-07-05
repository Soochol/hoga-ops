import { useMemo } from 'react';

import {
  useLivePastDailyCandles,
  type LivePastDailyCandle,
  type LivePastDailyCandlesWarning,
} from '../../api/livePastDailyCandles';
import { useScreenerDailyCandles } from '../../api/screenerDailyCandles';
import type { LiveVenueOption } from '../../state/liveVenue';
import { unixMsToKSTDate } from '../../util/time';

export type ResolvedDailyCandleSource = 'kis_daily' | 'screener_daily';

export type ResolvedDailyWarning =
  | LivePastDailyCandlesWarning
  | { batch: string; reason: string; msg: string };

export type UseResolvedDailyCandlesInput = {
  code: string | null;
  from: string | null;
  to: string | null;
  venue: LiveVenueOption;
  enabled: boolean;
};

export type UseResolvedDailyCandlesResult = {
  candles: LivePastDailyCandle[];
  dataWarnings: ResolvedDailyWarning[];
  isLoading: boolean;
  error: unknown;
  sourceByDate: Map<string, ResolvedDailyCandleSource>;
};

const EMPTY_CANDLES: LivePastDailyCandle[] = [];
const EMPTY_WARNINGS: ResolvedDailyWarning[] = [];

function resolveInputs(input: UseResolvedDailyCandlesInput): { code: string; from: string; to: string } | null {
  if (!input.enabled || !input.code || !input.from || !input.to || input.from > input.to) return null;
  return { code: input.code, from: input.from, to: input.to };
}

export function useResolvedDailyCandles(input: UseResolvedDailyCandlesInput): UseResolvedDailyCandlesResult {
  const resolvedInput = resolveInputs(input);
  const kisQuery = useLivePastDailyCandles(
    resolvedInput?.code ?? null,
    resolvedInput?.from ?? null,
    resolvedInput?.to ?? null,
    input.venue,
  );
  const screenerQuery = useScreenerDailyCandles(
    resolvedInput?.code ?? null,
    resolvedInput?.from ?? null,
    resolvedInput?.to ?? null,
  );

  return useMemo(() => {
    const sourceByDate = new Map<string, ResolvedDailyCandleSource>();
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

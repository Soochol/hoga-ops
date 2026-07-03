import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { LiveVenueOption } from '../state/liveVenue';

export type LiveTabMetricHogaReason = 'not_collected' | 'stale' | 'index' | 'pre_open' | 'invalid_book';

export interface LiveTabMetric {
  code: string;
  change_pct: number | null;
  hoga_ratio_x: number | null;
  hoga_available: boolean;
  hoga_reason: LiveTabMetricHogaReason | null;
  source: 'live' | 'quote_cache';
}

export interface LiveTabMetricsResponse {
  phase: 'pre_open' | 'open' | 'closed';
  metrics: LiveTabMetric[];
}

function uniqueSortedCodes(codes: string[]): string[] {
  return [...new Set(codes)].sort();
}

export function getLiveTabMetrics(
  codes: string[],
  venue: LiveVenueOption = 'KRX',
): Promise<LiveTabMetricsResponse> {
  const sortedCodes = uniqueSortedCodes(codes);
  return apiCall<LiveTabMetricsResponse>(`/api/live/tab-metrics?codes=${sortedCodes.join(',')}&venue=${venue}`);
}

export function liveTabMetricsQueryKey(
  codes: string[],
  venue: LiveVenueOption = 'KRX',
): readonly ['live-tab-metrics', string, LiveVenueOption] {
  return ['live-tab-metrics', uniqueSortedCodes(codes).join(','), venue] as const;
}

function tabMetricsRefetchInterval(phase: string | undefined): number {
  return phase === 'closed' ? 600_000 : 10_000;
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function withLastGoodMetric(current: LiveTabMetric, previous: LiveTabMetric | undefined): LiveTabMetric {
  if (previous == null) return current;
  return {
    ...current,
    change_pct: finiteNumber(current.change_pct) ? current.change_pct : previous.change_pct,
    hoga_ratio_x: finiteNumber(current.hoga_ratio_x) && current.hoga_ratio_x > 0 ? current.hoga_ratio_x : previous.hoga_ratio_x,
  };
}

export function useLiveTabMetrics(codes: string[], venue: LiveVenueOption = 'KRX') {
  const sortedCodes = useMemo(() => uniqueSortedCodes(codes), [codes]);
  return useQuery({
    queryKey: liveTabMetricsQueryKey(sortedCodes, venue),
    queryFn: () => getLiveTabMetrics(sortedCodes, venue),
    enabled: sortedCodes.length > 0,
    staleTime: 10_000,
    refetchInterval: (q) => tabMetricsRefetchInterval(q.state.data?.phase),
    placeholderData: (prev) => prev,
  });
}

export function useLiveTabMetricsByCode(
  codes: string[],
  venue: LiveVenueOption = 'KRX',
): Map<string, LiveTabMetric> {
  const q = useLiveTabMetrics(codes, venue);
  const lastGoodByCodeRef = useRef(new Map<string, LiveTabMetric>());
  return useMemo(() => {
    const currentMetrics = q.data?.metrics;
    if (currentMetrics == null) return new Map<string, LiveTabMetric>();
    const next = new Map<string, LiveTabMetric>();
    for (const metric of currentMetrics) {
      const merged = withLastGoodMetric(metric, lastGoodByCodeRef.current.get(metric.code));
      next.set(metric.code, merged);
      lastGoodByCodeRef.current.set(metric.code, merged);
    }
    for (const code of uniqueSortedCodes(codes)) {
      if (next.has(code)) continue;
      const previous = lastGoodByCodeRef.current.get(code);
      if (previous != null) next.set(code, previous);
    }
    return next;
  }, [codes, q.data]);
}

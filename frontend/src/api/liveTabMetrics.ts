import { useMemo } from 'react';
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
  return useMemo(() => {
    const next = new Map<string, LiveTabMetric>();
    for (const metric of q.data?.metrics ?? []) {
      next.set(metric.code, metric);
    }
    return next;
  }, [q.data]);
}

import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { LiveIndexId } from '../live/liveInstrument';
import type { LiveTimeframe } from '../state/livePage';
import type { InvestorNetPoint } from './types';

export type LiveIndexInvestorScope = 'market' | 'index' | 'none';

type LiveIndexWire = {
  kind: 'index';
  id: LiveIndexId;
  label: string;
  investor_scope: LiveIndexInvestorScope;
};

type LiveIndicesResponse = {
  indices: LiveIndexWire[];
};

export type LiveIndexEntry = {
  kind: 'index';
  id: LiveIndexId;
  label: string;
  investorScope: LiveIndexInvestorScope;
};

export interface LiveIndexCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LiveIndexCandlesWarning {
  batch: string;
  date?: string;
  reason: 'kis_rate_limit' | 'kis_api_error' | 'invariant_violation';
  msg: string;
}

export interface LiveIndexCandlesResponse {
  index_id: LiveIndexId;
  from: string;
  to: string;
  timeframe: LiveTimeframe;
  candles: LiveIndexCandle[];
  data_warnings: LiveIndexCandlesWarning[];
}

export interface LiveIndexInvestorNetResponse {
  index_id: LiveIndexId;
  from: string;
  to: string;
  points: InvestorNetPoint[];
  data_warnings: LiveIndexCandlesWarning[];
}

function mapIndex(row: LiveIndexWire): LiveIndexEntry {
  return {
    kind: 'index',
    id: row.id,
    label: row.label,
    investorScope: row.investor_scope,
  };
}

export function useLiveIndexCandles(
  indexId: LiveIndexId | null,
  timeframe: LiveTimeframe,
  from: string | null,
  to: string | null,
) {
  const enabled = !!(indexId && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'index-candles', indexId, timeframe, from, to] as const,
    queryFn: ({ signal }) =>
      apiCall<LiveIndexCandlesResponse>(
        `/api/live/index-candles?index_id=${indexId}&timeframe=${timeframe}&from=${from}&to=${to}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.index_id === indexId && prev.timeframe === timeframe ? prev : undefined),
  });
}

export function useLiveIndexInvestorNet(
  indexId: LiveIndexId | null,
  from: string | null,
  to: string | null,
  enabledByCaller: boolean,
) {
  const enabled = !!(enabledByCaller && indexId && from && to && from <= to);
  return useQuery({
    queryKey: ['live', 'index-investor-net', indexId, from, to] as const,
    queryFn: ({ signal }) =>
      apiCall<LiveIndexInvestorNetResponse>(
        `/api/live/index-investor-net?index_id=${indexId}&from=${from}&to=${to}`,
        { signal },
      ),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.index_id === indexId ? prev : undefined),
  });
}

export function useLiveIndices() {
  return useQuery({
    queryKey: ['live-indices'],
    staleTime: 60 * 60 * 1000,
    queryFn: async ({ signal }) => {
      const response = await apiCall<LiveIndicesResponse>('/api/live/indices', { signal });
      return response.indices.map(mapIndex);
    },
  });
}

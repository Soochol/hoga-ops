import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import type { LiveVenueOption } from '../state/liveVenue';
import { useKstDay } from '../util/useKstDay';
import { WATCHLIST_KEY } from '../watchlist/watchlistKeys';
import { HEATMAP_KEY } from '../heatmap/heatmapKeys';

export type PanelFlowSource = 'watchlist' | 'heatmap';
export interface PanelStockFlow {
  code: string;
  venue: string;
  pct: (number | null)[];
  last_observed_ms: number | null;
  missing_reason: string | null;
}
export interface PanelGroupFlow {
  folder_id: string;
  pct: (number | null)[];
  counts: number[];
  total: number;
}
export interface PanelFlowResponse {
  date: string;
  venue: string;
  bucket_ms: number;
  t_base_ms: number;
  as_of_ms: number;
  stocks: PanelStockFlow[];
  groups: PanelGroupFlow[];
}

export function usePanelFlow(source: PanelFlowSource, venue: LiveVenueOption, revision: string, enabled: boolean) {
  const day = useKstDay();
  const query = useQuery({
    // Namespaced under the list so its existing local/WS invalidations include
    // flow. Membership revision also prevents optimistic edits showing old means.
    queryKey: [...(source === 'watchlist' ? WATCHLIST_KEY : HEATMAP_KEY), 'panel-flow', venue, day, revision],
    queryFn: () => apiCall<PanelFlowResponse>(`/api/panel-flow?source=${source}&venue=${venue}`),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const byCode = useMemo(() => new Map((query.data?.stocks ?? []).map(stock => [stock.code, stock])), [query.data]);
  const byFolder = useMemo(() => new Map((query.data?.groups ?? []).map(group => [group.folder_id, group])), [query.data]);
  return { ...query, byCode, byFolder };
}

/** Only memberships matter, not order/name/search/quote ticks. */
export function panelFlowRevision(entries: readonly { code: string; folder_id: string | null }[]): string {
  return entries.map(entry => `${entry.folder_id}:${entry.code}`).sort().join(',');
}

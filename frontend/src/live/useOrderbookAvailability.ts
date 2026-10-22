import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { useLiveStatus } from '../api/liveStatus';
import type { LiveSeriesData } from '../api/liveSeries';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../api/liveness';
import { liveSubscriptionLimited, subscribeLiveAdmissionStatus, wsConnectedAt } from '../api/ws';
import type { LiveVenueOption } from '../state/liveVenue';
import { deriveOrderbookAvailability } from './orderbookAvailability';
import type { AftermarketExclusionResponse } from '../api/aftermarketExclusion';
import { aftermarketExclusionState } from './aftermarketExclusionState';

/** Uses the existing shared queries and transport; owns no vendor subscription. */
export function useOrderbookAvailability({ code, venue, live, bookMs, nowMs, enabled, exclusion }: {
  code: string; venue: LiveVenueOption; live: LiveSeriesData; bookMs?: number;
  nowMs: number; enabled: boolean;
  exclusion?: AftermarketExclusionResponse;
}) {
  const client = useQueryClient();
  const query = useLiveStatus({ enabled });
  const connected = useConnectionLiveness(LIVE_STALE_MS);
  const readAdmission = useCallback(() => liveSubscriptionLimited(code), [code]);
  const referenceLimited = useSyncExternalStore(subscribeLiveAdmissionStatus, readAdmission, readAdmission);
  const connectedAt = wsConnectedAt();
  const observedAt = query.data?.kiwoom?.observed_at_ms ?? query.dataUpdatedAt;
  const statusCurrent = !query.isError && query.dataUpdatedAt >= connectedAt
    && observedAt >= connectedAt && nowMs - query.dataUpdatedAt < LIVE_STALE_MS;
  const excluded = aftermarketExclusionState(exclusion, code, venue, nowMs, bookMs);
  const availability = excluded ?? (enabled ? deriveOrderbookAvailability({ code, venue, nowMs, bookMs,
    loading: live.isLoading, error: live.error, status: query.data, statusCurrent,
    connected, referenceLimited }) : null);
  const retry = () => { void client.invalidateQueries({ queryKey: ['live', 'series', code] }); };
  return { availability, retry };
}

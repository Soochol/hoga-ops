import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLiveStatus } from '../api/liveStatus';
import type { LiveSeriesData } from '../api/liveSeries';
import { useConnectionLiveness } from '../api/useConnectionLiveness';
import { LIVE_STALE_MS } from '../api/liveness';
import { liveSubscriptionLimited, subscribeLiveAdmissionStatus, wsConnectedAt } from '../api/ws';
import type { LiveVenueOption } from '../state/liveVenue';
import { deriveOrderbookAvailability, recentBookEvidence } from './orderbookAvailability';
import { realMsToYyyymmdd } from './liveDateTime';
import { confirmBookRecovered, recoverBook, retainBookRecovery } from './bookRecovery';
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
    && observedAt >= connectedAt && nowMs - observedAt >= -5_000
    && nowMs - observedAt < LIVE_STALE_MS && nowMs - query.dataUpdatedAt < LIVE_STALE_MS;
  const excluded = aftermarketExclusionState(exclusion, code, venue, nowMs, bookMs);
  const derived = excluded ?? (enabled ? deriveOrderbookAvailability({ code, venue, nowMs, bookMs,
    loading: live.isLoading, error: live.error, status: query.data, statusCurrent,
    connected, referenceLimited, statusFailed: query.isError, browserReceivedMs: live.bookReceivedAtMs }) : null);
  const availability = derived && { ...derived, diagnostics: { code, venue, bookMs,
    browserReceivedMs: live.bookReceivedAtMs,
    serverReceivedMs: statusCurrent ? query.data?.kiwoom?.data_received_ms?.[`${code}:${venue}:ob`] : undefined,
    serverObservedMs: statusCurrent ? observedAt : undefined, checkedAtMs: nowMs, message: derived.message } };
  const date = realMsToYyyymmdd(nowMs);
  useEffect(() => enabled ? retainBookRecovery(client, { code, date, venue }) : undefined,
    [client, code, date, venue, enabled, connectedAt]);
  useEffect(() => {
    if (!enabled) return;
    const scope = { code, date, venue };
    if (recentBookEvidence(bookMs, nowMs)) confirmBookRecovered(client, scope);
    else if (availability?.kind === 'display_delayed') recoverBook(client, scope, nowMs);
  }, [client, code, date, venue, enabled, bookMs, nowMs, availability?.kind]);
  const retry = () => { void client.invalidateQueries({ queryKey: ['live', 'series', code, date, venue], exact: true },
    { cancelRefetch: false }); };
  return { availability, retry };
}

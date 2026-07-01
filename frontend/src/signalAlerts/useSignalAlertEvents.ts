import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signalAlertRecentKey, type SignalAlertEvent, type SignalAlertRecentResponse } from '../api/signalAlerts';
import type { PushEvent } from '../api/types';
import { subscribeEvents } from '../api/ws';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';

const seenSignalAlertIds = new Set<string>();

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

export function useSignalAlertEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeEvents((event) => {
      if (!isSignalAlert(event)) return;

      const isFirstSeen = !seenSignalAlertIds.has(event.id);
      const key = signalAlertRecentKey(event.date);
      let shouldCountUnread = false;

      queryClient.setQueryData<SignalAlertRecentResponse>(key, (cached) => {
        if (!cached) {
          shouldCountUnread = isFirstSeen;
          return {
            date: event.date,
            scope: 'inbox',
            cleared_through_seq: 0,
            alerts: [event],
          };
        }

        if (event.seq <= cached.cleared_through_seq) return cached;
        if (cached.alerts.some((alert) => alert.id === event.id)) return cached;
        shouldCountUnread = isFirstSeen;
        return { ...cached, alerts: [event, ...cached.alerts] };
      });

      if (isFirstSeen) seenSignalAlertIds.add(event.id);
      if (shouldCountUnread) useSignalAlertInboxStore.getState().noteIncoming(event);
    });
  }, [queryClient]);
}

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signalAlertRecentKey, type SignalAlertEvent, type SignalAlertRecentResponse } from '../api/signalAlerts';
import type { PushEvent } from '../api/types';
import { subscribeEvents } from '../api/ws';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';

function isSignalAlert(event: PushEvent): event is SignalAlertEvent {
  return event.type === 'signal_alert';
}

export function useSignalAlertEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeEvents((event) => {
      if (!isSignalAlert(event)) return;

      const key = signalAlertRecentKey(event.date);
      const current = queryClient.getQueryData<SignalAlertRecentResponse>(key);
      const isDuplicate = current?.alerts.some((alert) => alert.id === event.id) ?? false;

      if (!isDuplicate) {
        useSignalAlertInboxStore.getState().noteIncoming(event);
      }

      queryClient.setQueryData<SignalAlertRecentResponse>(key, (cached) => {
        if (!cached) {
          return {
            date: event.date,
            scope: 'inbox',
            cleared_through_seq: 0,
            alerts: [event],
          };
        }

        if (cached.alerts.some((alert) => alert.id === event.id)) return cached;
        return { ...cached, alerts: [event, ...cached.alerts] };
      });
    });
  }, [queryClient]);
}

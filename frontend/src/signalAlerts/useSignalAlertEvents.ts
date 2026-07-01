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

      useSignalAlertInboxStore.getState().noteIncoming(event);
      queryClient.setQueryData<SignalAlertRecentResponse>(signalAlertRecentKey(event.date), (current) => {
        if (!current) {
          return {
            date: event.date,
            scope: 'inbox',
            cleared_through_seq: 0,
            alerts: [event],
          };
        }

        if (current.alerts.some((alert) => alert.id === event.id)) return current;
        return { ...current, alerts: [event, ...current.alerts] };
      });
    });
  }, [queryClient]);
}

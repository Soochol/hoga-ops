import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushEvent } from '../api/types';
import { signalAlertRecentKey, type SignalAlertRecentResponse } from '../api/signalAlerts';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';
import { useSignalAlertEvents } from './useSignalAlertEvents';

const subs: Array<(event: PushEvent) => void> = [];

vi.mock('../api/ws', () => ({
  subscribeEvents: (cb: (event: PushEvent) => void) => {
    subs.push(cb);
    return () => {
      const index = subs.indexOf(cb);
      if (index >= 0) subs.splice(index, 1);
    };
  },
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useSignalAlertEvents', () => {
  beforeEach(() => {
    subs.length = 0;
    useSignalAlertInboxStore.setState({ unreadCount: 0, lastSeenAtMs: 0 });
  });

  it('increments unread and seeds the recent inbox cache on signal_alert events', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useSignalAlertEvents(), { wrapper: createWrapper(queryClient) });

    act(() => {
      subs[0]({
        type: 'signal_alert',
        id: 'a',
        signal: 'sell_total_renewal',
        seq: 1,
        code: '005930',
        name: '삼성전자',
        t_ms: 1,
        date: '20260701',
        source: 'ws',
        value: 1000,
        baseline: 1000,
        ratio_pct: 100,
        use_intra_minute_max: true,
      });
    });

    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(1);
    expect(queryClient.getQueryData<SignalAlertRecentResponse>(signalAlertRecentKey('20260701'))).toMatchObject({
      date: '20260701',
      scope: 'inbox',
      alerts: [{ id: 'a', code: '005930', name: '삼성전자' }],
    });
  });

  it('prepends new signal alerts without duplicating ids already in cache', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<SignalAlertRecentResponse>(signalAlertRecentKey('20260701'), {
      date: '20260701',
      scope: 'inbox',
      cleared_through_seq: 0,
      alerts: [
        {
          type: 'signal_alert',
          id: 'existing',
          signal: 'sell_total_renewal',
          seq: 1,
          code: '000660',
          name: 'SK하이닉스',
          t_ms: 1,
          date: '20260701',
          source: 'rest',
          value: 2000,
          baseline: 1000,
          ratio_pct: 200,
          use_intra_minute_max: true,
        },
      ],
    });

    renderHook(() => useSignalAlertEvents(), { wrapper: createWrapper(queryClient) });

    act(() => {
      subs[0]({
        type: 'signal_alert',
        id: 'new',
        signal: 'sell_total_renewal',
        seq: 2,
        code: '005930',
        name: '삼성전자',
        t_ms: 2,
        date: '20260701',
        source: 'ws',
        value: 3000,
        baseline: 1000,
        ratio_pct: 300,
        use_intra_minute_max: true,
      });
      subs[0]({
        type: 'signal_alert',
        id: 'existing',
        signal: 'sell_total_renewal',
        seq: 1,
        code: '000660',
        name: 'SK하이닉스',
        t_ms: 1,
        date: '20260701',
        source: 'ws',
        value: 2000,
        baseline: 1000,
        ratio_pct: 200,
        use_intra_minute_max: true,
      });
    });

    expect(queryClient.getQueryData<SignalAlertRecentResponse>(signalAlertRecentKey('20260701'))?.alerts.map((alert) => alert.id)).toEqual([
      'new',
      'existing',
    ]);
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(1);
  });
});

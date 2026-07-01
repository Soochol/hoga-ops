import { beforeEach, describe, expect, it } from 'vitest';
import type { SignalAlertEvent } from '../api/signalAlerts';
import { useSignalAlertInboxStore } from './signalAlertInbox';

const event: SignalAlertEvent = {
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
};

describe('signalAlertInbox store', () => {
  beforeEach(() => {
    useSignalAlertInboxStore.setState({ unreadCount: 0, lastSeenAtMs: 0 });
  });

  it('increments unread for incoming alerts and resets on panel seen', () => {
    useSignalAlertInboxStore.getState().noteIncoming(event);
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(1);

    useSignalAlertInboxStore.getState().markPanelSeen();
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);
  });

  it('resets unread after clear', () => {
    useSignalAlertInboxStore.getState().noteIncoming(event);
    useSignalAlertInboxStore.getState().resetForClear('20260701');

    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);
  });
});

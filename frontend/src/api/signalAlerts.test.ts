import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  apiCall: vi.fn(),
}));

import { apiCall } from './client';
import { clearTodaySignalAlerts, getSignalAlertRecent, patchSignalAlertSettings } from './signalAlerts';

describe('signalAlerts api', () => {
  beforeEach(() => vi.mocked(apiCall).mockReset());

  it('requests inbox recent alerts by date', async () => {
    vi.mocked(apiCall).mockResolvedValue({
      date: '20260701',
      scope: 'inbox',
      cleared_through_seq: 0,
      alerts: [],
    });

    await getSignalAlertRecent('20260701');

    expect(apiCall).toHaveBeenCalledWith('/api/signal-alerts/recent?date=20260701&limit=100&scope=inbox');
  });

  it('patches settings', async () => {
    vi.mocked(apiCall).mockResolvedValue({});

    await patchSignalAlertSettings({
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });

    expect(apiCall).toHaveBeenCalledWith(
      '/api/signal-alerts/settings',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('clears today inbox by date', async () => {
    vi.mocked(apiCall).mockResolvedValue({ date: '20260701', cleared_through_seq: 2 });

    await clearTodaySignalAlerts('20260701');

    expect(apiCall).toHaveBeenCalledWith('/api/signal-alerts/clear-today?date=20260701', { method: 'POST' });
  });
});

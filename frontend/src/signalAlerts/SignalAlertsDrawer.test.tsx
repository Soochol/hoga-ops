import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignalAlertsDrawer from './SignalAlertsDrawer';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';
import * as signalAlerts from '../api/signalAlerts';
import { apiCall } from '../api/client';

vi.mock('../api/client', () => ({
  apiCall: vi.fn(),
}));

vi.mock('../api/signalAlerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/signalAlerts')>();
  return {
    ...actual,
    useClearSignalAlertToday: vi.fn(),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

describe('SignalAlertsDrawer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSignalAlertInboxStore.setState({ unreadCount: 3, lastSeenAtMs: 0 });
  });

  it('uses the clear response sequence in cache when clearing the inbox', async () => {
    const clearToday = vi.fn((_vars: undefined, options?: { onSuccess?: (result: { date: string; cleared_through_seq: number }) => void }) => {
      options?.onSuccess?.({ date: '20260701', cleared_through_seq: 7 });
    });
    vi.mocked(apiCall).mockResolvedValue({
      date: '20260701',
      scope: 'inbox',
      cleared_through_seq: 0,
      alerts: [
        {
          type: 'signal_alert',
          id: 'newer',
          signal: 'sell_total_renewal',
          seq: 2,
          code: '000660',
          name: 'SK하이닉스',
          t_ms: 1_719_819_300_000,
          date: '20260701',
          source: 'rest',
          value: 2_450_000,
          baseline: 2_000_000,
          ratio_pct: 122.5,
          use_intra_minute_max: true,
        },
        {
          type: 'signal_alert',
          id: 'after-clear',
          signal: 'sell_total_renewal',
          seq: 8,
          code: '005930',
          name: '삼성전자',
          t_ms: 1_719_819_310_000,
          date: '20260701',
          source: 'ws',
          value: 3_000_000,
          baseline: 2_000_000,
          ratio_pct: 150,
          use_intra_minute_max: true,
        },
      ],
    });
    vi.mocked(signalAlerts.useClearSignalAlertToday).mockReturnValue({
      mutate: clearToday,
      isPending: false,
    } as unknown as ReturnType<typeof signalAlerts.useClearSignalAlertToday>);

    const { qc } = renderWithProviders(<SignalAlertsDrawer today="20260701" />);

    expect(await screen.findByText('SK하이닉스')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '오늘 인박스 비우기' }));
    fireEvent.click(screen.getByRole('button', { name: '비우기 확인' }));

    await waitFor(() => {
      expect(qc.getQueryData(signalAlerts.signalAlertRecentKey('20260701'))).toMatchObject({
        cleared_through_seq: 7,
        alerts: [{ id: 'after-clear', seq: 8 }],
      });
    });
    expect(screen.queryByText('오늘 알림이 없습니다.')).not.toBeInTheDocument();
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);
  });
});

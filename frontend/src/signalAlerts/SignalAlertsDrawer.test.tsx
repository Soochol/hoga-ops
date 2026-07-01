import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SignalAlertsDrawer from './SignalAlertsDrawer';
import * as api from '../api/signalAlerts';
import { useSignalAlertInboxStore } from '../state/signalAlertInbox';

const jumpToLive = vi.fn();

vi.mock('../live/useJumpToLive', () => ({
  useJumpToLive: () => jumpToLive,
}));

vi.mock('../api/signalAlerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/signalAlerts')>();
  return {
    ...actual,
    useSignalAlertRecent: vi.fn(),
    useClearSignalAlertToday: vi.fn(),
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SignalAlertsDrawer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    jumpToLive.mockReset();
    useSignalAlertInboxStore.setState({ unreadCount: 3, lastSeenAtMs: 0 });
  });

  it('renders alerts newest first, jumps to live on click, and clears the visible inbox', async () => {
    const mutate = vi.fn((_vars: undefined, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });
    vi.mocked(api.useSignalAlertRecent).mockReturnValue({
      data: {
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
            id: 'older',
            signal: 'sell_total_renewal',
            seq: 1,
            code: '005930',
            name: '삼성전자',
            t_ms: 1_719_819_000_000,
            date: '20260701',
            source: 'ws',
            value: 1_240_000,
            baseline: 1_200_000,
            ratio_pct: 103.3,
            use_intra_minute_max: true,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof api.useSignalAlertRecent>);
    vi.mocked(api.useClearSignalAlertToday).mockReturnValue({
      mutate,
      isPending: false,
    } as ReturnType<typeof api.useClearSignalAlertToday>);

    renderWithProviders(<SignalAlertsDrawer today="20260701" />);

    expect(await screen.findByText('SK하이닉스')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /차트 열기$/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('SK하이닉스');
    expect(rows[1]).toHaveTextContent('삼성전자');

    fireEvent.click(rows[0]);
    expect(jumpToLive).toHaveBeenCalledWith('000660', 'SK하이닉스');
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '오늘 인박스 비우기' }));
    fireEvent.click(screen.getByRole('button', { name: '비우기 확인' }));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('오늘 알림이 없습니다.')).toBeInTheDocument());
    expect(useSignalAlertInboxStore.getState().unreadCount).toBe(0);
  });
});

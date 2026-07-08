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

  it('collapses repeated codes into one row (×N badge, peak ratio) and emphasizes strong ratios', async () => {
    const mk = (over: Partial<signalAlerts.SignalAlertEvent> & { id: string; code: string; t_ms: number }) => ({
      type: 'signal_alert' as const, signal: 'sell_total_renewal' as const, seq: over.t_ms,
      name: over.code, date: '20260701', source: 'ws' as const, value: 1000, baseline: 1000,
      ratio_pct: 100, use_intra_minute_max: false, ...over,
    });
    vi.mocked(apiCall).mockResolvedValue({
      date: '20260701', scope: 'inbox', cleared_through_seq: 0,
      alerts: [
        mk({ id: 'k1', code: '003490', name: '대한항공', t_ms: 100, ratio_pct: 107 }),
        mk({ id: 'k2', code: '003490', name: '대한항공', t_ms: 300, ratio_pct: 125, value: 999 }),
        mk({ id: 'k3', code: '005440', name: '현대지에프홀딩스', t_ms: 200, ratio_pct: 118.6 }),
      ],
    });
    vi.mocked(signalAlerts.useClearSignalAlertToday).mockReturnValue({
      mutate: vi.fn(), isPending: false,
    } as unknown as ReturnType<typeof signalAlerts.useClearSignalAlertToday>);

    renderWithProviders(<SignalAlertsDrawer today="20260701" />);

    // 대한항공 2회 발화 → 한 행 + ×2 배지, 최고 강도(125.0%)만 표시.
    expect(await screen.findByText('대한항공')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
    const strong = screen.getByText('125.0%');
    expect(strong.className).toContain('text-price-down'); // ≥120 강조
    expect(screen.queryByText('107.0%')).toBeNull();       // 접힌 약한 발화는 숨김
    // 헤더: 총 3건 · 2종목.
    const header = screen.getByText(/3건/);
    expect(header.textContent).toContain('2종목');
  });
});

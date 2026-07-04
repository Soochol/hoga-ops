import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import KisRestUnavailableToastHost from './KisRestUnavailableToastHost';
import {
  LIVE_SETTINGS_KEY,
  type LiveSettings,
} from '../api/liveSettings';
import * as apiClient from '../api/client';
import * as kisRestMode from '../state/kisRestMode';

function renderWithClient(settings?: LiveSettings) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (settings) qc.setQueryData(LIVE_SETTINGS_KEY, settings);
  return render(
    <QueryClientProvider client={qc}>
      <KisRestUnavailableToastHost />
    </QueryClientProvider>,
  );
}

describe('KisRestUnavailableToastHost', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    kisRestMode.useKisRestModeStore.setState({
      lastFailureAtMs: null,
      lastToastAtMs: null,
    });
  });

  it('shows a KIS connection toast and toggles backend bypass mode', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: true,
    });
    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
    });

    act(() => {
      kisRestMode.useKisRestModeStore.getState().notifyFailure(1_000);
    });

    expect(screen.getByRole('status')).toHaveTextContent('KIS 연결 불가');
    const toggle = screen.getByRole('switch', { name: 'KIS API 우회' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kis_rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'KIS API 우회' })).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('KIS REST 우회 중')).toBeInTheDocument();
  });

  it('does not render before a failure notification', () => {
    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('migrates legacy local bypass into backend settings once', async () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ kisRestBypassEnabled: true }));
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: true,
    });
    const markSpy = vi.spyOn(kisRestMode, 'markLegacyKisRestBypassMigrated');

    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
    });

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kis_rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(markSpy).toHaveBeenCalled());
  });
});

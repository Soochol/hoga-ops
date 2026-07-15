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
      toastDismissed: false,
    });
  });

  it('shows a KIS connection toast, enables bypass, and auto-dismisses the toast', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: true,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
    });
    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
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
    // 우회가 켜지면 토스트 목적이 달성되므로 자동으로 닫힌다.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(kisRestMode.useKisRestModeStore.getState().toastDismissed).toBe(true);
  });

  it('dismisses the toast via the close button without enabling bypass', () => {
    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
    });

    act(() => {
      kisRestMode.useKisRestModeStore.getState().notifyFailure(1_000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    // 닫으면 사라지지만 우회는 여전히 OFF(사용자가 KIS 복구를 기다리는 선택).
    expect(screen.queryByRole('status')).toBeNull();
    expect(kisRestMode.useKisRestModeStore.getState().toastDismissed).toBe(true);
    expect(kisRestMode.useKisRestModeStore.getState().lastToastAtMs).toBe(1_000);
  });

  it('re-shows the toast on a fresh failure after the cooldown, even once dismissed', () => {
    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
    });

    act(() => {
      kisRestMode.useKisRestModeStore.getState().notifyFailure(1_000);
    });
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('status')).toBeNull();

    // 쿨다운(5분) 내 재실패는 닫힌 상태 존중 → 재노출 안 함.
    act(() => {
      kisRestMode.useKisRestModeStore.getState().notifyFailure(1_000 + 60_000);
    });
    expect(screen.queryByRole('status')).toBeNull();

    // 쿨다운 경과 후 재실패는 다시 띄운다.
    act(() => {
      kisRestMode.useKisRestModeStore.getState().notifyFailure(1_000 + kisRestMode.KIS_REST_FAILURE_TOAST_COOLDOWN_MS + 1);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not render before a failure notification', () => {
    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
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
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
    });
    const markSpy = vi.spyOn(kisRestMode, 'markLegacyKisRestBypassMigrated');

    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
    });

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kis_rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(markSpy).toHaveBeenCalled());
  });

  it('keeps legacy local bypass when backend migration patch fails', async () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ kisRestBypassEnabled: true }));
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockRejectedValue(new Error('patch failed'));
    const markSpy = vi.spyOn(kisRestMode, 'markLegacyKisRestBypassMigrated');

    renderWithClient({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
      kis_rest_bypass_enabled: false,
      heatmap_capture_enabled: true,
      screener_depth_autocollect: false,
    });

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kis_rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(localStorage.getItem('chart.kisRestMode.v1')).not.toBeNull());
    expect(localStorage.getItem('chart.kisRestMode.v1')).toContain('true');
    expect(localStorage.getItem('chart.kisRestMode.v1.migrated')).toBeNull();
    expect(markSpy).not.toHaveBeenCalled();
  });
});

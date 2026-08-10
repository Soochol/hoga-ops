import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RestUnavailableToastHost from './RestUnavailableToastHost';
import {
  LIVE_SETTINGS_KEY,
  type LiveSettings,
} from '../api/liveSettings';
import * as apiClient from '../api/client';
import * as restBypassMode from '../state/restBypassMode';

function renderWithClient(settings?: LiveSettings) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (settings) qc.setQueryData(LIVE_SETTINGS_KEY, settings);
  return render(
    <QueryClientProvider client={qc}>
      <RestUnavailableToastHost />
    </QueryClientProvider>,
  );
}

describe('RestUnavailableToastHost', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    restBypassMode.useRestBypassModeStore.setState({
      lastFailureAtMs: null,
      lastToastAtMs: null,
      lastKind: null,
      toastDismissed: false,
    });
  });

  it('shows a connection toast, enables bypass, and auto-dismisses the toast', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({
      schema_version: 1,
      rest_bypass_enabled: true,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });
    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    });

    expect(screen.getByRole('status')).toHaveTextContent('시세 서버 연결 불가');
    const toggle = screen.getByRole('switch', { name: 'REST 우회' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rest_bypass_enabled: true }),
    }));
    // 우회가 켜지면 토스트 목적이 달성되므로 자동으로 닫힌다.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(restBypassMode.useRestBypassModeStore.getState().toastDismissed).toBe(true);
  });

  it('dismisses the toast via the close button without enabling bypass', () => {
    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    // 닫으면 사라지지만 우회는 여전히 OFF(사용자가 KIS 복구를 기다리는 선택).
    expect(screen.queryByRole('status')).toBeNull();
    expect(restBypassMode.useRestBypassModeStore.getState().toastDismissed).toBe(true);
    expect(restBypassMode.useRestBypassModeStore.getState().lastToastAtMs).toBe(1_000);
  });

  it('re-shows the toast on a fresh failure after the cooldown, even once dismissed', () => {
    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    });
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('status')).toBeNull();

    // 쿨다운(5분) 내 재실패는 닫힌 상태 존중 → 재노출 안 함.
    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('transport', 1_000 + 60_000);
    });
    expect(screen.queryByRole('status')).toBeNull();

    // 쿨다운 경과 후 재실패는 다시 띄운다.
    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('transport', 1_000 + restBypassMode.REST_FAILURE_TOAST_COOLDOWN_MS + 1);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('does not render before a failure notification', () => {
    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('migrates legacy local bypass into backend settings once', async () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ restBypassEnabled: true }));
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({
      schema_version: 1,
      rest_bypass_enabled: true,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });
    const markSpy = vi.spyOn(restBypassMode, 'markLegacyRestBypassMigrated');

    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(markSpy).toHaveBeenCalled());
  });

  it('keeps legacy local bypass when backend migration patch fails', async () => {
    localStorage.setItem('chart.kisRestMode.v1', JSON.stringify({ restBypassEnabled: true }));
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockRejectedValue(new Error('patch failed'));
    const markSpy = vi.spyOn(restBypassMode, 'markLegacyRestBypassMigrated');

    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(localStorage.getItem('chart.kisRestMode.v1')).not.toBeNull());
    expect(localStorage.getItem('chart.kisRestMode.v1')).toContain('true');
    expect(localStorage.getItem('chart.restBypassMode.v1.migrated')).toBeNull();
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('says congestion, not unreachable, when the server is merely busy', () => {
    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('congestion', 1_000);
    });

    // 서버는 멀쩡하다 — "연결 불가" 로 표시하면 사용자의 판단(기다릴까 우회할까)이
    // 뒤집힌다(ADR-0137).
    //
    // 제목은 **원인**을 말한다(ADR-0143 §5-A) — 예전엔 '시세 서버 혼잡'(상태)이라
    // 스크리너의 '호출 한도 초과'와 같은 kind 를 다르게 불렀다. 본문이 이미 상태를
    // 서술하므로 제목까지 상태일 이유가 없다. 이 단언과 `intradayDegradation.test`
    // 쪽 단언이 같은 리터럴을 못 박는다.
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('호출 한도 초과');
    expect(toast).not.toHaveTextContent('연결할 수 없습니다');
    expect(toast).toHaveTextContent('대기 중');
  });

  it('keeps the unreachable copy for a real transport failure', () => {
    renderWithClient({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });

    act(() => {
      restBypassMode.useRestBypassModeStore.getState().notifyFailure('transport', 1_000);
    });

    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('시세 서버 연결 불가');
    expect(toast).toHaveTextContent('저장 데이터로 표시할 수 있습니다');
  });
});

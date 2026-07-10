import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataSourceDetail } from './DataSourceDetail';
import { useLiveVenueStore } from '../../state/liveVenue';
import * as liveSettingsApi from '../../api/liveSettings';
import * as apiClient from '../../api/client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function freshQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const SETTINGS = {
  schema_version: 1,
  storage_policy: 'ws_plus_rest' as const,
  program_trade_storage_enabled: false,
  kis_rest_bypass_enabled: false,
  heatmap_capture_enabled: true,
};

describe('DataSourceDetail (메인 Settings·복기뷰 공용)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('KIS 캔들 venue 옵션을 렌더하고 저장한다 (live)', () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);
    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    expect(screen.getByLabelText('KRX')).toBeChecked();
    expect(screen.getByLabelText('통합')).toBeInTheDocument();
    expect(screen.queryByLabelText('NXT')).toBeNull();   // NXT venue 제거(#523)

    fireEvent.click(screen.getByLabelText('통합'));
    expect(useLiveVenueStore.getState().venue).toBe('UN');
    expect(localStorage.getItem('live.venue.v1')).toContain('UN');
  });

  it('상세를 캔들/호가체결/스크리너 일봉 + 표시/캡처 매크로 그룹으로 구조화한다 (live)', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);
    vi.spyOn(liveSettingsApi, 'patchLiveSettings').mockResolvedValue({ ...SETTINGS, storage_policy: 'rest_only' });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByText('데이터 저장 방식')).toBeInTheDocument();
    expect(screen.getByText('표시 소스')).toBeInTheDocument();
    expect(screen.getByText('캡처 저장')).toBeInTheDocument();
    expect(screen.getByText('캔들 데이터 기준')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'KIS API 우회' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '자동' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '스크리너 일봉 우선' })).toBeNull();
    expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
    expect(screen.getByText('스크리너 일봉 데이터')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'WS만 저장' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'WS 우선 + 나머지 REST 저장' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'REST만 저장' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'hogaplay 우선' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'KIS WS 우선' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'KIS API 우선' })).toBeInTheDocument();
    expect(screen.getByText(/'KIS API 우회'를 켜면 분봉은 캡처\(hogaplay\)/)).toBeInTheDocument();
  });

  it('study variant는 캔들 기준 라디오 대신 디스크 온리 안내문을 표시하고 거래소를 숨긴다', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="study" />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByTestId('study-candle-source-note')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '자동' })).toBeNull();
    expect(screen.queryByText('KIS 캔들 거래소')).toBeNull();
    expect(screen.queryByLabelText('KRX')).toBeNull();
    expect(screen.queryByLabelText('NXT')).toBeNull();
    // 호가·체결 기준은 study에서도 유지(사이드카가 소비).
    expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'KIS WS 우선' })).toBeInTheDocument();
  });

  it('KIS API 우회 토글을 backend settings로 저장한다', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, kis_rest_bypass_enabled: true });
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    const toggle = await screen.findByRole('switch', { name: 'KIS API 우회' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kis_rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'KIS API 우회' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('프로그램 순매수 저장 토글을 REST 허용 정책에서만 켠다', async () => {
    const qc = freshQc();
    qc.setQueryData(liveSettingsApi.LIVE_SETTINGS_KEY, SETTINGS);
    const apiCall = vi.spyOn(apiClient, 'apiCall')
      .mockResolvedValueOnce(SETTINGS)
      .mockResolvedValueOnce({ ...SETTINGS, program_trade_storage_enabled: true });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(qc) });
    const toggle = await screen.findByRole('switch', { name: '프로그램 순매수 저장' });

    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_policy: 'ws_plus_rest',
        program_trade_storage_enabled: true,
      }),
    }));
  });

  it('WS만 저장 정책에서는 프로그램 순매수 저장 토글을 비활성화한다', async () => {
    const qc = freshQc();
    qc.setQueryData(liveSettingsApi.LIVE_SETTINGS_KEY, { ...SETTINGS, storage_policy: 'ws_only' });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(qc) });

    expect(await screen.findByRole('switch', { name: '프로그램 순매수 저장' })).toBeDisabled();
  });
});

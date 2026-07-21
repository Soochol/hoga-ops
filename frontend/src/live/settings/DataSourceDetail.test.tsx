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
  kis_rest_bypass_enabled: false,
  screener_depth_autocollect: false,
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
    expect(screen.getByLabelText('시간대 자동')).toBeInTheDocument();
    expect(screen.queryByLabelText('NXT')).toBeNull();   // NXT venue 제거(#523)

    fireEvent.click(screen.getByLabelText('시간대 자동'));
    expect(useLiveVenueStore.getState().venue).toBe('UN');
    expect(localStorage.getItem('live.venue.v1')).toContain('UN');
  });

  it('상세를 캔들/호가체결/스크리너 일봉 + 표시/캡처 매크로 그룹으로 구조화한다 (live)', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByText('표시 소스')).toBeInTheDocument();
    expect(screen.getByText('캡처 저장')).toBeInTheDocument();
    expect(screen.getByText('캔들 데이터 기준')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'KIS API 우회' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '자동' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '스크리너 일봉 우선' })).toBeNull();
    expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
    expect(screen.getByText('스크리너 일봉 데이터')).toBeInTheDocument();
    // 저장 방식 라디오(storage_policy)는 폐지(2026-07-17: 관심종목=KIS WS·히트맵=키움 WS 고정).
    expect(screen.queryByText('데이터 저장 방식')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'WS만 저장' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'WS 우선 + 나머지 REST 저장' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'REST만 저장' })).toBeNull();
    // 호가·체결 기준 라디오는 2개 — kis_api_first(KIS API 우선) 제거.
    expect(screen.getByRole('radio', { name: 'hogaplay 우선' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '실시간 WS 우선' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'KIS API 우선' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'KIS WS 우선' })).toBeNull();
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
    expect(screen.getByRole('radio', { name: '실시간 WS 우선' })).toBeInTheDocument();
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

  it('프로그램 순매수 저장은 토글 없이 항시 저장 안내만 보인다 (스위치 폐지 2026-07-21)', async () => {
    const qc = freshQc();
    qc.setQueryData(liveSettingsApi.LIVE_SETTINGS_KEY, SETTINGS);
    vi.spyOn(apiClient, 'apiCall').mockImplementation((url: string) =>
      url.includes('/status')
        ? Promise.resolve({ running: false, live_set: [], capture_reason: 'offline', kiwoom: null })
        : Promise.resolve(SETTINGS),
    );

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(qc) });

    expect(await screen.findByText('항시 저장 중입니다.')).toBeInTheDocument();
    // 키움 0w push 전환으로 수집 비용이 0 — 거래원(0F)처럼 스위치 자체가 없다.
    expect(screen.queryByRole('switch', { name: '프로그램 순매수 저장' })).toBeNull();
  });

  it('키움 상태줄에 연결 계정·수집 종목 수를 보인다 (활성화 스위치 폐지, ADR-0118)', async () => {
    const qc = freshQc();
    // 활성화 토글은 없다 — 상태줄은 status.kiwoom 관측에서 항상 조립된다.
    vi.spyOn(apiClient, 'apiCall').mockImplementation((url: string) => {
      if (url.includes('/status')) {
        return Promise.resolve({
          running: true, live_set: [], capture_reason: 'ok',
          kiwoom: { enabled: true, accounts_configured: 2, connected_accounts: 1, subscribed_count: 190, last_tick_ms: null, accounts: [] },
        });
      }
      return Promise.resolve({ ...SETTINGS });
    });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(qc) });

    // 상태줄은 처음 '상태 확인 중'으로 뜨고 status 쿼리 해결 후 내용이 채워진다.
    await waitFor(() =>
      expect(screen.getByTestId('kiwoom-status-line')).toHaveTextContent('연결 1/2계정'),
    );
    expect(screen.getByTestId('kiwoom-status-line')).toHaveTextContent('수집 190종목');
    // 토글 스위치는 더 이상 렌더되지 않는다.
    expect(screen.queryByRole('switch', { name: /키움/ })).toBeNull();
  });

  it('키움 앱키 미설정(status.kiwoom=null)이면 .env 안내 문구를 보인다', async () => {
    const qc = freshQc();
    vi.spyOn(apiClient, 'apiCall').mockImplementation((url: string) => {
      if (url.includes('/status')) {
        return Promise.resolve({
          running: false, live_set: [], capture_reason: 'offline', kiwoom: null,
        });
      }
      return Promise.resolve({ ...SETTINGS });
    });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(qc) });

    await waitFor(() =>
      expect(screen.getByTestId('kiwoom-status-line')).toHaveTextContent('키움 앱키 미설정'),
    );
    expect(screen.getByTestId('kiwoom-status-line')).toHaveTextContent('KIWOOM_APP_KEY');
  });
});

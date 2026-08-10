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
  rest_bypass_enabled: false,
  screener_depth_autocollect: false,
  krx_prefer_hogaplay: false,
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

    // 라벨 문구가 아니라 **data-testid 의 원값**으로 잡는다 — 문구는 바뀌지만
    // 저장 키('KRX'/'NXT'/'UN')는 계약이다(#1083 규율).
    expect(screen.getByTestId('live-venue-KRX')).toBeChecked();
    expect(screen.getByTestId('live-venue-NXT')).toBeInTheDocument();  // NXT 부활(ADR-0140 §5)
    expect(screen.getByTestId('live-venue-UN')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('live-venue-NXT'));
    expect(useLiveVenueStore.getState().venue).toBe('NXT');
    expect(localStorage.getItem('live.venue.v1')).toContain('NXT');
  });

  it('상세를 캔들/호가체결/스크리너 일봉 + 표시/캡처 매크로 그룹으로 구조화한다 (live)', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByText('표시 소스')).toBeInTheDocument();
    expect(screen.getByText('캡처 저장')).toBeInTheDocument();
    expect(screen.getByText('캔들 데이터 기준')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'REST 우회' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '자동' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '스크리너 일봉 우선' })).toBeNull();
    // 「호가·체결 데이터 기준」 그룹은 **라디오 3종이 폐지되고 옵트인 토글 하나로**
    // 돌아왔다(2026-08-07 오후). 라디오가 venue 비교를 깨뜨린 사실은 그대로이므로
    // 기본은 키움 고정이고, hogaplay 는 사용자가 명시적으로 켤 때만 이긴다.
    expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'KRX에서 hogaplay 우선' }),
    ).toBeInTheDocument();
    expect(screen.getByText('스크리너 일봉 데이터')).toBeInTheDocument();
    // 저장 방식 라디오(storage_policy)는 폐지(2026-07-17: 관심종목=KIS WS·히트맵=키움 WS 고정).
    expect(screen.queryByText('데이터 저장 방식')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'WS만 저장' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'WS 우선 + 나머지 REST 저장' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'REST만 저장' })).toBeNull();
    // 소스 선호 라디오는 전부 사라졌다 — 정답이 하나면 옵션이 아니라 동작이다.
    for (const name of ['hogaplay 우선', '실시간 WS 우선', '완결성 우선', 'KIS API 우선']) {
      expect(screen.queryByRole('radio', { name })).toBeNull();
    }
    expect(screen.getByText(/'REST 우회'를 켜면 분봉은 캡처\(hogaplay\)/)).toBeInTheDocument();
  });

  it('study variant는 캔들 기준 라디오 대신 디스크 온리 안내문을 표시한다', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="study" />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByTestId('study-candle-source-note')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '자동' })).toBeNull();
    expect(screen.queryByText('KIS 캔들 거래소')).toBeNull();
    // 호가·체결 기준 그룹은 study 에서도 보인다 — 오히려 복기뷰가 과거 데이터를 보는
    // 화면이라 이 토글이 더 쓸모 있다. 폐지된 것은 라디오 3종이지 그룹이 아니다.
    expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '실시간 WS 우선' })).toBeNull();
  });

  it('study variant는 거래소 선택기 대신 KRX 고정 안내를 보여준다 (ADR-0144)', async () => {
    // 선택기가 쓰는 스토어는 **탭 전역**이라 여기서 고르면 `/live` 까지 움직인다.
    // 복기가 그 값을 무시하는 이상 라디오는 아무 일도 안 하는 컨트롤이 된다.
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="study" />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByTestId('study-venue-fixed-note')).toBeInTheDocument();
    for (const v of ['KRX', 'NXT', 'UN']) {
      expect(screen.queryByTestId(`live-venue-${v}`)).toBeNull();
    }
    // 안내문은 hogaplay 가 KRX 전용이라는 **이유**까지 말해야 한다 — 이유가 없으면
    // 고정이 임의 제약으로 읽힌다.
    expect(screen.getByText(/hogaplay는 KRX 전용/)).toBeInTheDocument();
  });

  it('study variant에서는 hogaplay 우선이 "적용 안 됨" 안내를 띄우지 않는다', async () => {
    // 스토어는 `/live` 선택(NXT)을 들고 있지만 복기는 KRX 고정이라 이 토글이
    // **항상** 적용된다. 게이트가 없으면 사실과 반대되는 안내가 뜬다.
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });
    useLiveVenueStore.setState({ venue: 'NXT' });

    render(<DataSourceDetail variant="study" />, { wrapper: wrap(freshQc()) });

    await screen.findByRole('switch', { name: 'KRX에서 hogaplay 우선' });
    expect(screen.queryByTestId('krx-prefer-hogaplay-inactive')).toBeNull();
  });

  it('REST 우회 토글을 backend settings로 저장한다', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, rest_bypass_enabled: true });
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    const toggle = await screen.findByRole('switch', { name: 'REST 우회' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rest_bypass_enabled: true }),
    }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'REST 우회' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('KRX hogaplay 우선 토글을 backend settings로 저장한다', async () => {
    const apiCall = vi
      .spyOn(apiClient, 'apiCall')
      .mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    const toggle = await screen.findByRole('switch', { name: 'KRX에서 hogaplay 우선' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ krx_prefer_hogaplay: true }),
    }));
  });

  it('토글이 켜져 있어도 KRX가 아니면 적용 안 됨을 알린다 (비활성화하지 않는다)', async () => {
    // 회색 처리하지 않는 이유: 설정은 지속되는 값이고 거래소는 자주 바뀌므로,
    // NXT 를 볼 때마다 disabled 면 고장으로 읽힌다. 사실만 알린다.
    // getLiveSettings spy 는 안 먹는다 — useLiveSettings 의 queryFn 이 같은 모듈의
    // 함수를 내부 참조로 잡는다. apiCall 은 import 경계를 넘으므로 교체가 먹는다.
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });
    useLiveVenueStore.setState({ venue: 'NXT' });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    const hint = await screen.findByTestId('krx-prefer-hogaplay-inactive');
    expect(hint).toBeInTheDocument();
    // 토글 자체는 살아 있다 — 끌 수 있어야 한다.
    expect(screen.getByRole('switch', { name: 'KRX에서 hogaplay 우선' })).not.toBeDisabled();
  });

  it('KRX에서는 적용 안 됨 안내가 뜨지 않는다', async () => {
    // getLiveSettings spy 는 안 먹는다 — useLiveSettings 의 queryFn 이 같은 모듈의
    // 함수를 내부 참조로 잡는다. apiCall 은 import 경계를 넘으므로 교체가 먹는다.
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });
    useLiveVenueStore.setState({ venue: 'KRX' });

    render(<DataSourceDetail variant="live" />, { wrapper: wrap(freshQc()) });

    await screen.findByRole('switch', { name: 'KRX에서 hogaplay 우선' });
    expect(screen.queryByTestId('krx-prefer-hogaplay-inactive')).toBeNull();
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

    expect(await screen.findByText('항시 저장 중입니다')).toBeInTheDocument();
    // 키움 0w push 전환으로 수집 비용이 0 — 거래원(0F)처럼 스위치 자체가 없다.
    expect(screen.queryByRole('switch', { name: '프로그램 순매수 저장' })).toBeNull();
  });

  it('키움 상태줄에 연결 계정·수집 종목 수를 보인다 (활성화 스위치 폐지, ADR-0118)', async () => {
    const qc = freshQc();
    // 활성화 토글은 없다 — 상태줄은 status.kiwoom 관측에서 항상 조립된다.
    vi.spyOn(apiClient, 'apiCall').mockImplementation((url: string) => {
      if (url.includes('/status')) {
        return Promise.resolve({
          running: true, live_set: [], capture_reason: 'healthy',
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

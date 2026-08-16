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

describe('DataSourceDetail (앱 전역 단일 표면)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('KIS 캔들 venue 옵션을 렌더하고 저장한다', () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);
    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    // 라벨 문구가 아니라 **data-testid 의 원값**으로 잡는다 — 문구는 바뀌지만
    // 저장 키('KRX'/'NXT'/'UN')는 계약이다(#1083 규율).
    expect(screen.getByTestId('live-venue-KRX')).toBeChecked();
    expect(screen.getByTestId('live-venue-NXT')).toBeInTheDocument();  // NXT 부활(ADR-0140 §5)
    expect(screen.getByTestId('live-venue-UN')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('live-venue-NXT'));
    expect(useLiveVenueStore.getState().venue).toBe('NXT');
    expect(localStorage.getItem('live.venue.v1')).toContain('NXT');
  });

  it('상세를 캔들/호가체결/스크리너 일봉 + 표시/캡처 매크로 그룹으로 구조화한다', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

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

  it('복기뷰 캔들 안내는 REST 우회 토글을 숨기지 않고 동반 문구로 붙는다', async () => {
    // 옛 `variant === 'study'` 분기는 이 토글을 통째로 안내문으로 **치환**했다. 값이
    // 전역인데 화면마다 숨기면 같은 탭에서도 문(TopNav ⚙ / 툴바 ⚙)에 따라 다른
    // 이야기가 나온다 — 그게 이 통합의 발단이었다.
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByRole('switch', { name: 'REST 우회' })).toBeInTheDocument();
    expect(screen.getByTestId('study-candle-source-note')).toHaveTextContent(/항상 저장 데이터/);
  });

  it('거래소 라디오는 상시 표시되고 복기뷰 고정은 동반 문구로 알린다 (ADR-0144는 유효)', async () => {
    // ADR-0144 의 격리는 이 화면이 아니라 `studyVenuePolicy` 의 `STUDY_VENUE` 상수와
    // 그 테스트가 건다 — 여기서 골라도 복기뷰는 KRX 그대로다. 숨길 근거였던 "아무 일도
    // 안 하는 컨트롤" 은 앱 전역 설정에서 성립하지 않는다: 이 라디오는 `/live` 말고도
    // `/heatmap`·`/screener`·관심종목에 실제로 작동한다.
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    for (const v of ['KRX', 'NXT', 'UN']) {
      expect(screen.getByTestId(`live-venue-${v}`)).toBeInTheDocument();
    }
    // 동반 문구는 **이유**를 댄다 — 「복기뷰는 예외로 항상 KRX」라는 사실 자체는
    // 그룹 설명(`LIVE_VENUE_HELP`)이 이미 말하므로 여기서 반복하지 않는다. 이유가
    // 없으면 고정이 임의 제약으로 읽힌다.
    const note = await screen.findByTestId('study-venue-fixed-note');
    expect(note).toHaveTextContent(/복기뷰가 KRX 고정인 이유/);
    expect(note).toHaveTextContent(/hogaplay 캡처가 KRX 전용/);
  });

  it('REST 우회 토글을 backend settings로 저장한다', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, rest_bypass_enabled: true });
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue(SETTINGS);

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

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

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

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
    //
    // ⚠ 옛 `variant === 'live'` 게이트가 사라진 자리다. 게이트의 근거는 "복기뷰는 항상
    // KRX 라 이 안내가 거짓이 된다" 였으므로, 게이트 대신 **문장이 두 화면을 모두
    // 말하는지**를 검사한다 — 그래야 어느 라우트에서 열어도 참이다.
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });
    useLiveVenueStore.setState({ venue: 'NXT' });

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    const hint = await screen.findByTestId('krx-prefer-hogaplay-inactive');
    expect(hint).toHaveTextContent(/실시간 화면의 현재 거래소/);
    expect(hint).toHaveTextContent(/복기뷰는 KRX 고정이라 항상 적용됩니다/);
    // 토글 자체는 살아 있다 — 끌 수 있어야 한다.
    expect(screen.getByRole('switch', { name: 'KRX에서 hogaplay 우선' })).not.toBeDisabled();
  });

  it('KRX에서는 적용 안 됨 안내가 뜨지 않는다', async () => {
    // getLiveSettings spy 는 안 먹는다 — useLiveSettings 의 queryFn 이 같은 모듈의
    // 함수를 내부 참조로 잡는다. apiCall 은 import 경계를 넘으므로 교체가 먹는다.
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, krx_prefer_hogaplay: true });
    useLiveVenueStore.setState({ venue: 'KRX' });

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

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

    render(<DataSourceDetail />, { wrapper: wrap(qc) });

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

    render(<DataSourceDetail />, { wrapper: wrap(qc) });

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

    render(<DataSourceDetail />, { wrapper: wrap(qc) });

    await waitFor(() =>
      expect(screen.getByTestId('kiwoom-status-line')).toHaveTextContent('키움 앱키 미설정'),
    );
    expect(screen.getByTestId('kiwoom-status-line')).toHaveTextContent('KIWOOM_APP_KEY');
  });
});

/** 옛 「데이터 수집」 nav(토글 1개짜리 섹션)에서 이관된 검사들.
 *  캡처 쓰기 설정이라 「캡처 저장」 매크로 그룹이 제자리다. */
describe('DataSourceDetail — 스크리너 총잔량 결측 자동 수집', () => {
  const TOGGLE = '스크리너 총잔량 결측 자동 수집';

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('기본은 꺼짐 — 스캔은 반복 실행이라 묵시적 큐 증가를 막는다', async () => {
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS });

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByRole('switch', { name: TOGGLE })).toHaveAttribute('aria-checked', 'false');
  });

  it('wire 값이 켜져 있으면 반영한다', async () => {
    vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS, screener_depth_autocollect: true });

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: TOGGLE })).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('클릭하면 반전된 값을 PATCH 한다', async () => {
    const apiCall = vi.spyOn(apiClient, 'apiCall').mockResolvedValue({ ...SETTINGS });

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    // ⚠ 이 패널에서 **로딩 중 잠기는 토글은 이것 하나**다(옛 「데이터 수집」 동작을
    // 그대로 옮겼다 — REST 우회·hogaplay 는 잠기지 않는다). 해소를 기다리지 않으면
    // disabled 버튼이 클릭을 삼켜 PATCH 가 아예 일어나지 않는다.
    const toggle = await screen.findByRole('switch', { name: TOGGLE });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);

    await waitFor(() => expect(apiCall).toHaveBeenCalledWith('/api/live/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screener_depth_autocollect: true }),
    }));
  });

  it('설정 로딩 중에는 토글을 잠근다', () => {
    // 영원히 pending — isLoading 상태를 고정한다.
    vi.spyOn(apiClient, 'apiCall').mockImplementation(() => new Promise(() => {}));

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    expect(screen.getByRole('switch', { name: TOGGLE })).toBeDisabled();
  });

  it('GET 실패는 패널 상단에 한 번 알리고 토글은 살려 둔다', async () => {
    // PATCH 는 partial 이라 현재값을 몰라도 조작이 안전하다 — 복구 조작을 열어둔다.
    vi.spyOn(apiClient, 'apiCall').mockRejectedValue(new Error('backend down'));

    render(<DataSourceDetail />, { wrapper: wrap(freshQc()) });

    expect(await screen.findByText(/라이브 설정을 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: TOGGLE })).toBeEnabled();
  });
});

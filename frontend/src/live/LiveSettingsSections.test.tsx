import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveSettingsSections from './LiveSettingsSections';
import { useLiveVenueStore } from '../state/liveVenue';
import { useStudyViewOpenPrefsStore } from '../state/studyViewOpenPrefs';
import * as liveSettingsApi from '../api/liveSettings';
import * as signalAlertsApi from '../api/signalAlerts';
import * as apiClient from '../api/client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('LiveSettingsSections (2단 nav+detail)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    useLiveVenueStore.setState({ venue: 'KRX' });
    useStudyViewOpenPrefsStore.setState({ defaultTimeframe: '3m' });
  });

  it('카테고리 nav를 렌더 (차트·데이터소스·저장뷰·알림 — 보조지표·총잔량 급증은 지표 모달로 이동)', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-nav-chart')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-study-views')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-alerts')).toBeTruthy();
    expect(screen.queryByTestId('settings-nav-indicators')).toBeNull();
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
  });

  it('기본 선택은 차트 — 동시호가 마스킹 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });

  it('uses a flat section surface for the detail pane', () => {
    render(<LiveSettingsSections />);

    expect(screen.getByRole('navigation', { name: '설정 카테고리' })).toHaveClass('border-r');
    expect(screen.getByRole('region', { name: '차트' })).not.toHaveClass('bg-bg-card');
  });

  it('차트 설정에 날짜 구분선 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-dayBoundaryEnabled')).toBeTruthy();
  });

  it('차트 설정에 캔들 기준 Y축 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-candlePaneCandleOnlyScale')).toBeTruthy();
  });

  it('차트 설정에 캔들이 항상 위 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-candleAlwaysOnTop')).toBeTruthy();
  });

  it('차트 설정에 날짜 구분선 스타일 선택 버튼이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByRole('button', { name: '날짜 구분선 스타일 선택' })).toBeTruthy();
  });

  it('날짜 구분선 스타일 팔레트에서 기본 색상을 다시 선택할 수 있다', () => {
    render(<LiveSettingsSections />);
    fireEvent.click(screen.getByRole('button', { name: '날짜 구분선 스타일 선택' }));

    expect(screen.getByRole('button', { name: '날짜 구분선 색상 #64748B' })).toBeTruthy();
  });

  it('날짜 구분선 스타일 선택 버튼은 날짜 구분선 토글 다음, 캔들 툴팁 토글 전에 보인다', () => {
    render(<LiveSettingsSections />);

    const dayBoundaryToggle = screen.getByTestId('settings-toggle-dayBoundaryEnabled');
    const styleButton = screen.getByRole('button', { name: '날짜 구분선 스타일 선택' });
    const candleTooltipToggle = screen.getByTestId('settings-toggle-candleTooltipEnabled');

    expect(
      dayBoundaryToggle.compareDocumentPosition(styleButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      styleButton.compareDocumentPosition(candleTooltipToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('이동된 토글은 설정 모달에 없다 (급증·누적·극단값필터)', () => {
    render(<LiveSettingsSections />);
    expect(screen.queryByTestId('settings-toggle-surgeMarkerEnabled')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-fillStrengthCumulative')).toBeNull();
    expect(screen.queryByTestId('settings-toggle-ratioOutlierFilterEnabled')).toBeNull();
  });

  it('데이터소스 상세에서 KIS 캔들 venue 옵션을 렌더하고 저장한다', () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
    });
    render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));

    expect(screen.getByLabelText('KRX')).toBeChecked();
    expect(screen.getByLabelText('NXT')).toBeInTheDocument();
    expect(screen.getByLabelText('통합')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('통합'));
    expect(useLiveVenueStore.getState().venue).toBe('UN');
    expect(localStorage.getItem('live.venue.v1')).toContain('UN');
  });

  it('데이터소스 상세를 캔들/호가체결/스크리너 일봉으로 구조화한다', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
    });
    vi.spyOn(liveSettingsApi, 'patchLiveSettings').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'rest_only',
      program_trade_storage_enabled: false,
    });

    render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));

    expect(await screen.findByText('데이터 저장 방식')).toBeInTheDocument();
    expect(screen.getByText('캔들 데이터 기준')).toBeInTheDocument();
    expect(screen.getByText('호가·체결 데이터 기준')).toBeInTheDocument();
    expect(screen.getByText('스크리너 일봉 데이터')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'WS만 저장' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'WS 우선 + 나머지 REST 저장' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'REST만 저장' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '자동' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio', { name: 'hogaplay 우선' })).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'KIS WS 우선' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio', { name: 'KIS API 우선' })).toHaveLength(2);
  });

  it('데이터소스 상세에서 프로그램 순매수 저장 토글을 REST 허용 정책에서만 켠다', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(liveSettingsApi.LIVE_SETTINGS_KEY, {
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
    });
    const apiCall = vi.spyOn(apiClient, 'apiCall')
      .mockResolvedValueOnce({
        schema_version: 1,
        storage_policy: 'ws_plus_rest',
        program_trade_storage_enabled: false,
      })
      .mockResolvedValueOnce({
        schema_version: 1,
        storage_policy: 'ws_plus_rest',
        program_trade_storage_enabled: true,
      });

    render(<LiveSettingsSections />, { wrapper: wrap(qc) });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(liveSettingsApi.LIVE_SETTINGS_KEY, {
      schema_version: 1,
      storage_policy: 'ws_only',
      program_trade_storage_enabled: false,
    });

    render(<LiveSettingsSections />, { wrapper: wrap(qc) });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));

    expect(await screen.findByRole('switch', { name: '프로그램 순매수 저장' })).toBeDisabled();
  });

  it('저장뷰 상세에서 사이드 메뉴 기본 분봉을 선택한다', () => {
    render(<LiveSettingsSections />);
    fireEvent.click(screen.getByTestId('settings-nav-study-views'));

    expect(screen.getByRole('radio', { name: '저장된 분봉' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '3분' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '5분' }));

    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('5m');
    expect(localStorage.getItem('studyView.openPrefs.v1')).toContain('5m');

    fireEvent.click(screen.getByRole('radio', { name: '저장된 분봉' }));
    expect(useStudyViewOpenPrefsStore.getState().defaultTimeframe).toBe('saved');
  });

  it('알림 상세에서 시그널 알림 설정을 수정한다', async () => {
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
    const mutate = vi.fn();
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    fireEvent.click(screen.getByTestId('settings-nav-alerts'));

    expect(await screen.findByRole('switch', { name: '알림 사용' })).toHaveAttribute('aria-checked', 'true');
    const startTime = screen.getByLabelText('기준 시각');
    const threshold = screen.getByLabelText('기준 최대값 대비 문턱 (%)');

    fireEvent.change(startTime, { target: { value: '11:15' } });
    fireEvent.blur(startTime);
    fireEvent.change(threshold, { target: { value: '95' } });
    fireEvent.blur(threshold);
    fireEvent.click(screen.getByRole('switch', { name: '분봉 내 최대 매도 총잔량으로 판정' }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        sell_total_renewal: {
          enabled: true,
          start_hhmm: 1115,
          threshold_pct: 95,
          use_intra_minute_max: false,
        },
      });
    });
  });

  it('알림 기준 시각은 네 자리 HHMM 입력을 HH:MM으로 해석해 저장한다', async () => {
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
    const mutate = vi.fn();
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    fireEvent.click(screen.getByTestId('settings-nav-alerts'));
    const startTime = await screen.findByLabelText('기준 시각') as HTMLInputElement;

    fireEvent.change(startTime, { target: { value: '1000' } });
    fireEvent.blur(startTime);
    expect(startTime.value).toBe('10:00');
    expect(mutate).toHaveBeenLastCalledWith({
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1000,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });

    fireEvent.change(startTime, { target: { value: '1500' } });
    fireEvent.blur(startTime);
    expect(startTime.value).toBe('15:00');
    expect(mutate).toHaveBeenLastCalledWith({
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1500,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
  });
});

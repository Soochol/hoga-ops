import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveSettingsSections from './LiveSettingsSections';
import { useLiveVenueStore } from '../state/liveVenue';
import { useStudyViewOpenPrefsStore } from '../state/studyViewOpenPrefs';
import * as signalAlertsApi from '../api/signalAlerts';

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

  it('라이브 카테고리 nav를 렌더 — 데이터소스는 메인 Settings로 이동해 제외', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-nav-chart')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-study-views')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-alerts')).toBeTruthy();
    // 데이터소스는 라이브 모달에선 제거되고 메인 Settings의 「데이터 소스」로 이동.
    expect(screen.queryByTestId('settings-nav-data-source')).toBeNull();
    expect(screen.queryByTestId('settings-nav-indicators')).toBeNull();
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
  });

  it('복기뷰(study) 모달은 데이터소스 nav를 유지한다', () => {
    render(<LiveSettingsSections variant="study" />);
    expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
  });

  it('기본 선택은 차트 — 동시호가 마스킹 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });

  it('uses a flat section surface for the detail pane', () => {
    render(<LiveSettingsSections />);

    // nav는 border-r 대신 bg-subtle 톤 스텝으로 분리(2026-07-15 borderless 통일).
    expect(screen.getByRole('navigation', { name: '설정 카테고리' })).toHaveClass('bg-bg-subtle');
    expect(screen.getByRole('navigation', { name: '설정 카테고리' })).not.toHaveClass('border-r');
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

  // 데이터소스 상세 콘텐츠 테스트는 DataSourceDetail.test.tsx로 이관(추출·재사용).
  // 라이브 모달에선 데이터소스가 메인 Settings로 이동했고, 복기뷰(study) 모달의
  // nav 유지만 위에서 검증한다.

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

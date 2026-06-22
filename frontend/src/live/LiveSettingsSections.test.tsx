import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveSettingsSections from './LiveSettingsSections';
import { useLiveVenueStore } from '../state/liveVenue';
import * as liveSettingsApi from '../api/liveSettings';

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
  });

  it('카테고리 nav를 렌더 (차트·데이터소스만 — 보조지표·총잔량 급증은 지표 모달로 이동)', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-nav-chart')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
    expect(screen.queryByTestId('settings-nav-indicators')).toBeNull();
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
  });

  it('기본 선택은 차트 — 동시호가 마스킹 토글이 상세에 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });

  it('차트 설정에 날짜 구분선 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-dayBoundaryEnabled')).toBeTruthy();
  });

  it('차트 설정에 캔들 기준 Y축 토글이 보인다', () => {
    render(<LiveSettingsSections />);
    expect(screen.getByTestId('settings-toggle-candlePaneCandleOnlyScale')).toBeTruthy();
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
    });
    render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));

    expect(screen.getByLabelText('KRX')).toBeChecked();
    expect(screen.getByLabelText('NXT')).toBeInTheDocument();
    expect(screen.getByLabelText('통합')).toBeInTheDocument();
    expect(screen.getByLabelText('자동')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('자동'));
    expect(useLiveVenueStore.getState().venue).toBe('AUTO');
    expect(localStorage.getItem('live.venue.v1')).toContain('AUTO');
  });

  it('renders storage policy and display priority separately', async () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
    });
    vi.spyOn(liveSettingsApi, 'patchLiveSettings').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'rest_only',
    });

    render(<LiveSettingsSections />, { wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })) });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));

    expect(await screen.findByText('데이터 저장 방식')).toBeInTheDocument();
    expect(screen.getByText('데이터 표현 기준')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'WS만 저장' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'WS 우선 + 나머지 REST 저장' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'REST만 저장' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'hogaplay 우선' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'KIS WS 우선' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'KIS API 우선' })).toBeInTheDocument();
  });
});

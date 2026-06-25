import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LiveSettingsModal from './LiveSettingsModal';
import { useChartPrefsStore } from '../state/chartPrefs';
import * as liveSettingsApi from '../api/liveSettings';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('LiveSettingsModal (2단)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('차트 카테고리 nav 클릭 후 차트 토글이 보인다', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });

  it('toggle click mutates chartPrefs store', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
    // ToggleRow puts data-testid on the outer wrapper div; the onClick handler
    // lives on the inner role="switch" button — drill in to fire it.
    const row = screen.getByTestId('settings-toggle-auctionWindowMask');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('캔들 기준 Y축 토글 클릭 시 chartPrefs store에 반영된다', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(useChartPrefsStore.getState().candlePaneCandleOnlyScale).toBe(false);
    const row = screen.getByTestId('settings-toggle-candlePaneCandleOnlyScale');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().candlePaneCandleOnlyScale).toBe(true);
  });

  it('차트 설정에 VI/상하한가 선 스타일 선택이 보인다', () => {
    render(<LiveSettingsModal onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.getByText('VI/상하한가 선 스타일')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'VI/상하한가 선 스타일 선택' })).toBeTruthy();
  });

  it('이동된 급증·극단값 prefs는 설정 모달에 없다 (지표 모달로 이동)', () => {
    // surgeMarkerEnabled·ratioOutlierFilterEnabled가 'indicator-modal'로
    // 재분류돼 surge nav와 그 gated numerics는 ⚙️ 설정에서 사라졌다.
    // commit-on-Enter 동작은 IndicatorPrefRows.test.tsx가 커버한다.
    render(<LiveSettingsModal onClose={() => {}} />);
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.queryByTestId('settings-numeric-ratioOutlierThreshold')).toBeNull();
    expect(screen.queryByTestId('settings-numeric-surgeApproachPct')).toBeNull();
  });

  it('데이터소스 nav 클릭 후 source radio 두 옵션이 보인다', () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
      schema_version: 1,
      storage_policy: 'ws_plus_rest',
      program_trade_storage_enabled: false,
    });
    render(<LiveSettingsModal onClose={() => {}} />, {
      wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));
    expect(screen.getByLabelText(/hogaplay 우선/)).toBeTruthy();
    expect(screen.getByLabelText(/KIS API 우선/)).toBeTruthy();
  });

  it('Escape calls onClose', () => {
    let closed = false;
    render(<LiveSettingsModal onClose={() => { closed = true; }} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  it('backdrop click calls onClose', () => {
    let closed = false;
    render(<LiveSettingsModal onClose={() => { closed = true; }} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(closed).toBe(true);
  });
});

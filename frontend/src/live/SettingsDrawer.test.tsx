import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsDrawer from './SettingsDrawer';
import { useChartPrefsStore } from '../state/chartPrefs';
import * as liveSettingsApi from '../api/liveSettings';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('SettingsDrawer (2단)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('차트 카테고리 nav 클릭 후 차트 토글이 보인다', () => {
    render(<SettingsDrawer onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.getByTestId('settings-toggle-auctionWindowMask')).toBeTruthy();
  });

  it('uses the quiet terminal modal surface', () => {
    render(<SettingsDrawer onClose={() => {}} />);

    expect(screen.getByRole('dialog')).not.toHaveClass('bg-bg-card');
    expect(screen.getByRole('dialog')).toHaveClass('z-[60]');
    expect(screen.getByTestId('settings-shell')).toHaveClass('bg-bg-card');
    // 높이는 ModalShell 다이얼로그가 강제하고(2026-07-15 크롬 통일), 패널은 h-full로 채운다.
    expect(screen.getByTestId('settings-shell')).toHaveClass('h-full');
    // nav는 border-r 대신 bg-subtle 톤 스텝으로 분리(2026-07-15 borderless 통일).
    expect(screen.getByRole('navigation', { name: '설정 카테고리' })).toHaveClass('bg-bg-subtle');
    expect(screen.getByRole('navigation', { name: '설정 카테고리' })).not.toHaveClass('border-r');
  });

  it('지표 드로어와 통일된 우측 드로어로 렌더된다(ADR-0116)', () => {
    render(<SettingsDrawer onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    // 우측 정렬 + 가벼운 딤(왼쪽 차트가 뒤로 보이도록).
    expect(dialog).toHaveClass('justify-end');
    expect(dialog).toHaveClass('bg-black/30');
    // ModalShell 카드는 좌측 보더의 전체 높이 드로어(패널의 부모).
    const card = screen.getByTestId('settings-shell').parentElement!;
    expect(card).toHaveClass('border-l');
    expect(card).toHaveClass('h-full');
  });

  it('toggle click mutates chartPrefs store', () => {
    render(<SettingsDrawer onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
    // ToggleRow puts data-testid on the outer wrapper div; the onClick handler
    // lives on the inner role="switch" button — drill in to fire it.
    const row = screen.getByTestId('settings-toggle-auctionWindowMask');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('캔들 기준 Y축 토글 클릭 시 chartPrefs store에 반영된다', () => {
    render(<SettingsDrawer onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(useChartPrefsStore.getState().candlePaneCandleOnlyScale).toBe(false);
    const row = screen.getByTestId('settings-toggle-candlePaneCandleOnlyScale');
    fireEvent.click(row.querySelector('[role="switch"]') as HTMLElement);
    expect(useChartPrefsStore.getState().candlePaneCandleOnlyScale).toBe(true);
  });

  it('차트 설정에 VI/상하한가 선 스타일 선택이 보인다', () => {
    render(<SettingsDrawer onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.getByText('VI/상하한가 선 스타일')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'VI/상하한가 선 스타일 선택' })).toBeTruthy();
  });

  it('이동된 급증·극단값 prefs는 설정 모달에 없다 (지표 모달로 이동)', () => {
    // surgeMarkerEnabled·ratioOutlierFilterEnabled가 'indicator-modal'로
    // 재분류돼 surge nav와 그 gated numerics는 ⚙️ 설정에서 사라졌다.
    // commit-on-Enter 동작은 IndicatorPrefRows.test.tsx가 커버한다.
    render(<SettingsDrawer onClose={() => {}} />);
    expect(screen.queryByTestId('settings-nav-surge')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-chart'));
    expect(screen.queryByTestId('settings-numeric-ratioOutlierThreshold')).toBeNull();
    expect(screen.queryByTestId('settings-numeric-surgeApproachPct')).toBeNull();
  });

  it('데이터소스 nav 는 라이브에서도 보인다 (설정 표면 통합)', () => {
    // 한때 `/live` 에서만 빼고 메인 Settings 로 보냈다. 그 분리가 `/study` 에서
    // TopNav ⚙ 와 툴바 ⚙ 가 **같은 값에 대해 다른 화면**을 보여주는 사고를 만들었고
    // (`pages/Settings` 가 `variant="live"` 하드코딩), 표면이 하나로 합쳐지면서
    // 되돌아왔다. ADR-0144(복기뷰 KRX 고정)와는 무관하다 — 그 격리는 설정 화면이
    // 아니라 `studyVenuePolicy` 의 `STUDY_VENUE` 가 건다.
    render(<SettingsDrawer onClose={() => {}} />);
    expect(screen.getByTestId('settings-nav-data-source')).toBeTruthy();
  });

  it('복기뷰(study)도 같은 데이터소스 상세를 연다 — 복기 안내는 동반 문구로 남는다', () => {
    vi.spyOn(liveSettingsApi, 'getLiveSettings').mockResolvedValue({
      schema_version: 1,
      rest_bypass_enabled: false,
      screener_depth_autocollect: false,
      krx_prefer_hogaplay: false,
    });
    render(<SettingsDrawer variant="study" onClose={() => {}} />, {
      wrapper: wrap(new QueryClient({ defaultOptions: { queries: { retry: false } } })),
    });
    fireEvent.click(screen.getByTestId('settings-nav-data-source'));
    // study는 캔들 라디오 대신 디스크 온리 안내문, 표시/캡처 매크로 그룹은 유지.
    expect(screen.getByTestId('study-candle-source-note')).toBeTruthy();
    // 「호가·체결 데이터 기준」 은 라디오 3종이 폐지된 뒤 옵트인 토글로 돌아왔다.
    expect(screen.getByText('호가·체결 데이터 기준')).toBeTruthy();
    expect(screen.getByText('표시 소스')).toBeTruthy();
    expect(screen.getByText('캡처 저장')).toBeTruthy();
  });

  it('Escape calls onClose', () => {
    let closed = false;
    render(<SettingsDrawer onClose={() => { closed = true; }} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  it('backdrop press calls onClose', () => {
    // ModalShell 백드롭 닫힘은 mousedown 기준(드래그 오작동 방지 계약).
    let closed = false;
    render(<SettingsDrawer onClose={() => { closed = true; }} />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(closed).toBe(true);
  });
});

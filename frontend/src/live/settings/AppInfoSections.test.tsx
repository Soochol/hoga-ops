import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GeneralSection, ThemeSection } from './AppInfoSections';
import { useThemePrefsStore } from '../../state/themePrefs';

// 이 파일은 `pages/Settings.test.tsx` 에서 이관됐다. 그 페이지(`/settings` 라우트)는
// 설정이 앱 전역 드로어 하나로 합쳐지면서 삭제됐고, 여기 섹션들의 **유일한** 커버리지가
// 거기 있었다. 이제 셸을 거치지 않고 섹션을 직접 렌더한다.
vi.mock('../../config', () => ({
  loadConfig: () => Promise.resolve({ api_url: 'http://test' }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('AppInfoSections — 앱 정보', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('설정에서 읽은 API URL 을 보인다', async () => {
    renderWithQuery(<GeneralSection />);
    await waitFor(() => expect(screen.getByText('http://test')).toBeInTheDocument());
  });
});

describe('AppInfoSections — 테마', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useThemePrefsStore.setState({ themePreference: 'toss-dark' });
  });

  it('renders all theme options in one compact selector', () => {
    renderWithQuery(<ThemeSection />);
    expect(screen.getByRole('combobox', { name: '테마 선택' })).toHaveValue('toss-dark');
    expect(screen.getByRole('option', { name: 'Obsidian' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ledger' })).toBeInTheDocument();
    // `auto`(라벨 '자동')는 2026-08-30 에 제거됐다 — 되살아나면 여기서 빨개진다.
    expect(screen.queryByRole('option', { name: '자동' })).toBeNull();
  });

  it('selecting Ledger updates the store and selected value', async () => {
    renderWithQuery(<ThemeSection />);
    const ledger = screen.getByRole('combobox', { name: '테마 선택' });
    fireEvent.change(ledger, { target: { value: 'ledger' } });
    await waitFor(() => {
      expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
    });
    expect(ledger).toHaveValue('ledger');
  });

  it.each([
    ['Obsidian Pro', 'obsidian-pro', '흑연색 배경과 앰버 강조색 · 장중 모니터링'],
    ['Ledger Studio', 'ledger-studio', '아이보리 배경과 포레스트 그린 · 장후 복기와 리서치'],
    ['Trading Desk', 'trading-desk', '올리브 블랙과 라임 강조색 · 트레이딩 데스크'],
  ] as const)('selects %s and persists its preference', (label, theme, hint) => {
    renderWithQuery(<ThemeSection />);
    const option = screen.getByRole('combobox', { name: '테마 선택' });
    expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    fireEvent.change(option, { target: { value: theme } });
    expect(option).toHaveValue(theme);
    expect((screen.getByRole('option', { name: 'Toss Dark' }) as HTMLOptionElement).selected).toBe(false);
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(useThemePrefsStore.getState().themePreference).toBe(theme);
    expect(JSON.parse(localStorage.getItem('ui.themePreference.v1')!)).toEqual({ themePreference: theme });
  });
});

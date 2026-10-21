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

  it('renders the theme options with the current one pressed', () => {
    renderWithQuery(<ThemeSection />);
    expect(screen.getByRole('button', { name: 'Toss Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Obsidian' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Ledger' })).toHaveAttribute('aria-pressed', 'false');
    // `auto`(라벨 '자동')는 2026-08-30 에 제거됐다 — 되살아나면 여기서 빨개진다.
    expect(screen.queryByRole('button', { name: '자동' })).toBeNull();
  });

  it('clicking Ledger updates the store and aria-pressed', async () => {
    renderWithQuery(<ThemeSection />);
    const ledger = screen.getByRole('button', { name: 'Ledger' });
    fireEvent.click(ledger);
    await waitFor(() => {
      expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
    });
    expect(ledger).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([
    ['Obsidian Pro', 'obsidian-pro', '흑연색 배경과 앰버 강조색 · 장중 모니터링'],
    ['Ledger Studio', 'ledger-studio', '아이보리 배경과 포레스트 그린 · 장후 복기와 리서치'],
    ['Trading Desk', 'trading-desk', '올리브 블랙과 라임 강조색 · 트레이딩 데스크'],
  ] as const)('selects %s and persists its preference', (label, theme, hint) => {
    renderWithQuery(<ThemeSection />);
    const option = screen.getByRole('button', { name: label });
    fireEvent.click(option);
    expect(option).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Toss Dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(useThemePrefsStore.getState().themePreference).toBe(theme);
    expect(JSON.parse(localStorage.getItem('ui.themePreference.v1')!)).toEqual({ themePreference: theme });
  });
});

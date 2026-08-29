import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GeneralSection, SymbolMasterSection, ThemeSection } from './AppInfoSections';
import * as symbolsApi from '../../api/symbols';
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

describe('AppInfoSections — Symbol Master', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders unavailable state with hint', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'unavailable',
      reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<SymbolMasterSection />);

    expect(await screen.findByText('0')).toBeInTheDocument(); // count
    expect(screen.getByText(/아직 다운로드되지 않았습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders fresh state', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: Date.now() - 3600_000, // 1 hour ago
      status: 'fresh',
      reason: null,
    });

    renderWithQuery(<SymbolMasterSection />);

    await waitFor(() => {
      expect(screen.getByText('6,012')).toBeInTheDocument();
    });
    expect(screen.getByText('fresh')).toBeInTheDocument();
  });

  it('clicking Update Now calls refreshSymbols and invalidates', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
    const refreshSpy = vi
      .spyOn(symbolsApi, 'refreshSymbols')
      .mockResolvedValue({ symbols: [], status: 'fresh', fetched_at_ms: Date.now(), reason: null });

    renderWithQuery(<SymbolMasterSection />);
    // 마운트와 함께 symbols 쿼리가 시작된다 — 해소되어 버튼이 열릴 때까지 기다린 뒤
    // 누른다(disabled 버튼은 클릭을 조용히 삼킨다).
    const btn = await screen.findByRole('button', { name: /Update Now/i });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledOnce();
    });
  });

  it('renders loading state (Update in flight): button label still shows Update Now (local updating drives label change)', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'loading',
      reason: null,
    });

    renderWithQuery(<SymbolMasterSection />);

    await waitFor(() => {
      expect(screen.getByText('loading')).toBeInTheDocument();
    });
    // Wire status='loading' does NOT auto-disable the button — local updating state does.
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders stale state: cache preserved, reason hint visible, button still actionable', async () => {
    const TWO_HOURS_AGO = Date.now() - 2 * 60 * 60 * 1000;
    // master_fetch_failed is the only fetch-failure reason the symbols backend
    // actually emits on this surface — an impossible mock would leave the
    // reachable hint copy untested.
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: TWO_HOURS_AGO,
      status: 'stale',
      reason: 'master_fetch_failed',
    });

    renderWithQuery(<SymbolMasterSection />);

    await waitFor(() => {
      expect(screen.getByText('6,012')).toBeInTheDocument();
    });
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText(/KIS 종목 마스터.*다운로드에 실패/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('does not render force retry capture defaults', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<SymbolMasterSection />);

    expect(await screen.findByText('0')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-force-retry-default')).toBeNull();
    expect(screen.queryByText(/force/i)).toBeNull();
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
});

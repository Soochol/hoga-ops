import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import * as symbolsApi from '../api/symbols';
import { useThemePrefsStore } from '../state/themePrefs';

vi.mock('../config', () => ({
  loadConfig: () => Promise.resolve({ api_url: 'http://test' }),
}));

// The 데이터 수집 section reads/writes /api/live/settings via these hooks. Mock the
// module so the toggle is deterministic and no network is touched. `liveSettingsState`
// is mutable so individual tests can flip the wire value; `heatmapMutate` records PATCH.
const { heatmapMutate, liveSettingsState } = vi.hoisted(() => ({
  heatmapMutate: vi.fn(),
  liveSettingsState: {
    data: { heatmap_capture_enabled: true } as { heatmap_capture_enabled: boolean } | undefined,
    isLoading: false,
    isError: false,
  },
}));
vi.mock('../api/liveSettings', () => ({
  useLiveSettings: () => liveSettingsState,
  usePatchLiveSettings: () => ({ mutate: heatmapMutate, isPending: false }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** Master-detail: click a left-nav item to reveal its detail panel.
 *  fireEvent wraps in act() and flushes synchronously so callers can query
 *  the revealed detail immediately. */
function selectSection(id: string) {
  fireEvent.click(screen.getByTestId(`settings-nav-${id}`));
}

describe('Settings — 사이드바 레이아웃', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
  });

  it('renders all section nav items with 앱 정보 selected by default', async () => {
    renderWithQuery(<Settings />);
    for (const id of ['general', 'theme', 'data', 'symbols', 'roadmap']) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('settings-nav-general')).toHaveAttribute('aria-current', 'true');
    // Default detail = 앱 정보 → API URL row visible.
    await waitFor(() => expect(screen.getByText('http://test')).toBeInTheDocument());
  });

  it('uses the feature page shell without repeating the nav page title', () => {
    renderWithQuery(<Settings />);
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.getByTestId('settings-page-primary')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('settings-page-primary')).toHaveClass('border');
  });
});

describe('Settings — Symbol Master section', () => {
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

    renderWithQuery(<Settings />);
    selectSection('symbols');

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

    renderWithQuery(<Settings />);
    selectSection('symbols');

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

    renderWithQuery(<Settings />);
    selectSection('symbols');
    // The section mounts on select, so its symbols query starts here — wait for it
    // to resolve (button enables) before clicking, else the disabled button eats it.
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

    renderWithQuery(<Settings />);
    selectSection('symbols');

    await waitFor(() => {
      expect(screen.getByText('loading')).toBeInTheDocument();
    });
    // Wire status='loading' does NOT auto-disable the button — local updating state does.
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders stale state: cache preserved, reason hint visible, button still actionable', async () => {
    const TWO_HOURS_AGO = Date.now() - 2 * 60 * 60 * 1000;
    // kis_master_fetch_failed is the only fetch-failure reason the symbols
    // backend actually emits on this surface — the previous mock used
    // kis_holiday_fetch_failed, an impossible state here, so the reachable
    // hint copy went untested.
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: TWO_HOURS_AGO,
      status: 'stale',
      reason: 'kis_master_fetch_failed',
    });

    renderWithQuery(<Settings />);
    selectSection('symbols');

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

    renderWithQuery(<Settings />);
    selectSection('symbols');

    expect(await screen.findByText('0')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-force-retry-default')).toBeNull();
    expect(screen.queryByText(/force/i)).toBeNull();
  });

  it('does not render signal alert settings after moving them to the live settings modal', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });

    renderWithQuery(<Settings />);
    selectSection('symbols');

    await waitFor(() => expect(screen.getByText('fresh')).toBeInTheDocument());
    expect(screen.queryByText('시그널 알림')).toBeNull();
    expect(screen.queryByRole('switch', { name: '알림 사용' })).toBeNull();
  });
});

describe('Settings — 데이터 수집 (히트맵 API 수집 토글)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    heatmapMutate.mockReset();
    liveSettingsState.data = { heatmap_capture_enabled: true };
    liveSettingsState.isLoading = false;
    liveSettingsState.isError = false;
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
  });

  it('shows the heatmap capture toggle checked when enabled', () => {
    renderWithQuery(<Settings />);
    selectSection('data');
    const toggle = screen.getByRole('switch', { name: '히트맵 종목 API 수집' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('reflects the disabled wire value', () => {
    liveSettingsState.data = { heatmap_capture_enabled: false };
    renderWithQuery(<Settings />);
    selectSection('data');
    expect(screen.getByRole('switch', { name: '히트맵 종목 API 수집' })).toHaveAttribute('aria-checked', 'false');
  });

  it('clicking the toggle PATCHes the inverted value', () => {
    renderWithQuery(<Settings />);
    selectSection('data');
    fireEvent.click(screen.getByRole('switch', { name: '히트맵 종목 API 수집' }));
    expect(heatmapMutate).toHaveBeenCalledWith({ heatmap_capture_enabled: false });
  });

  it('defaults to enabled and disables the toggle while settings are loading', () => {
    liveSettingsState.data = undefined;
    liveSettingsState.isLoading = true;
    renderWithQuery(<Settings />);
    selectSection('data');
    const toggle = screen.getByRole('switch', { name: '히트맵 종목 API 수집' });
    expect(toggle).toHaveAttribute('aria-checked', 'true'); // optimistic default
    expect(toggle).toBeDisabled();
  });

  it('stays actionable (not disabled) when settings failed to load', () => {
    // PATCH is partial (heatmap field only), so a GET failure must not lock the
    // toggle — the user can still recover by toggling.
    liveSettingsState.data = undefined;
    liveSettingsState.isLoading = false;
    liveSettingsState.isError = true;
    renderWithQuery(<Settings />);
    selectSection('data');
    const toggle = screen.getByRole('switch', { name: '히트맵 종목 API 수집' });
    expect(toggle).toBeEnabled();
    expect(screen.getByText(/라이브 설정을 불러오지 못했습니다/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(heatmapMutate).toHaveBeenCalledWith({ heatmap_capture_enabled: false });
  });
});

describe('Settings — 테마 section', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useThemePrefsStore.setState({ themePreference: 'auto' });
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
  });

  it('renders the three theme options with auto pressed by default', () => {
    renderWithQuery(<Settings />);
    selectSection('theme');
    const auto = screen.getByRole('button', { name: '자동' });
    expect(auto).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Obsidian' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Ledger' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking Ledger updates the store and aria-pressed', async () => {
    renderWithQuery(<Settings />);
    selectSection('theme');
    const ledger = screen.getByRole('button', { name: 'Ledger' });
    fireEvent.click(ledger);
    await waitFor(() => {
      expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
    });
    expect(ledger).toHaveAttribute('aria-pressed', 'true');
  });
});

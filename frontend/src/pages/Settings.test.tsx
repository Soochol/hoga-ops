import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import * as symbolsApi from '../api/symbols';
import { useThemePrefsStore } from '../state/themePrefs';

vi.mock('../config', () => ({
  loadConfig: () => Promise.resolve({ api_url: 'http://test' }),
}));

// 데이터소스 상세가 /api/live/settings 를 읽는다. 모듈을 모킹해 네트워크를 끊는다 —
// 그 상세의 동작은 DataSourceDetail.test.tsx 가 커버하고, 여기서는 `/settings` 라우트
// 프레임이 통합 셸을 제대로 띄우는지만 본다.
vi.mock('../api/liveSettings', () => ({
  useLiveSettings: () => ({ data: undefined, isLoading: false, isError: false }),
  usePatchLiveSettings: () => ({ mutate: vi.fn(), isPending: false }),
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

describe('Settings — /settings 라우트 프레임', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
  });

  it('통합 셸을 렌더한다 — nav 8개, 기본 선택은 첫 항목(차트)', () => {
    renderWithQuery(<Settings />);
    for (const id of [
      'chart', 'trade-window', 'alerts', 'data-source', 'theme', 'symbols', 'general', 'roadmap',
    ]) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeInTheDocument();
    }
    // 셸이 하나가 되면서 기본 선택도 nav 첫 항목으로 통일됐다 — 옛 앱 설정 모달은
    // 자체 목록의 첫 항목인 「앱 정보」로 열렸다.
    expect(screen.getByTestId('settings-nav-chart')).toHaveAttribute('aria-current', 'true');
  });

  it('앱 정보 섹션이 API URL·버전을 보인다', async () => {
    renderWithQuery(<Settings />);
    selectSection('general');
    await waitFor(() => expect(screen.getByText('http://test')).toBeInTheDocument());
  });

  it('데이터소스 섹션이 라이브 데이터소스 상세(REST 우회 등)를 렌더한다', async () => {
    renderWithQuery(<Settings />);
    selectSection('data-source');
    expect(await screen.findByRole('switch', { name: 'REST 우회' })).toBeInTheDocument();
    expect(screen.getByText('표시 소스')).toBeInTheDocument();
    expect(screen.getByText('캡처 저장')).toBeInTheDocument();
  });

  it('renders a borderless full-bleed panel without repeating the nav page title', () => {
    renderWithQuery(<Settings />);
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    // 셸 testId 는 통합 후 `settings-shell` 하나다 — 옛 `settings-page-primary`
    // (페이지 전용)와 `live-settings-drawer-shell`(드로어 전용)이 합쳐졌다.
    const panel = screen.getByTestId('settings-shell');
    // 카드 크롬(보더) 제거 — 분리는 nav의 bg-subtle 톤 스텝이 담당. 페이지 프레임은
    // 바깥 래퍼로 이동했으므로 패널 자체는 borderless full-bleed 그리드다.
    expect(panel).toHaveClass('bg-bg-card');
    expect(panel).not.toHaveClass('border');
    expect(panel).toHaveClass('overflow-hidden');
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
    // master_fetch_failed is the only fetch-failure reason the symbols
    // backend actually emits on this surface — the previous mock used
    // trading_days_unavailable, an impossible state here, so the reachable
    // hint copy went untested.
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: TWO_HOURS_AGO,
      status: 'stale',
      reason: 'master_fetch_failed',
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

  it('Symbol Master 상세에는 시그널 알림 설정이 섞이지 않는다 (그건 「알림」 섹션 소관)', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });

    renderWithQuery(<Settings />);
    selectSection('symbols');

    await waitFor(() => expect(screen.getByText('fresh')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: '알림 사용' })).toBeNull();
  });
});

// 「데이터 수집」 describe 는 DataSourceDetail.test.tsx 로 이관됐다 — 토글 1개짜리
// 섹션이 캡처 쓰기 설정이 모여 있는 「캡처 저장」 그룹으로 흡수되면서, 그 검사도
// 컨트롤이 실제로 사는 곳을 따라갔다.

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

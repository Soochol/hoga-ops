import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivePage } from './LivePage';
import type { RangeBundle } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import { useWorkspaceStore } from '../state/workspace';
import type { IndicatorSettingsByTimeframe } from '../state/indicatorSettingsV2';
import { useLiveVenueStore } from '../state/liveVenue';
import { DEFAULT_CARD_WEIGHTS, DEFAULT_RIGHT_PANEL_WIDTH_PX, useLiveLayoutStore } from '../state/liveLayout';
import * as liveStatus from '../api/liveStatus';
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from './liveDateTime';
import type { LiveTimeframe } from '../state/livePage';

const livePageMocks = vi.hoisted(() => {
  const liveOb = [{
    t_ms: 1,
    total_ask_qty: 100,
    total_bid_qty: 90,
    asks: [{ price: 1000, qty: 10 }],
    bids: [{ price: 990, qty: 9 }],
  }];
  const liveTrade = [{
    t_ms: 1,
    trades: [{ t_ms: 1, side: 1, price: 1000, qty: 5 }],
  }];
  return {
    liveOb,
    liveTrade,
    // 심볼 마스터 스텁의 가변 상태 — undefined 면 "아직 로딩 중"(콜드 스타트).
    // 실명 보강 테스트가 로딩→도착 전이를 재현하려면 가변이어야 한다.
    symbolsResult: { data: undefined as { symbols: Array<{ code: string; name: string; market: string }> } | undefined },
    indicatorPanelProps: [] as Array<{ timeframe: LiveTimeframe }>,
    liveChartRootProps: [] as Array<{
      code?: string | null;
      timeframe?: string;
      viewIdentity?: string;
      restoreViewport?: unknown;
      onViewportCaptureReady?: (capture: () => unknown) => void;
      chartBundle?: RangeBundle | null;
      tradeVolumePocs?: unknown[];
      isExtending?: boolean;
      pastDataWarnings?: Array<{ reason: string; msg?: string }>;
      paneTogglesOverride?: { hogaPanes?: boolean };
      dayAskPeaks?: unknown[];
      todayAllPriceAskPeak?: unknown;
      dayBidPeaks?: unknown[];
      todayAllPriceBidPeak?: unknown;
    }>,
    liveBundleCalls: [] as Array<{
      code: unknown;
      timeframe: unknown;
      options: { investorNetEnabled?: boolean; venue?: string };
    }>,
    liveBundleResult: {
      bundle: null as RangeBundle | null,
      chartBundle: null as RangeBundle | null,
      hogaBundle: null as RangeBundle | null,
    },
    indexCandlesCalls: [] as unknown[],
    indexCandlesResult: {
      data: undefined as unknown,
      isLoading: false,
      isFetching: false,
    },
    indexInvestorNetCalls: [] as unknown[],
    indexInvestorNetResult: {
      data: undefined as unknown,
      isLoading: false,
    },
    dayAskPeakObArgs: [] as unknown[],
    dayAskPeakTradeArgs: [] as unknown[],
    dayAskPeakTodayArgs: [] as unknown[],
    allPriceObArgs: [] as unknown[],
    allPriceTodayArgs: [] as unknown[],
    // 매수 최대벽·매물대 POC 의 라이브 인자 — 매도와 **같은 계산 게이트**를 공유하므로
    // 관측 지점도 같이 둔다(하나만 두면 나머지 둘이 조용히 게이트를 잃는다).
    dayBidPeakObArgs: [] as unknown[],
    dayBidPeakTradeArgs: [] as unknown[],
    tradeVolumePocTradeArgs: [] as unknown[],
    tradeVolumePocObArgs: [] as unknown[],
    currentStudySaveSource: null as unknown,
    dayBidPeaksResult: null as unknown[] | null,
    tradeVolumePocsResult: [] as unknown[],
    todayAskPeak: {
      date: '20260616',
      coverage: 'partial',
      traded_price: 70000,
      traded_qty: 1000,
      traded_t_ms: 1,
      all_price: 70100,
      all_qty: 1500,
      all_t_ms: 2,
    },
  };
});

// jsdom does not implement ResizeObserver — provide a no-op stub.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// LiveWorkarea now mounts LiveChartRoot (single chart, 5 panes) when an
// activeCode is set. Mock LiveChartRoot so the shell tests stay unit-level
// and don't have to model lightweight-charts' full v5 series/timeScale API.
vi.mock('./LiveChartRoot', () => ({
  LiveChartRoot: (props: {
    code?: string | null;
    timeframe?: string;
    viewIdentity?: string;
    restoreViewport?: unknown;
    onViewportCaptureReady?: (capture: () => unknown) => void;
  }) => {
    livePageMocks.liveChartRootProps.push(props);
    return null;
  },
}));

// LiveSidebar reads live status via useLiveSeries (EventSource), which isn't
// available in jsdom. Mock the hook so the shell tests stay unit-level.
vi.mock('../api/liveSeries', () => ({
  useLiveSeries: (code: string) => ({
    initial: { code, ask_peak_today: livePageMocks.todayAskPeak, bid_peak_today: null }, isLoading: false, error: null,
    ob: livePageMocks.liveOb, trade: livePageMocks.liveTrade, broker: [], program: [],
  }),
}));

// ⚠ 이 목의 인자 자리는 **실제 시그니처와 자릿수까지 같아야 한다** — 테스트가 위치로
// 값을 집어내므로, 훅에 인자가 하나 늘면 여기도 같이 늘려야 조용히 엉뚱한 값을 재지 않는다
// (`_sessionOpenMs` 가 그 자리다: todayKst 뒤, code 앞).
vi.mock('./useDayAskPeaks', () => ({
  useTodayAllPriceAskPeak: (ob: unknown, _seeds: unknown, _today: unknown, _sessionOpenMs: unknown, _code: unknown, todayAskPeak: unknown) => {
    livePageMocks.allPriceObArgs.push(ob);
    livePageMocks.allPriceTodayArgs.push(todayAskPeak);
    return null;
  },
  useDayAskPeaks: (ob: unknown, trade: unknown, seeds: unknown, _today: unknown, _sessionOpenMs: unknown, _code: unknown, todayAskPeak: unknown) => {
    livePageMocks.dayAskPeakObArgs.push(ob);
    livePageMocks.dayAskPeakTradeArgs.push(trade);
    livePageMocks.dayAskPeakTodayArgs.push(todayAskPeak);
    return seeds ?? [];
  },
}));

vi.mock('./useDayBidPeaks', () => ({
  useTodayAllPriceBidPeak: () => null,
  useDayBidPeaks: (ob: unknown, trade: unknown, seeds: unknown) => {
    livePageMocks.dayBidPeakObArgs.push(ob);
    livePageMocks.dayBidPeakTradeArgs.push(trade);
    return livePageMocks.dayBidPeaksResult ?? seeds ?? [];
  },
}));

// ⚠ 위 `useDayAskPeaks` 목과 같은 규율 — 인자 자리가 실제 시그니처와 자릿수까지 같아야 한다.
// 여기서 재는 것은 **1번(trades)과 7번(orderbooks)**, 즉 틱마다 churn 하는 라이브 인자 둘이다.
// 3~6번(seeds·today·code·candles·segments)은 게이트 대상이 아니라 그대로 흐른다.
vi.mock('./useTradeVolumePoc', () => ({
  useTradeVolumePocs: (
    trades: unknown,
    _seeds: unknown,
    _todayKst: unknown,
    _code: unknown,
    _candles: unknown,
    _segments: unknown,
    orderbooks: unknown,
  ) => {
    livePageMocks.tradeVolumePocTradeArgs.push(trades);
    livePageMocks.tradeVolumePocObArgs.push(orderbooks);
    return livePageMocks.tradeVolumePocsResult;
  },
}));

// LiveSidebar now calls cursor hooks (ADR-0044) — mock them so the shell
// tests stay unit-level and don't trigger useSpot/apiGet in jsdom.
vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: () => undefined,
  useLiveBrokersAtCursor: () => undefined,
}));

// useLiveStatusProjection reads the authoritative watchlist via useWatchlist;
// mock it non-empty so the banner logic stays unit-level and doesn't hit
// /api/watchlist in jsdom. (Empty-state is exercised in liveStatusProjection.test.ts.)
// useAddToWatchlist / useRemoveFromWatchlist are stubbed defensively; the
// symbol search now lives in the global TopNav, but other live surfaces still
// touch these hooks in jsdom.
vi.mock('../watchlist/useWatchlist', () => ({
  useWatchlist: () => ({ data: { entries: [{ code: '000660' }], next_run_at_ms: 0 } }),
  useAddToWatchlist: () => ({ mutate: vi.fn() }),
  useRemoveFromWatchlist: () => ({ mutate: vi.fn() }),
}));

vi.mock('../api/liveIndices', () => ({
  useLiveIndices: () => ({ data: [] }),
  useLiveIndexCandles: (...args: unknown[]) => {
    livePageMocks.indexCandlesCalls.push(args);
    return livePageMocks.indexCandlesResult;
  },
  useLiveIndexInvestorNet: (...args: unknown[]) => {
    livePageMocks.indexInvestorNetCalls.push(args);
    return livePageMocks.indexInvestorNetResult;
  },
}));

// LivePage now owns the single useLiveBundle call. Mock to avoid TanStack
// queries hitting real endpoints in the shell test.
vi.mock('./useLiveBundle', () => ({
  useLiveBundle: (
    code: unknown,
    timeframe: unknown,
    _today: unknown,
    _live: unknown,
    options?: { investorNetEnabled?: boolean; venue?: string },
  ) => {
    livePageMocks.liveBundleCalls.push({ code, timeframe, options: options ?? {} });
    return {
      ...livePageMocks.liveBundleResult,
      isLoading: false,
      error: null,
      clampEngaged: false,
      isPastCandlesLoading: false,
      pastDataWarnings: [],
    };
  },
}));

vi.mock('./indicators/IndicatorPanel', () => ({
  default: ({ onClose, timeframe }: { onClose: () => void; timeframe: LiveTimeframe }) => {
    livePageMocks.indicatorPanelProps.push({ timeframe });
    return (
      <div role="dialog" aria-label="지표">
        <button type="button" onClick={onClose}>닫기</button>
      </div>
    );
  },
}));

// 저장 소스는 더 이상 전역 1슬롯으로 발행되지 않는다 — 창이 자기 소스를 헤더
// 버튼에 직접 넘긴다. 관측 지점도 "버튼이 실제로 받은 prop" 으로 옮긴다.
vi.mock('../studyViews/LiveStudyViewSaveButton', () => ({
  LiveStudyViewSaveButton: ({ source }: { source: unknown }) => {
    livePageMocks.currentStudySaveSource = source;
    return <button type="button" data-testid="live-study-save-button" disabled={!source} />;
  },
}));

vi.mock('../capture/useSymbols', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../capture/useSymbols')>();
  return {
    ...actual,
    // 심볼 마스터 스텁 — 기본은 000660만 실명 해석. 005930은 목록에 없어 미해석 폴백
    // (탭 타이틀 테스트의 document.title === '005930' 단언)을 그대로 유지한다.
    useSymbols: () => livePageMocks.symbolsResult as unknown as ReturnType<typeof actual.useSymbols>,
  };
});

function rangeBundleFixture(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0, band_pct: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: overrides.volume_distributions ?? [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    ...overrides,
  };
}

// 멀티창 플립(ADR-0119 C2c-2d): 파이프라인은 차트 창 안에서 돈다. 셸 테스트는
// 단일 차트 창(TEST_WIN)을 시드한다. 봉은 창 설정으로, **지표는 전역 스토어로**
// 주입한다 — 설정은 앱 전역 1세트고 창은 어느 봉 버킷을 볼지만 정한다.
const TEST_WIN = 'w-test';
function seedWorkspace(
  timeframe: LiveTimeframe = '1m',
  byTimeframe: IndicatorSettingsByTimeframe = {},
) {
  useLivePageStore.setState({ indicatorsByTimeframe: byTimeframe });
  useWorkspaceStore.setState({
    windows: [{
      id: TEST_WIN,
      kind: 'chart',
      group: 1,
      rect: { x: 0, y: 0, w: 800, h: 600 },
      chart: { timeframe },
    }],
    zOrder: [TEST_WIN],
    groupSymbols: {},
    chartRuntime: {},
  });
}

/** 매 호출이 **새 엘리먼트**를 만든다 — rerender 로 같은 마운트를 유지한 채 훅
 *  응답 변화를 흘려보낼 때 필요하다(같은 엘리먼트 참조면 React 가 재렌더를 건너뛴다). */
function liveTree(initial = '/live', qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/live" element={<LivePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderWithRouter(initial = '/live') {
  return render(liveTree(initial));
}

describe('LivePage shell', () => {
  beforeEach(() => {
    localStorage.clear();
    document.title = 'before-test';
    livePageMocks.dayAskPeakObArgs.length = 0;
    livePageMocks.dayAskPeakTradeArgs.length = 0;
    livePageMocks.liveChartRootProps.length = 0;
    livePageMocks.liveBundleCalls.length = 0;
    livePageMocks.indicatorPanelProps.length = 0;
    livePageMocks.liveBundleResult.bundle = null;
    livePageMocks.liveBundleResult.chartBundle = null;
    livePageMocks.liveBundleResult.hogaBundle = null;
    livePageMocks.indexCandlesCalls.length = 0;
    livePageMocks.indexCandlesResult.data = undefined;
    livePageMocks.indexCandlesResult.isLoading = false;
    livePageMocks.indexCandlesResult.isFetching = false;
    livePageMocks.indexInvestorNetCalls.length = 0;
    livePageMocks.indexInvestorNetResult.data = undefined;
    livePageMocks.indexInvestorNetResult.isLoading = false;
    livePageMocks.dayAskPeakTodayArgs.length = 0;
    livePageMocks.allPriceObArgs.length = 0;
    livePageMocks.allPriceTodayArgs.length = 0;
    livePageMocks.dayBidPeakObArgs.length = 0;
    livePageMocks.dayBidPeakTradeArgs.length = 0;
    livePageMocks.tradeVolumePocTradeArgs.length = 0;
    livePageMocks.tradeVolumePocObArgs.length = 0;
    livePageMocks.currentStudySaveSource = null;
    livePageMocks.dayBidPeaksResult = null;
    livePageMocks.tradeVolumePocsResult = [];
    livePageMocks.symbolsResult.data = {
      symbols: [{ code: '000660', name: 'SK하이닉스', market: 'KOSPI' }],
    };
    // 단일 뷰 모델(ADR-0113): 마운트 시드는 복원된 activeInstrument를 읽으므로
    // 매 테스트마다 page 스토어의 subject를 리셋해 격리한다.
    useLivePageStore.setState({
      activeInstrument: null,
      activeCode: null,
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    seedWorkspace('1m');
    useLiveVenueStore.setState({ venue: 'KRX' });
    useLiveLayoutStore.setState({
      rightPanelWidthPx: DEFAULT_RIGHT_PANEL_WIDTH_PX,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });
    vi.spyOn(liveStatus, 'useLiveStatus').mockReturnValue({
      data: {
        running: true,
        started_at_ms: 1,
        last_tick_ms: 1,
        cycle_lag_ms: 100,
        capture_healthy: true,
        capture_reason: 'healthy',
        watchlist_count: 1,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof liveStatus.useLiveStatus>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the flip chrome: chart window header + workspace toolbar + canvas window', () => {
    renderWithRouter('/live?code=000660');
    // 차트 창 헤더(봉·그리기·저장 툴바)와 전역 툴바가 뜬다. 종목 식별은 창
    // 타이틀바(TitleBarSymbolRow)로 이관돼 거기서 코드가 노출된다.
    expect(screen.getByTestId('chart-window-header')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-live-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('titlebar-symbol-row').textContent).toContain('000660');
    // 봉 컨트롤은 창 소유(#708) — 차트 창 상단에 렌더된다.
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 1분' })).toBeInTheDocument();
  });

  // 열 축을 비워두면 grid-auto-columns:auto 가 되고, 그 트랙은 가장 넓은 자식의
  // min-content 폭에서 바닥을 친다. 그러면 캔버스가 컨테이너보다 넓게 늘어난 채 App 의
  // <main overflow-hidden> 에 잘려 우측이 사라진다. 행 축도 같은 이유로 minmax(0,1fr) —
  // 두 축을 함께 잠근다.
  it('constrains both root grid axes so narrowing shrinks the canvas instead of clipping it', () => {
    renderWithRouter('/live?code=000660');

    let root: HTMLElement | null = screen.getByTestId('workspace-live-toolbar');
    while (root && !root.style.gridTemplateRows) root = root.parentElement;

    expect(root).not.toBeNull();
    expect(root!.style.gridTemplateRows).toContain('minmax(0, 1fr)');
    expect(root!.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });

  it('shows the collect button for a stock code and opens the collect dialog with the symbol name', async () => {
    renderWithRouter('/live?code=000660');

    act(() => {
      screen.getByTestId('live-collect-button').click();
    });

    // 딥링크 시드는 label=code 지만, 제목은 심볼 마스터의 실명으로 보강된다.
    const dialog = await screen.findByRole('dialog', { name: 'SK하이닉스 지난 N일 수집' });
    // 단일 종목 스코프 — 대상 1종목이 그대로 노출된다.
    expect(dialog.textContent).toContain('1');
  });

  // 수집 버튼은 창 헤더로 이관됐고, 게이트도 전역 activeStockCode 에서 창 로컬로
  // 옮겨졌다 — 지수 창은 수집할 종목 코드가 없으므로 비활성(부재가 아니라).
  it('disables the collect button on an index chart window', async () => {
    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(useLivePageStore.getState().activeInstrument?.kind).toBe('index'));
    expect(screen.getByTestId('workspace-live-toolbar')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('live-collect-button')).toBeDisabled());
  });

  it('passes the focused chart window timeframe into IndicatorPanel', async () => {
    seedWorkspace('D');

    renderWithRouter('/live?code=000660');
    act(() => {
      screen.getByTestId('live-indicators-button').click();
    });

    await waitFor(() => expect(livePageMocks.indicatorPanelProps.at(-1)?.timeframe).toBe('D'));
    expect(screen.getByRole('dialog', { name: '지표' })).toBeInTheDocument();
  });

  it('enables stock investor net fetches from the window D bucket', async () => {
    seedWorkspace('D', { D: { foreignNetEnabled: true } });

    renderWithRouter('/live?code=000660');

    await waitFor(() => expect(livePageMocks.liveBundleCalls.some((call) =>
      call.code === '000660'
      && call.timeframe === 'D'
      && call.options.investorNetEnabled === true)).toBe(true));
  });

  it('reads activeCode from ?code= query param', () => {
    renderWithRouter('/live?code=000660');
    // 종목 식별은 창 타이틀바(TitleBarSymbolRow)가 노출한다.
    expect(screen.getByTestId('titlebar-symbol-row').textContent).toContain('000660');
  });

  // 창 헤더가 `종목명(종목코드)` 가 아니라 `종목코드(종목코드)` 로 나오던 버그.
  // 딥링크 시드가 activateLiveCode 를 label 없이 불러 `label ?? code` 폴백이
  // 종목명 자리에 코드를 저장했고, 그걸 되돌리는 경로가 아무 데도 없었다.
  describe('deep-link seed resolves the real symbol name', () => {
    it('seeds the group symbol with the master name when the master is already warm', async () => {
      renderWithRouter('/live?code=000660');
      await waitFor(() => expect(useWorkspaceStore.getState().groupSymbols[1]).toEqual({
        code: '000660',
        name: 'SK하이닉스',
      }));
      expect(screen.getByTestId('titlebar-symbol-row').textContent)
        .toContain('SK하이닉스(000660)');
    });

    it('backfills the name when the master arrives after the one-shot seed', async () => {
      // 콜드 스타트 — 시드 시점엔 해석할 이름이 없다. 시드는 1회뿐이라 스스로는
      // 못 되돌아오고, 보강 effect 만이 이걸 고칠 수 있다.
      livePageMocks.symbolsResult.data = undefined;
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(liveTree('/live?code=000660', qc));
      await waitFor(() => expect(useWorkspaceStore.getState().groupSymbols[1]?.name).toBe('000660'));

      // 마스터 도착 — 같은 마운트에서 응답만 바뀐다(언마운트하면 시드가 다시 돌아
      // 보강 경로가 아니라 시드 경로를 재는 테스트가 된다).
      livePageMocks.symbolsResult.data = {
        symbols: [{ code: '000660', name: 'SK하이닉스', market: 'KOSPI' }],
      };
      view.rerender(liveTree('/live?code=000660', qc));
      await waitFor(() => expect(useWorkspaceStore.getState().groupSymbols[1]?.name).toBe('SK하이닉스'));
      expect(screen.getByTestId('titlebar-symbol-row').textContent)
        .toContain('SK하이닉스(000660)');
    });

    it('heals a poisoned name restored from a previous session', async () => {
      // sessionStorage 하이드레이션으로 이미 오염된 값이 실려 온 경우 — 딥링크가
      // 없어도 보강 effect 가 고친다(표시 시점 보강이 아니라 스토어 보강인 이유).
      useWorkspaceStore.setState({ groupSymbols: { 1: { code: '000660', name: '000660' } } });
      renderWithRouter('/live');
      await waitFor(() => expect(useWorkspaceStore.getState().groupSymbols[1]?.name).toBe('SK하이닉스'));
    });
  });

  it('reads active index from ?index= query param without setting activeCode', async () => {
    renderWithRouter('/live?index=KOSPI');
    await waitFor(() => expect(useLivePageStore.getState().activeInstrument).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
    }));
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('renders an index chart bundle for daily index deep links', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      timeframe: 'D',
      candles: [
        {
          t_ms: 1_781_830_800_000,
          open: 2840.12,
          high: 2861.34,
          low: 2833.2,
          close: 2855.67,
          volume: 450000000,
        },
      ],
      data_warnings: [],
    };
    seedWorkspace('D');

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: 'D',
    }));
    const lastIndexCall = livePageMocks.indexCandlesCalls.at(-1) as unknown[] | undefined;
    expect(lastIndexCall?.[0]).toBe('KOSPI');
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.candles[0].close).toBe(2855.67);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.quote_ratio.points).toEqual([]);
    expect(livePageMocks.liveChartRootProps.at(-1)?.paneTogglesOverride?.hogaPanes).toBe(false);
  });

  it('renders an index chart bundle for minute index deep links', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      timeframe: '1m',
      candles: [
        {
          t_ms: 1_781_829_000_000,
          open: 2850.10,
          high: 2852.34,
          low: 2849.87,
          close: 2851.67,
          volume: 123456,
        },
      ],
      data_warnings: [],
    };
    seedWorkspace('1m');

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: '1m',
    }));
    const lastIndexCall = livePageMocks.indexCandlesCalls.at(-1) as unknown[] | undefined;
    expect(lastIndexCall?.[0]).toBe('KOSPI');
    expect(lastIndexCall?.[1]).toBe('1m');
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.bucket_ms).toBe(60_000);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.candles[0].close).toBe(2851.67);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.quote_ratio.points).toEqual([]);
    expect(livePageMocks.liveChartRootProps.at(-1)?.paneTogglesOverride?.hogaPanes).toBe(false);
  });

  it.each(['1m', 'D', 'W', 'M'] as const)(
    'fetches index %s candles from the same initial history window as stock charts',
    async (timeframe: LiveTimeframe) => {
      seedWorkspace(timeframe);

      renderWithRouter('/live?index=KOSPI');

      await waitFor(() => {
        expect(livePageMocks.indexCandlesCalls.some((args) => {
          const call = args as unknown[];
          return call[0] === 'KOSPI' && call[1] === timeframe;
        })).toBe(true);
      });
      const call = (livePageMocks.indexCandlesCalls as unknown[][]).find((args) =>
        args[0] === 'KOSPI' && args[1] === timeframe,
      );
      expect(call?.[2]).toBe(subtractDaysKst(todayKstYyyymmdd(), initialHistoricalDaysFor(timeframe)));
    },
  );

  it('marks index charts as extending while a historical index fetch is in flight', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260601',
      to: '20260619',
      timeframe: 'W',
      candles: [
        {
          t_ms: 1_781_830_800_000,
          open: 2840.12,
          high: 2861.34,
          low: 2833.2,
          close: 2855.67,
          volume: 450000000,
        },
      ],
      data_warnings: [],
    };
    livePageMocks.indexCandlesResult.isFetching = true;
    seedWorkspace('W');

    renderWithRouter('/live?index=KOSPI');
    act(() => {
      useWorkspaceStore.getState().extendChartHistoricalRange(TEST_WIN, '20200101');
    });

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: 'W',
      isExtending: true,
    }));
  });

  it('passes index candle data warnings through to the chart surface', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260601',
      to: '20260622',
      timeframe: '1m',
      candles: [
        {
          t_ms: 1_782_103_980_000,
          open: 2850.10,
          high: 2852.34,
          low: 2849.87,
          close: 2851.67,
          volume: 123456,
        },
      ],
      data_warnings: [
        { batch: '20260601__20260622', date: '20260622', reason: 'index_minute_depth_limited', msg: 'limited' },
      ],
    };
    seedWorkspace('1m');
    useWorkspaceStore.setState({
      chartRuntime: { [TEST_WIN]: { historicalFromDate: '20260601', lastMinuteHistoricalFromDate: null } },
    });

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: '1m',
      pastDataWarnings: [
        expect.objectContaining({ reason: 'index_minute_depth_limited' }),
      ],
    }));
  });

  it('hydrates KOSPI daily index charts with market investor net points', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      timeframe: 'D',
      candles: [
        {
          t_ms: 1_781_830_800_000,
          open: 2840.12,
          high: 2861.34,
          low: 2833.2,
          close: 2855.67,
          volume: 450000000,
        },
      ],
      data_warnings: [],
    };
    livePageMocks.indexInvestorNetResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      points: [
        { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
      ],
      data_warnings: [],
    };
    seedWorkspace('D', { D: { foreignNetEnabled: true } });
    useWorkspaceStore.setState({
      chartRuntime: { [TEST_WIN]: { historicalFromDate: '20260619', lastMinuteHistoricalFromDate: null } },
    });

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.indexInvestorNetCalls.length).toBeGreaterThan(0));
    expect(livePageMocks.liveBundleCalls.at(-1)?.options.investorNetEnabled).toBe(true);
    const lastInvestorCall = livePageMocks.indexInvestorNetCalls.at(-1) as unknown[] | undefined;
    expect(lastInvestorCall?.[0]).toBe('KOSPI');
    expect(lastInvestorCall?.[1]).toBe('20260619');
    expect(lastInvestorCall?.[3]).toBe(true);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.investorPoints).toEqual([
      { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
    ]);
  });

  it('does not fetch investor net for non-market representative indices', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI200',
      from: '20260619',
      to: '20260619',
      timeframe: 'D',
      candles: [],
      data_warnings: [],
    };
    seedWorkspace('D', { D: { foreignNetEnabled: true } });
    useWorkspaceStore.setState({
      chartRuntime: { [TEST_WIN]: { historicalFromDate: '20260619', lastMinuteHistoricalFromDate: null } },
    });

    renderWithRouter('/live?index=KOSPI200');

    await waitFor(() => expect(livePageMocks.indexCandlesCalls.length).toBeGreaterThan(0));
    const lastInvestorCall = livePageMocks.indexInvestorNetCalls.at(-1) as unknown[] | undefined;
    expect(lastInvestorCall?.[0]).toBeNull();
    expect(lastInvestorCall?.[3]).toBe(false);
  });

  it('sets the browser tab title from the active Code on /live', async () => {
    renderWithRouter('/live?code=005930');
    await waitFor(() => expect(document.title).toBe('005930'));
  });

  it('falls back to the restored workspace group symbol when no query param', () => {
    // 플립 후 종목 SSOT = live.workspace.v1 의 groupSymbols(활성 그룹) 복원.
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '035720', name: '035720' } } });
    renderWithRouter();
    expect(screen.getByTestId('titlebar-symbol-row').textContent).toContain('035720');
  });

  it('passes activeCode:venue as chart view identity (창별)', () => {
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });

    renderWithRouter();

    expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: '005930',
      timeframe: '1m',
      viewIdentity: '005930:KRX',
    });
  });

  it('does not restore logical viewport across minute timeframe changes', async () => {
    const capturedViewport = {
      rightEdgeMs: 1_781_000_000_000,
      barSpan: 331,
      atLiveEdge: true,
    };
    renderWithRouter('/live?code=005930');
    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)?.code).toBe('005930'));
    act(() => {
      livePageMocks.liveChartRootProps.at(-1)?.onViewportCaptureReady?.(() => capturedViewport);
    });

    act(() => {
      screen.getByRole('button', { name: '분봉 선택 열기: 1분' }).click();
    });
    act(() => {
      screen.getByRole('menuitemradio', { name: '3분' }).click();
    });

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)?.timeframe).toBe('3m'));
    // 창 tf 가 스토어에도 커밋됐는지(창 소유) — 뷰포트는 비저장(#713)이라 prop 없음.
    expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('3m');
  });

  // venue 진단 라벨(캔들 시간대 자동·호가 NXT·소스칩)은 상태바와 함께 폐지됐다 —
  // venue 는 이제 bundle 페치 옵션과 차트 view identity 로만 흐른다.
  it('includes the selected venue in bundle options and chart identity', () => {
    useLiveVenueStore.setState({ venue: 'UN' });
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });

    renderWithRouter();

    expect(livePageMocks.liveBundleCalls.at(-1)?.options.venue).toBe('UN');
    expect(livePageMocks.liveChartRootProps.at(-1)?.viewIdentity).toBe('005930:UN');
  });

  it('shows the per-window placeholder when the active group has no symbol', () => {
    renderWithRouter();
    expect(screen.getByText(/종목 없음/)).toBeInTheDocument();
  });

  it('closes the indicator drawer when the last chart window disappears (리뷰 #3 latch)', async () => {
    renderWithRouter('/live?code=005930');
    act(() => { screen.getByTestId('live-indicators-button').click(); });
    // IndicatorPanel 은 이 스위트에서 role=dialog "지표" 로 목킹된다.
    await screen.findByRole('dialog', { name: '지표' });
    // 유일한 차트 창을 제거 → 드로어 null 렌더 + latch effect 로 open 플래그 정리.
    act(() => { useWorkspaceStore.setState({ windows: [], zOrder: [], chartRuntime: {} }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '지표' })).toBeNull());
  });


  it('shows the canvas-level empty state when there are no windows', () => {
    useWorkspaceStore.setState({ windows: [], zOrder: [], chartRuntime: {} });
    renderWithRouter();
    expect(screen.getByTestId('workspace-empty-add-chart')).toBeInTheDocument();
  });

  it('search write wins over a ?code= deep link — workspace 활성 그룹이 단일 SoT', async () => {
    renderWithRouter('/live?code=005930');
    // 딥링크 1회 시드 → 활성 그룹 종목 + 레거시 미러.
    await waitFor(() => expect(useLivePageStore.getState().activeCode).toBe('005930'));
    // 검색/♥ 선택이 다른 종목을 활성 그룹에 쓴다.
    act(() => {
      useWorkspaceStore.getState().setGroupSymbol(1, { code: '000660', name: 'SK하이닉스' });
    });
    expect(useWorkspaceStore.getState().groupSymbols[1]?.code).toBe('000660');
    // URL 이 되돌리지 않고, 미러도 000660 으로 수렴한다.
    await waitFor(() => expect(useLivePageStore.getState().activeCode).toBe('000660'));
  });

  it('passes live orderbook snapshots to ask-peak ratchet on minute timeframes (지표 ON)', () => {
    // 봉 축(분봉)과 토글 축(askPeakEnabled)이 **둘 다** 열려야 라이브 스트림이 흐른다.
    // 종전엔 봉 축뿐이라 이 테스트가 토글을 안 켜고도 통과했다 — 그 비대칭이 곧 결함이었다.
    seedWorkspace('1m', { minute: { askPeakEnabled: true } });
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayAskPeakObArgs.at(-1)).toBe(livePageMocks.liveOb);
    expect(livePageMocks.dayAskPeakTradeArgs.at(-1)).toBe(livePageMocks.liveTrade);
    expect(livePageMocks.allPriceObArgs.at(-1)).toBe(livePageMocks.liveOb);
  });

  /**
   * 계산 게이트의 토글 축 — 봉 축(바로 아래 'calendar timeframes')과 **교대 대조**를 이룬다.
   *
   * 이걸 지키지 않으면 최대벽을 한 번도 켠 적 없는 사용자가 매 flush(150ms)마다 `live.ob`
   * 전량 스캔을 낸다. 화면에는 아무것도 안 그려지므로(렌더는 `LiveAskPeakSegments` 안에서
   * `askPeakEnabled` 로 이미 게이트된다) 증상이 "차트가 그냥 무겁다" 로만 나타나고, 그래서
   * **테스트로만 잡힌다**. 백엔드 fetch 게이트(`planLiveRangeRequest` 의 `askPeaksEnabled`)와
   * 같은 술어를 쓰는지가 이 단언의 요지다.
   *
   * `seedWorkspace('1m')` 의 기본값이 곧 공장 기본값(OFF)이라 시드를 비워 두는 것이 전제다.
   */
  it('does not feed live orderbook snapshots into ask-peak ratchet when the indicator is off', () => {
    seedWorkspace('1m');
    renderWithRouter('/live?code=005930');
    const ob = livePageMocks.dayAskPeakObArgs.at(-1);
    const trade = livePageMocks.dayAskPeakTradeArgs.at(-1);
    expect(ob).not.toBe(livePageMocks.liveOb);
    expect(ob).toEqual([]);
    expect(trade).not.toBe(livePageMocks.liveTrade);
    expect(trade).toEqual([]);
    expect(livePageMocks.allPriceObArgs.at(-1)).toEqual([]);
  });

  // 매수 최대벽 — 매도와 **독립 토글**이라 따로 센다. 하나만 게이트하면 반대쪽이
  // 조용히 전액 비용을 계속 낸다(#923 이 히트맵·증감만 고치고 이 셋을 빠뜨린 모양 그대로).
  it('passes live snapshots to bid-peak ratchet when the indicator is on', () => {
    seedWorkspace('1m', { minute: { bidPeakEnabled: true } });
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayBidPeakObArgs.at(-1)).toBe(livePageMocks.liveOb);
    expect(livePageMocks.dayBidPeakTradeArgs.at(-1)).toBe(livePageMocks.liveTrade);
  });

  it('does not feed live snapshots into bid-peak ratchet when the indicator is off', () => {
    seedWorkspace('1m');
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayBidPeakObArgs.at(-1)).toEqual([]);
    expect(livePageMocks.dayBidPeakTradeArgs.at(-1)).toEqual([]);
  });

  /**
   * 매물대 POC — `orderbooks` 인자가 `firstTrailingSinglePriceBookMs` 로 들어가고,
   * 그 함수는 조기 종료 없이 ob 창을 **두 번 완주**한다. 즉 이 게이트가 빠지면 최대벽을
   * 다 꺼도 ob 전량 스캔이 남는다 — 셋을 함께 게이트해야 하는 이유가 이것이다.
   */
  it('passes live snapshots to trade-volume POC when the indicator is on', () => {
    seedWorkspace('1m', { minute: { tradeVolumePocEnabled: true } });
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.tradeVolumePocTradeArgs.at(-1)).toBe(livePageMocks.liveTrade);
    expect(livePageMocks.tradeVolumePocObArgs.at(-1)).toBe(livePageMocks.liveOb);
  });

  it('does not feed live snapshots into trade-volume POC when the indicator is off', () => {
    seedWorkspace('1m');
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.tradeVolumePocTradeArgs.at(-1)).toEqual([]);
    expect(livePageMocks.tradeVolumePocObArgs.at(-1)).toEqual([]);
  });

  it('does not feed live orderbook snapshots into ask-peak ratchet on calendar timeframes', () => {
    seedWorkspace('D');
    renderWithRouter('/live?code=005930');
    const ob = livePageMocks.dayAskPeakObArgs.at(-1);
    const trade = livePageMocks.dayAskPeakTradeArgs.at(-1);
    expect(ob).not.toBe(livePageMocks.liveOb);
    expect(ob).toEqual([]);
    expect(trade).not.toBe(livePageMocks.liveTrade);
    expect(trade).toEqual([]);
  });

  it('passes backend today ask-peak payload to useDayAskPeaks', () => {
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayAskPeakTodayArgs.at(-1)).toBe(livePageMocks.todayAskPeak);
    expect(livePageMocks.allPriceTodayArgs.at(-1)).toBe(livePageMocks.todayAskPeak);
  });

  it('does not pass stale ask-peak seeds from a bundle whose code differs from the active tab', async () => {
    const staleAskPeaks = [
      { date: '20260616', price: 53000, qty: 21_000, t_ms: 1, max_price: 53000, max_qty: 21_000, max_t_ms: 1 },
    ];
    livePageMocks.liveBundleResult.bundle = rangeBundleFixture({
      code: '005930',
      ask_peaks: staleAskPeaks,
    });
    livePageMocks.liveBundleResult.chartBundle = rangeBundleFixture({
      code: '005930',
      ask_peaks: staleAskPeaks,
    });

    renderWithRouter('/live?code=000660');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)?.code).toBe('000660'));
    expect(livePageMocks.dayAskPeakTodayArgs.at(-1)).toBe(livePageMocks.todayAskPeak);
    expect(livePageMocks.liveChartRootProps.at(-1)?.dayAskPeaks).toEqual([]);
  });

  it('preserves rendered bid_peaks in the live study save bundle when chartBundle is present', async () => {
    const askPeaks = [{ date: '20260616', price: 70100, qty: 1000, t_ms: 1, max_price: 70100, max_qty: 1000, max_t_ms: 1 }];
    const seedBidPeaks = [{ date: '20260616', price: 69900, qty: 1200, t_ms: 2, max_price: 69900, max_qty: 1200, max_t_ms: 2 }];
    const renderedBidPeaks = [{ date: '20260616', price: 69800, qty: 2200, t_ms: 3, max_price: 69800, max_qty: 2200, max_t_ms: 3 }];
    livePageMocks.liveBundleResult.bundle = rangeBundleFixture({
      quote_ratio: {
        bucket_ms: 300_000,
        points: [{ t: 1_000, bid_total: 500, ask_total: 400, bid_max: 5, ask_max: 4, imb_max_bid: 3, imb_max_ask: 2, band_pct: 0 }],
      },
      ask_peaks: [],
      bid_peaks: [],
    });
    livePageMocks.liveBundleResult.chartBundle = rangeBundleFixture({
      from_date: '20260615',
      to_date: '20260616',
      ask_peaks: askPeaks,
      bid_peaks: seedBidPeaks,
    });
    livePageMocks.dayBidPeaksResult = renderedBidPeaks;

    renderWithRouter('/live?code=005930');

    await waitFor(() => {
      expect(livePageMocks.currentStudySaveSource).toMatchObject({
        origin: 'live',
        code: '005930',
        bundle: {
          ask_peaks: askPeaks,
          bid_peaks: renderedBidPeaks,
        },
      });
    });
  });

  it('publishes raw chart data in the live study save source without indicator copies', async () => {
    livePageMocks.liveBundleResult.bundle = rangeBundleFixture({
      from_date: '20260615',
      to_date: '20260616',
      segments: [
        { date: '20260615', session_open_ms: 500, session_close_ms: 900 },
        { date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 },
      ],
    });
    livePageMocks.tradeVolumePocsResult = [{
      date: '20260616',
      centerPrice: 70_000,
      lowPrice: 69_500,
      highPrice: 70_500,
      qty: 12_345,
      t_ms: 1_000,
      bandPct: 0.0025,
    }];
    seedWorkspace('1m', {
      minute: {
        dailyMovingAverageEnabled: true,
        dailyMovingAverageHidden: true,
        dailyMovingAverages: [
          { id: 'dma-20', enabled: true, period: 20, color: '#EAB308', lineWidth: 2, source: 'close' },
        ],
        tradeVolumePocEnabled: true,
        tradeVolumePocBandPct: 0.0025,
        tradeVolumePocColor: '#22C55E',
        tradeVolumePocOpacity: 0.28,
      },
    });

    renderWithRouter('/live?code=005930');

    await waitFor(() => {
      expect(livePageMocks.currentStudySaveSource).toMatchObject({
        origin: 'live',
        bundle: {
          trade_volume_pocs: [{
            date: '20260616',
            center_price: 70_000,
            low_price: 69_500,
            high_price: 70_500,
            qty: 12_345,
            t_ms: 1_000,
            band_pct: 0.0025,
          }],
        },
      });
      expect('indicatorState' in (livePageMocks.currentStudySaveSource as Record<string, unknown>)).toBe(false);
    });
  });
});

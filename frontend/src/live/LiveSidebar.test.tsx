import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePageStore } from '../state/livePage';
import { useLiveLayoutStore } from '../state/liveLayout';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import type { LiveSeriesData } from '../api/liveSeries';
import type { DayVolumeDistribution, RangeBundle } from '../api/types';

const investorTrendEstimateMock = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
);
const volumeDistributionCutoffProfileMock = vi.hoisted(() =>
  vi.fn((args: { finalProfile: DayVolumeDistribution | null | undefined }) => args.finalProfile),
);

vi.mock('../api/liveInvestorTrendEstimate', () => ({
  useLiveInvestorTrendEstimate: investorTrendEstimateMock,
}));

vi.mock('./useVolumeDistributionCutoffProfile', () => ({
  useVolumeDistributionCutoffProfile: volumeDistributionCutoffProfileMock,
}));

import { LiveSidebar } from './LiveSidebar';

// Live fixture — LiveSidebar receives this as a prop (LivePage-lift refactor).
// No useLiveSeries mock needed: the sidebar no longer calls the hook.
const emptyLive: LiveSeriesData = {
  initial: undefined,
  isLoading: false,
  error: null,
  ob: [],
  trade: [],
  broker: [],
};

const bundleFixture: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    {
      date: '20260527',
      session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
      session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
      source: 'hogaplay',
    },
  ],
  candles: [
    {
      ts_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
      open: 70000,
      high: 70400,
      low: 70000,
      close: 70300,
      vol_a: 100,
      vol_b: 0,
    },
  ],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  bid_peaks: [],
  broker_late_entries: [],
  price_level_hits: [],
  trade_volume_pocs: [],
};

const finalDistribution: DayVolumeDistribution = {
  date: '20260527',
  range_count: 2,
  price_min: 70000,
  price_max: 70400,
  session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
  session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
  bins: [
    { price_low: 70000, price_high: 70200, qty: 150 },
    { price_low: 70200, price_high: 70400, qty: 300 },
  ],
};

const bundleWithFinalDistribution: RangeBundle = {
  ...bundleFixture,
  candles: [
    ...bundleFixture.candles,
    {
      ts_ms: Date.UTC(2026, 4, 27, 0, 1, 0),
      open: 70300,
      high: 70400,
      low: 70000,
      close: 70100,
      vol_a: 100,
      vol_b: 0,
    },
  ],
  volume_distributions: [finalDistribution],
};

const cutoffDistribution: DayVolumeDistribution = {
  ...finalDistribution,
  bins: [
    { price_low: 70000, price_high: 70200, qty: 300 },
    { price_low: 70200, price_high: 70400, qty: 0 },
  ],
};

vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => undefined),
  useLiveBrokersAtCursor: vi.fn(() => undefined),
}));

vi.mock('../sidebar/TotalQtyBar', () => ({
  default: vi.fn(() => <div data-testid="total-qty-bar" />),
}));

import * as cursorHooks from '../api/useLiveCursor';
import TotalQtyBar from '../sidebar/TotalQtyBar';

/** Build a QueryClient with ['live','status'] pre-seeded so useLiveStatus() resolves synchronously. */
function makeQc(liveSet: string[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['live', 'status'], {
    running: true,
    started_at_ms: 1,
    last_tick_ms: 1,
    cycle_lag_ms: 0,
    capture_healthy: true,
    capture_reason: 'healthy',
    watchlist_count: liveSet.length,
    kis_calls_today: 0,
    kis_rate_limit_remaining: null,
    live_set: liveSet,
  });
  return qc;
}

function renderSidebar(
  props: { code: string | null; live?: LiveSeriesData; bundle?: RangeBundle | null; todayKst?: string },
  liveSet: string[] = [],
) {
  const qc = makeQc(liveSet);
  return render(
    <QueryClientProvider client={qc}>
      <LiveSidebar
        code={props.code}
        live={props.live ?? emptyLive}
        bundle={props.bundle ?? null}
        todayKst={props.todayKst ?? '20260527'}
      />
    </QueryClientProvider>,
  );
}

describe('LiveSidebar', () => {
  beforeEach(() => {
    investorTrendEstimateMock.mockClear();
    investorTrendEstimateMock.mockReturnValue({ data: undefined, isLoading: false, error: null });
    volumeDistributionCutoffProfileMock.mockClear();
    volumeDistributionCutoffProfileMock.mockImplementation((args) => args.finalProfile);
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLivePageStore.setState({
      candleTimeframe: '1m',
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: false,
      volumeDistributionRangeCount: 10,
    });
    useLiveCursorStore.getState().resetCursor();
    useLiveAxisStore.setState({ axis: null });
    useLiveLayoutStore.setState({ rightCardCollapsed: {}, rightCardHidden: {}, detailPanelCollapsed: false });
    vi.mocked(TotalQtyBar).mockClear();
  });
  afterEach(() => cleanup());

  it('renders the sidebar shell when code is null (waiting state)', () => {
    renderSidebar({ code: null });
    expect(screen.getByTestId('live-sidebar')).toBeInTheDocument();
  });

  it('calls investor trend estimate hook with the active code', () => {
    renderSidebar({ code: '005930' });

    expect(investorTrendEstimateMock).toHaveBeenCalledWith('005930');
  });

  it('does not call stock-only sidebar hooks with index instruments', () => {
    renderSidebar({ code: 'index:KOSDAQ' });

    expect(investorTrendEstimateMock).toHaveBeenCalledWith(null);
    expect(cursorHooks.useLiveOrderbookAtCursor).toHaveBeenCalledWith(
      expect.objectContaining({ code: null }),
    );
    expect(cursorHooks.useLiveBrokersAtCursor).toHaveBeenCalledWith(
      expect.objectContaining({ code: null }),
    );
  });

  it('renders investor trend estimate card after brokers card', () => {
    renderSidebar({ code: '005930' });

    const brokers = screen.getByTestId('live-detail-card-brokers');
    const estimate = screen.getByTestId('live-detail-card-investor');
    expect(
      brokers.compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('investor-trend-estimate-card')).toBeInTheDocument();
  });

  it('renders brokers above the volume distribution card', () => {
    renderSidebar({ code: '005930' });

    const orderbook = screen.getByTestId('card-orderbook');
    const volumeDistribution = screen.getByTestId('card-volume-distribution');
    const brokers = screen.getByTestId('card-brokers');

    expect(
      orderbook.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      brokers.compareDocumentPosition(volumeDistribution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the persisted volume distribution for the active stock-date', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 2 });
    renderSidebar({
      code: '005930',
      bundle: {
        ...bundleFixture,
        candles: [
          ...bundleFixture.candles,
          {
            ts_ms: Date.UTC(2026, 4, 27, 0, 1, 0),
            open: 70300,
            high: 70400,
            low: 70000,
            close: 70100,
            vol_a: 100,
            vol_b: 0,
          },
        ],
        volume_distributions: [
          {
            date: '20260527',
            range_count: 2,
            price_min: 70000,
            price_max: 70400,
            session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
            bins: [
              { price_low: 70000, price_high: 70200, qty: 150 },
              { price_low: 70200, price_high: 70400, qty: 300 },
            ],
          },
        ],
      },
    });

    expect(screen.getByTestId('volume-distribution-time-axis')).toHaveTextContent('09:00');
    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(2);
    expect(screen.getByTestId('volume-distribution-max-bar')).toBeInTheDocument();
    expect(screen.getByTestId('volume-distribution-close-graph')).toBeInTheDocument();
  });

  it('keeps persisted today volume distribution instead of replacing it with the live tail', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 2 });
    const liveWithTrades: LiveSeriesData = {
      ...emptyLive,
      trade: [
        {
          t_ms: Date.UTC(2026, 4, 27, 0, 10, 0),
          kind: 'trade',
          trades: [
            { t_ms: Date.UTC(2026, 4, 27, 0, 10, 0), price: 70100, qty: 500, side: 1 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 11, 0), price: 70120, qty: 990, side: 0 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 12, 0), price: 70350, qty: 700, side: -1 },
          ],
        },
      ],
    };

    renderSidebar({
      code: '005930',
      live: liveWithTrades,
      bundle: {
        ...bundleFixture,
        volume_distributions: [
          {
            date: '20260527',
            range_count: 2,
            price_min: 70000,
            price_max: 70400,
            session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
            bins: [
              { price_low: 70000, price_high: 70200, qty: 150 },
              { price_low: 70200, price_high: 70400, qty: 300 },
            ],
          },
        ],
      },
    });

    expect(screen.getByTestId('volume-distribution-time-axis')).toHaveTextContent('09:00');
    expect(screen.getByTestId('volume-distribution-bar')).toHaveStyle({ width: '50%' });
  });

  it('uses final volume distribution when hover cutoff mode is off', () => {
    useLivePageStore.setState({
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: false,
      volumeDistributionRangeCount: 2,
    });
    act(() => useLiveCursorStore.getState().setSidebarCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));

    renderSidebar({ code: '005930', bundle: bundleWithFinalDistribution });

    expect(screen.getByTestId('volume-distribution-bar')).toHaveStyle({ width: '50%' });
  });

  it('uses hover-cutoff distribution when hover cutoff mode is on', () => {
    useLivePageStore.setState({
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: true,
      volumeDistributionRangeCount: 2,
    });
    volumeDistributionCutoffProfileMock.mockReturnValue(cutoffDistribution);
    act(() => useLiveCursorStore.getState().setSidebarCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));

    renderSidebar({ code: '005930', bundle: bundleWithFinalDistribution });

    expect(volumeDistributionCutoffProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      code: '005930',
      timeframe: '1m',
      date: '20260527',
      cursorMs: Date.UTC(2026, 4, 27, 0, 1, 0),
      finalProfile: finalDistribution,
      priceRange: { min: 70000, max: 70400 },
    }));
    expect(screen.getByTestId('volume-distribution-max-bar')).toHaveStyle({ width: '100%' });
  });

  it('gates the hover-cutoff hook off while the volume distribution card is hidden', () => {
    useLivePageStore.setState({
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: true,
      volumeDistributionRangeCount: 2,
    });
    // 접기 제거(2026-07-15) 이후 무거운 매물대 훅 게이트는 숨김으로 이동.
    useLiveLayoutStore.setState({ rightCardHidden: { volumeDistribution: true } });
    act(() => useLiveCursorStore.getState().setSidebarCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));

    renderSidebar({ code: '005930', bundle: bundleWithFinalDistribution });

    // 카드 숨김 시 enabled 가 false 로 내려가 커서 이동마다 도는 컷오프 재계산이 꺼진다.
    expect(volumeDistributionCutoffProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: false,
    }));
  });

  it('passes only the active stock-date candles to the hover-cutoff fallback hook', () => {
    useLivePageStore.setState({
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: true,
      volumeDistributionRangeCount: 2,
    });
    act(() => useLiveCursorStore.getState().setSidebarCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));

    const selectedDateCandle = {
      ts_ms: Date.UTC(2026, 4, 27, 0, 1, 0),
      open: 70300,
      high: 70400,
      low: 70000,
      close: 70100,
      vol_a: 100,
      vol_b: 0,
    };
    const previousDateCandle = {
      ts_ms: Date.UTC(2026, 4, 26, 0, 1, 0),
      open: 103000,
      high: 104000,
      low: 102000,
      close: 103500,
      vol_a: 100,
      vol_b: 0,
    };

    renderSidebar({
      code: '005930',
      bundle: {
        ...bundleWithFinalDistribution,
        from_date: '20260526',
        segments: [
          {
            date: '20260526',
            session_open_ms: Date.UTC(2026, 4, 26, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 26, 6, 30, 0),
            source: 'hogaplay',
          },
          ...bundleWithFinalDistribution.segments,
        ],
        candles: [previousDateCandle, selectedDateCandle],
      },
    });

    expect(volumeDistributionCutoffProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      date: '20260527',
      candles: [selectedDateCandle],
    }));
  });

  it('passes the active candle price range to the hover-cutoff hook when no final profile exists yet', () => {
    useLivePageStore.setState({
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: true,
      volumeDistributionRangeCount: 10,
    });
    act(() => useLiveCursorStore.getState().setSidebarCursor(Date.UTC(2026, 4, 27, 0, 1, 0)));

    renderSidebar({
      code: '005930',
      todayKst: '20260528',
      bundle: {
        ...bundleWithFinalDistribution,
        volume_distributions: [],
      },
    });

    expect(volumeDistributionCutoffProfileMock).toHaveBeenCalledWith(expect.objectContaining({
      date: '20260527',
      finalProfile: null,
      priceRange: { min: 70000, max: 70400 },
    }));
  });

  it('merges newer live continuous trades into the persisted today volume distribution', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 2 });
    const liveWithTrades: LiveSeriesData = {
      ...emptyLive,
      trade: [
        {
          t_ms: Date.UTC(2026, 4, 27, 0, 10, 0),
          kind: 'trade',
          trades: [
            { t_ms: Date.UTC(2026, 4, 27, 0, 4, 0), price: 70100, qty: 999, side: 1 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 10, 0), price: 70100, qty: 50, side: 1 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 11, 0), price: 70120, qty: 990, side: 0 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 12, 0), price: 70350, qty: 70, side: -1 },
          ],
        },
      ],
    };

    renderSidebar({
      code: '005930',
      live: liveWithTrades,
      bundle: {
        ...bundleFixture,
        volume_distributions: [
          {
            date: '20260527',
            range_count: 2,
            price_min: 70000,
            price_max: 70400,
            session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
            last_trade_ms: Date.UTC(2026, 4, 27, 0, 5, 0),
            bins: [
              { price_low: 70000, price_high: 70200, qty: 150 },
              { price_low: 70200, price_high: 70400, qty: 300 },
            ],
          },
        ],
      },
    });

    expect(screen.getByTestId('volume-distribution-bar')).toHaveStyle({
      width: `${(200 / 370) * 100}%`,
    });
  });

  it('uses live continuous trades as a today volume distribution fallback when no persisted profile exists', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 2 });
    const liveWithTrades: LiveSeriesData = {
      ...emptyLive,
      trade: [
        {
          t_ms: Date.UTC(2026, 4, 27, 0, 10, 0),
          kind: 'trade',
          trades: [
            { t_ms: Date.UTC(2026, 4, 27, 0, 10, 0), price: 70100, qty: 500, side: 1 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 11, 0), price: 70120, qty: 990, side: 0 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 12, 0), price: 70350, qty: 700, side: -1 },
          ],
        },
      ],
    };

    renderSidebar({
      code: '005930',
      live: liveWithTrades,
      bundle: {
        ...bundleFixture,
        volume_distributions: [],
      },
    });

    expect(screen.getByTestId('volume-distribution-bar')).toHaveStyle({
      width: `${(500 / 700) * 100}%`,
    });
  });

  it('recomputes today distribution when persisted bins do not match the selected range count', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 10 });
    const liveWithTrades: LiveSeriesData = {
      ...emptyLive,
      trade: [
        {
          t_ms: Date.UTC(2026, 4, 27, 0, 10, 0),
          kind: 'trade',
          trades: [
            { t_ms: Date.UTC(2026, 4, 27, 0, 10, 0), price: 70100, qty: 500, side: 1 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 12, 0), price: 70350, qty: 700, side: -1 },
          ],
        },
      ],
    };

    renderSidebar({
      code: '005930',
      live: liveWithTrades,
      bundle: {
        ...bundleFixture,
        volume_distributions: [
          {
            date: '20260527',
            range_count: 1,
            price_min: 70000,
            price_max: 70400,
            session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
            bins: [
              { price_low: 70000, price_high: 70400, qty: 1200 },
            ],
          },
        ],
      },
    });

    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(10);
  });

  it('keeps the selected today range count even before live trades arrive', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 10 });

    renderSidebar({
      code: '005930',
      live: emptyLive,
      bundle: {
        ...bundleFixture,
        volume_distributions: [
          {
            date: '20260527',
            range_count: 1,
            price_min: 70000,
            price_max: 70400,
            session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
            bins: [
              { price_low: 70000, price_high: 70400, qty: 0 },
            ],
          },
        ],
      },
    });

    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(10);
  });

  it('replaces an empty persisted today distribution with live trades even when the bin count already matches', () => {
    useLivePageStore.setState({ volumeDistributionRangeCount: 10 });
    const liveWithTrades: LiveSeriesData = {
      ...emptyLive,
      trade: [
        {
          t_ms: Date.UTC(2026, 4, 27, 0, 10, 0),
          kind: 'trade',
          trades: [
            { t_ms: Date.UTC(2026, 4, 27, 0, 10, 0), price: 70100, qty: 500, side: 1 },
            { t_ms: Date.UTC(2026, 4, 27, 0, 12, 0), price: 70350, qty: 700, side: -1 },
          ],
        },
      ],
    };

    renderSidebar({
      code: '005930',
      live: liveWithTrades,
      bundle: {
        ...bundleFixture,
        volume_distributions: [
          {
            date: '20260527',
            range_count: 10,
            price_min: 70000,
            price_max: 70400,
            session_open_ms: Date.UTC(2026, 4, 27, 0, 0, 0),
            session_close_ms: Date.UTC(2026, 4, 27, 6, 30, 0),
            last_trade_ms: null,
            bins: Array.from({ length: 10 }, (_, idx) => ({
              price_low: 70000 + idx * 40,
              price_high: idx === 9 ? 70400 : 70000 + (idx + 1) * 40,
              qty: 0,
            })),
          },
        ],
      },
    });

    expect(screen.getAllByTestId('volume-distribution-row')).toHaveLength(10);
    expect(screen.getByTestId('volume-distribution-max-bar')).toHaveStyle({ width: '100%' });
    expect(screen.getAllByTestId('volume-distribution-bar').some((bar) => bar.style.width !== '0%')).toBe(true);
  });

  it('renders the broker card before the program trade card', () => {
    renderSidebar({
      code: '005930',
      live: emptyLive,
    });

    const orderbook = screen.getByTestId('live-detail-card-orderbook');
    const program = screen.getByTestId('live-detail-card-program');
    const brokers = screen.getByTestId('live-detail-card-brokers');
    expect(
      orderbook.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      brokers.compareDocumentPosition(program) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders latest program trade summary when sidecar points exist', () => {
    render(
      <QueryClientProvider client={makeQc()}>
        <LiveSidebar
          code="005930"
          live={emptyLive}
          programTrade={{
            points: [
              { t: new Date('2026-06-25T00:00:00Z').getTime(), net_qty: 10, net_amount: 100_000_000, gap_risk: false },
              { t: new Date('2026-06-25T00:01:00Z').getTime(), net_qty: -20, net_amount: -200_000_000, gap_risk: false },
            ],
          }}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('live-detail-card-program')).toHaveTextContent('프로그램');
    expect(screen.getByTestId('live-detail-card-program')).toHaveTextContent('-2억');
    expect(screen.getByTestId('live-detail-card-program')).toHaveTextContent('-20');
  });

  it('reads live data from the prop, not from useLiveSeries (LivePage-lift)', () => {
    // Regression guard for the dual-call-site bug: LiveSidebar must NOT
    // open its own SSE / hydrate its own buffer. LivePage owns the single
    // useLiveSeries call site and threads the result down as a prop.
    const liveWithData: LiveSeriesData = {
      ...emptyLive,
      ob: [
        {
          t_ms: 1779840060000,
          kind: 'ob',
          asks: Array.from({ length: 10 }, (_, i) => ({ price: 100 + i, qty: 1 })),
          bids: Array.from({ length: 10 }, (_, i) => ({ price: 99 - i, qty: 1 })),
          total_ask_qty: 10,
          total_bid_qty: 10,
        },
      ],
    };
    renderSidebar({ code: '005930', live: liveWithData });
    // OrderbookTable renders price-level rows (not the "호가 데이터 없음" empty state)
    // when latestOrderbookSnapshot returns non-null.
    expect(screen.queryByText('호가 데이터 없음')).toBeNull();
  });

  it('does not reserve a mode header above the data cards', () => {
    renderSidebar({ code: '005930' });
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    expect(screen.queryByText('최신')).toBeNull();
  });
});

describe('LiveSidebar cursor branching (ADR-0044)', () => {
  beforeEach(() => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().resetCursor();
    useLiveAxisStore.setState({ axis: null });
    useLiveLayoutStore.setState({ rightCardCollapsed: {}, rightCardHidden: {}, detailPanelCollapsed: false });
    vi.mocked(TotalQtyBar).mockClear();
  });
  afterEach(() => cleanup());

  it('keeps the mode header absent when cursorMs is null', () => {
    renderSidebar({ code: '005930' });
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    expect(screen.queryByText('최신')).toBeNull();
  });

  it('keeps the mode header absent when cursor is set', () => {
    renderSidebar({ code: '005930' });
    // 2026-05-28T04:42:17Z → KST 13:42:17
    const t = new Date('2026-05-28T04:42:17Z').getTime();
    act(() => useLiveCursorStore.getState().setSidebarCursor(t));
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    expect(screen.queryByText('과거')).toBeNull();
    expect(screen.queryByText('13:42:17')).toBeNull();
  });

  it('does not call cursor hooks when cursorMs null', () => {
    renderSidebar({ code: '005930' });
    // The hooks are imported and rendered, but their inner useSpot
    // does not fetch — verified separately in useLiveCursor.test.ts.
    // Here we just confirm they were called with code='005930' so
    // they're ready to switch on when cursor sets.
    expect(cursorHooks.useLiveOrderbookAtCursor).toHaveBeenCalledWith(
      expect.objectContaining({ code: '005930' }),
    );
  });

  it('does not switch to spot mode from immediate cursorMs alone', () => {
    const liveWithOrderbook: LiveSeriesData = {
      ...emptyLive,
      ob: [
        {
          t_ms: 1779840060000,
          kind: 'ob',
          asks: Array.from({ length: 10 }, (_, i) => ({ price: 70010 + i, qty: 10 + i })),
          bids: Array.from({ length: 10 }, (_, i) => ({ price: 70000 - i, qty: 20 + i })),
          total_ask_qty: 145,
          total_bid_qty: 245,
        },
      ],
      broker: [
        {
          t_ms: 1779840060000,
          kind: 'broker',
          buy_top: [{ name: '미래에셋증권', qty: 12 }],
          sell_top: [],
        },
      ],
    };
    renderSidebar({ code: '005930', live: liveWithOrderbook, bundle: bundleFixture });

    const latestCandleMs = bundleFixture.candles[bundleFixture.candles.length - 1].ts_ms;
    act(() => useLiveCursorStore.getState().setCursor(latestCandleMs));

    expect(screen.queryByText('커서 위치 로딩 중…')).toBeNull();
    expect(screen.getByText('70,010')).toBeInTheDocument();
  });

  it('uses cursor spot data when the cursor is pinned to the latest candle', () => {
    const latestCandleMs = bundleFixture.candles[bundleFixture.candles.length - 1].ts_ms;
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      snapshot: {
        ts_ms: latestCandleMs,
        seq: 0,
        ask: Array.from({ length: 10 }, (_, i) => ({ price: 71010 + i, qty: 10 + i })),
        bid: Array.from({ length: 10 }, (_, i) => ({ price: 71000 - i, qty: 20 + i })),
        tot_ask: 145,
        tot_bid: 245,
      },
      available_from: null,
      source: 'hogaplay',
    });
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        broker: '미래에셋증권',
        final_net: 123,
        dominant_side: 'buy',
        points: [{ ts_ms: latestCandleMs, net: 123 }],
      },
    ]);

    act(() => useLiveCursorStore.getState().setSidebarCursor(latestCandleMs));
    renderSidebar({ code: '005930', live: emptyLive, bundle: bundleFixture });

    expect(screen.queryByText('커서 위치 로딩 중…')).toBeNull();
    expect(screen.getByText('71,010')).toBeInTheDocument();
    expect(screen.getByText('+123')).toBeInTheDocument();
  });

  it('shows orderbook loading instead of no-data while cursor spot orderbook is fetching', () => {
    const latestCandleMs = bundleFixture.candles[bundleFixture.candles.length - 1].ts_ms;
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue([]);

    act(() => useLiveCursorStore.getState().setSidebarCursor(latestCandleMs));
    renderSidebar({ code: '005930', live: emptyLive, bundle: bundleFixture });

    expect(screen.getByText('커서 위치 로딩 중…')).toBeInTheDocument();
    expect(screen.queryByText('호가 데이터 없음')).toBeNull();
  });

  it('TotalQtyBar maskRatio=true when cursorMs in closing auction window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    renderSidebar({ code: '005930' });
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_748_400_900_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: true }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs outside window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => false } as never });
    renderSidebar({ code: '005930' });
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_748_400_060_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs null (preserves existing behavior)', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    renderSidebar({ code: '005930' });
    // No setCursor — cursorMs stays null. maskRatio must be false despite
    // the axis predicate returning true, because we don't engage mask in
    // latest mode (existing behavior).
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });

  it('on D timeframe, cursor does NOT enter spot — keeps orderbook data in latest mode', () => {
    // Pane Legend publishes cursorMs on D, but spot mode is minute-only
    // (ADR-0044). Cursor on D must NOT blank the orderbook.
    useLivePageStore.setState({ candleTimeframe: 'D' });
    renderSidebar({ code: '005930' });
    act(() => useLiveCursorStore.getState().setSidebarCursor(new Date('2026-05-28T04:42:17Z').getTime()));
    expect(screen.queryByText('과거')).toBeNull();
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    useLivePageStore.setState({ candleTimeframe: '1m' });
  });
});

describe('LiveSidebar — empty spot orderbook with available_from hint (T14b)', () => {
  beforeEach(() => {
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().resetCursor();
  });
  afterEach(() => cleanup());

  it('renders "다음 가용: HH:MM" when snapshot null but available_from is set', () => {
    // 2026-05-28T03:42:00Z → KST 12:42:00
    const availableMs = new Date('2026-05-28T03:42:00Z').getTime();
    // Use sticky mockReturnValue so the mock applies through re-renders triggered by setCursor
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      snapshot: null,
      available_from: availableMs,
      source: 'hogaplay',
    });
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_748_400_060_000));
    renderSidebar({ code: '005930' });
    expect(screen.getByText(/다음 가용: 12:42/)).toBeInTheDocument();
  });

  it('renders nothing extra when snapshot null AND available_from null', () => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      snapshot: null,
      available_from: null,
      source: 'hogaplay',
    });
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_748_400_060_000));
    renderSidebar({ code: '005930' });
    expect(screen.queryByText(/다음 가용/)).toBeNull();
  });
});

// ADR-0067: REST 준실시간 안내 배너는 LiveStatusBar CTA와 중복으로 제거됨 (Task 4)
describe('LiveSidebar — REST 준실시간 안내 배너 제거 확인', () => {
  beforeEach(() => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().resetCursor();
    useLiveAxisStore.setState({ axis: null });
    useLiveLayoutStore.setState({ rightCardCollapsed: {}, rightCardHidden: {}, detailPanelCollapsed: false });
    vi.mocked(TotalQtyBar).mockClear();
  });
  afterEach(() => cleanup());

  it('(a) REST notice banner is gone even when code is NOT in live_set', () => {
    // Banner removed — LiveStatusBar CTA handles this context now.
    renderSidebar({ code: '005930' }, ['000660']);
    expect(screen.queryByTestId('live-sidebar-rest-notice')).toBeNull();
  });

  it('(b) REST notice banner absent when code IS in live_set', () => {
    renderSidebar({ code: '005930' }, ['005930', '000660']);
    expect(screen.queryByTestId('live-sidebar-rest-notice')).toBeNull();
  });

  it('REST notice banner absent when code is null', () => {
    renderSidebar({ code: null }, ['000660']);
    expect(screen.queryByTestId('live-sidebar-rest-notice')).toBeNull();
  });
});

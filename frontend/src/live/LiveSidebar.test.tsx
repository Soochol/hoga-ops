import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePageStore } from '../state/livePage';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import type { LiveSeriesData } from '../api/liveSeries';
import type { RangeBundle } from '../api/types';

const investorTrendEstimateMock = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
);

vi.mock('../api/liveInvestorTrendEstimate', () => ({
  useLiveInvestorTrendEstimate: investorTrendEstimateMock,
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
  price_level_hits: [],
  trade_volume_pocs: [],
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
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLivePageStore.setState({ volumeDistributionEnabled: true, volumeDistributionRangeCount: 10 });
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.setState({ axis: null });
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

    const brokers = screen.getByTestId('card-brokers');
    const estimate = screen.getByTestId('investor-trend-estimate-card');
    expect(
      brokers.compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the volume distribution card between orderbook and brokers', () => {
    renderSidebar({ code: '005930' });

    const orderbook = screen.getByTestId('card-orderbook');
    const volumeDistribution = screen.getByTestId('card-volume-distribution');
    const brokers = screen.getByTestId('card-brokers');

    expect(
      orderbook.compareDocumentPosition(volumeDistribution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      volumeDistribution.compareDocumentPosition(brokers) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the persisted volume distribution for the active stock-date', () => {
    renderSidebar({
      code: '005930',
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

    expect(screen.getByText('70000-70200')).toBeInTheDocument();
    expect(screen.getByText('0.3k')).toBeInTheDocument();
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

    expect(screen.getByText('70000-70200')).toBeInTheDocument();
    expect(screen.getByText('0.3k')).toBeInTheDocument();
    expect(screen.queryByText('0.5k')).toBeNull();
    expect(screen.queryByText('0.7k')).toBeNull();
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

    expect(screen.getByText('0.2k')).toBeInTheDocument();
    expect(screen.getByText('0.4k')).toBeInTheDocument();
    expect(screen.queryByText('1k')).toBeNull();
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

    expect(screen.getByText('0.5k')).toBeInTheDocument();
    expect(screen.getByText('0.7k')).toBeInTheDocument();
    expect(screen.queryByText('1k')).toBeNull();
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
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.setState({ axis: null });
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
    act(() => useLiveCursorStore.getState().setCursor(t));
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

  it('TotalQtyBar maskRatio=true when cursorMs in closing auction window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    renderSidebar({ code: '005930' });
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_900_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: true }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs outside window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => false } as never });
    renderSidebar({ code: '005930' });
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
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
    act(() => useLiveCursorStore.getState().setCursor(new Date('2026-05-28T04:42:17Z').getTime()));
    expect(screen.queryByText('과거')).toBeNull();
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    useLivePageStore.setState({ candleTimeframe: '1m' });
  });
});

describe('LiveSidebar — empty spot orderbook with available_from hint (T14b)', () => {
  beforeEach(() => {
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().clearCursor();
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
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    renderSidebar({ code: '005930' });
    expect(screen.getByText(/다음 가용: 12:42/)).toBeInTheDocument();
  });

  it('renders nothing extra when snapshot null AND available_from null', () => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      snapshot: null,
      available_from: null,
      source: 'hogaplay',
    });
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    renderSidebar({ code: '005930' });
    expect(screen.queryByText(/다음 가용/)).toBeNull();
  });
});

// ADR-0067: REST 준실시간 안내 배너는 LiveStatusBar CTA와 중복으로 제거됨 (Task 4)
describe('LiveSidebar — REST 준실시간 안내 배너 제거 확인', () => {
  beforeEach(() => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.setState({ axis: null });
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

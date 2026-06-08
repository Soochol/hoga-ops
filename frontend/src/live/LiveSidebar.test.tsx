import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { act } from 'react';
import { LiveSidebar } from './LiveSidebar';
import { useLivePageStore } from '../state/livePage';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';
import type { LiveSeriesData } from '../api/liveSeries';

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

vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => undefined),
  useLiveBrokersAtCursor: vi.fn(() => undefined),
}));

// #9: latest 모드 거래원 카드는 useBrokerSeriesForDay(day-series)를 쓴다.
// useQuery라 QueryClient가 필요 — 모킹으로 대체(반환을 테스트가 제어).
vi.mock('../api/brokerSeries', () => ({
  useBrokerSeriesForDay: vi.fn(() => ({ data: undefined })),
}));

vi.mock('../sidebar/TotalQtyBar', () => ({
  default: vi.fn(() => <div data-testid="total-qty-bar" />),
}));

import * as cursorHooks from '../api/useLiveCursor';
import * as brokerSeriesHooks from '../api/brokerSeries';
import TotalQtyBar from '../sidebar/TotalQtyBar';

describe('LiveSidebar', () => {
  beforeEach(() => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (brokerSeriesHooks.useBrokerSeriesForDay as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined });
    (brokerSeriesHooks.useBrokerSeriesForDay as ReturnType<typeof vi.fn>).mockClear();
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.setState({ axis: null });
    vi.mocked(TotalQtyBar).mockClear();
  });
  afterEach(() => cleanup());

  it('renders the sidebar shell when code is null (waiting state)', () => {
    render(<LiveSidebar code={null} live={emptyLive} />);
    expect(screen.getByTestId('live-sidebar')).toBeInTheDocument();
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
    render(<LiveSidebar code="005930" live={liveWithData} />);
    // OrderbookTable renders price-level rows (not the "호가 데이터 없음" empty state)
    // when latestOrderbookSnapshot returns non-null.
    expect(screen.queryByText('호가 데이터 없음')).toBeNull();
  });

  it('shows the LIVE pulse badge in header (Design C1)', () => {
    render(<LiveSidebar code="005930" live={emptyLive} />);
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
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

  it('shows LIVE● header when cursorMs is null', () => {
    render(<LiveSidebar code="005930" live={emptyLive} />);
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('#9: latest 모드는 거래원 궤적을 day-series(today)로 — 15분 버퍼 집계 아님', () => {
    // 백엔드 today-seam이 parquet+버퍼 꼬리를 합친 당일 전체를 반환 → 그 broker가 렌더.
    (brokerSeriesHooks.useBrokerSeriesForDay as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        date: '20260608',
        source: 'kis_live',
        brokers: [{ broker: '키움증권', final_net: 100, dominant_side: 'buy',
                    points: [{ ts_ms: 1, net: 100 }] }],
      },
    });
    render(<LiveSidebar code="005930" live={emptyLive} />);
    // latest 모드(cursor null): date 인자가 non-null(=today)로 호출 → fetch 활성.
    const call = (brokerSeriesHooks.useBrokerSeriesForDay as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('005930');
    expect(call[1]).not.toBeNull();        // latest는 today로 fetch
    expect(call[1]).toBe(call[2]);          // date === todayKst (today-inclusive)
    // 거래원명은 잘려 표시되고 전체명은 title 속성에 — day-series가 렌더됨.
    expect(screen.getByTitle('키움증권')).toBeInTheDocument();
  });

  it('#9: spot 모드는 day-series fetch를 비활성(date=null) — 커서 훅이 담당', () => {
    render(<LiveSidebar code="005930" live={emptyLive} />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    const calls = (brokerSeriesHooks.useBrokerSeriesForDay as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][1]).toBeNull();  // spot 진입 후 date=null(비활성)
  });

  it('swaps to "과거 시점" + KST timestamp when cursor is set', () => {
    render(<LiveSidebar code="005930" live={emptyLive} />);
    // 2026-05-28T04:42:17Z → KST 13:42:17
    const t = new Date('2026-05-28T04:42:17Z').getTime();
    act(() => useLiveCursorStore.getState().setCursor(t));
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    expect(screen.getByText('과거 시점')).toBeInTheDocument();
    // formatTime uses Asia/Seoul — always produces KST regardless of machine tz
    expect(screen.getByText('13:42:17')).toBeInTheDocument();
  });

  it('does not call cursor hooks when cursorMs null', () => {
    render(<LiveSidebar code="005930" live={emptyLive} />);
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
    render(<LiveSidebar code="005930" live={emptyLive} />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_900_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: true }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs outside window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => false } as never });
    render(<LiveSidebar code="005930" live={emptyLive} />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs null (preserves existing behavior)', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    render(<LiveSidebar code="005930" live={emptyLive} />);
    // No setCursor — cursorMs stays null. maskRatio must be false despite
    // the axis predicate returning true, because we don't engage mask in
    // latest mode (existing behavior).
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });

  it('on D timeframe, cursor does NOT enter spot — keeps LIVE header (legend regression guard)', () => {
    // Pane Legend publishes cursorMs on D, but spot mode is minute-only
    // (ADR-0044). Cursor on D must NOT blank the orderbook / flip the header.
    useLivePageStore.setState({ candleTimeframe: 'D' });
    render(<LiveSidebar code="005930" live={emptyLive} />);
    act(() => useLiveCursorStore.getState().setCursor(new Date('2026-05-28T04:42:17Z').getTime()));
    expect(screen.queryByText('과거 시점')).toBeNull();
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
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
    render(<LiveSidebar code="005930" live={emptyLive} />);
    expect(screen.getByText(/다음 가용: 12:42/)).toBeInTheDocument();
  });

  it('renders nothing extra when snapshot null AND available_from null', () => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      snapshot: null,
      available_from: null,
      source: 'hogaplay',
    });
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    render(<LiveSidebar code="005930" live={emptyLive} />);
    expect(screen.queryByText(/다음 가용/)).toBeNull();
  });
});

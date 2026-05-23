import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CursorSidebar from '../../src/sidebar/CursorSidebar';
import { createVirtualAxis } from '../../src/util/virtualAxis';
import { useTabsStore } from '../../src/state/tabs';
import { useCursor, useOrderbookAtCursor } from '../../src/api/useCursor';
import type { OrderbookSnapshot } from '../../src/api/types';

vi.mock('../../src/api/useCursor', () => ({
  useCursor: vi.fn(() => ({ tabId: '', code: null, date: null, cursorMs: null })),
  useOrderbookAtCursor: vi.fn(() => undefined),
  useBrokersAtCursor: vi.fn(() => undefined),
  useTradesAroundCursor: vi.fn(() => undefined),
}));

describe('CursorSidebar', () => {
  it('renders three labeled cards', () => {
    render(<CursorSidebar />);
    expect(screen.getByText('10호가')).toBeInTheDocument();
    expect(screen.getByText('거래원')).toBeInTheDocument();
    expect(screen.getByText('체결')).toBeInTheDocument();
  });

  it('renders injected children into the right cards', () => {
    render(
      <CursorSidebar
        orderbook={<span>OB-CONTENT</span>}
        brokers={<span>BR-CONTENT</span>}
        fills={<span>FT-CONTENT</span>}
      />,
    );
    expect(screen.getByText('OB-CONTENT')).toBeInTheDocument();
    expect(screen.getByText('BR-CONTENT')).toBeInTheDocument();
    expect(screen.getByText('FT-CONTENT')).toBeInTheDocument();
  });

  it('CursorSidebarConnected renders without a Volume Profile mode toggle', async () => {
    const { CursorSidebarConnected } = await import('../../src/sidebar/CursorSidebar');
    const axis = createVirtualAxis([]);
    render(<CursorSidebarConnected axis={axis} />);
    expect(screen.queryByTestId('volume-profile-mode-toggle')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: CursorSidebarConnected — auction mask wiring
// Verifies the end-to-end path:
//   auctionWindowMask pref + cursorMs + axis.inClosingAuctionWindow
//   → useAuctionMaskActive → TotalQtyBar masked branch
// ---------------------------------------------------------------------------

function snap(totAsk: number, totBid: number): OrderbookSnapshot {
  return {
    ts_ms: 0,
    seq: 0,
    ask: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })),
    bid: Array.from({ length: 10 }, () => ({ price: 0, qty: 0 })),
    tot_ask: totAsk,
    tot_bid: totBid,
  };
}

describe('CursorSidebarConnected — auction mask wiring', () => {
  // KST 09:00 on 2026-05-18 in Unix ms (UTC midnight + 9h = UTC 00:00 - 9h offset)
  const sessionOpenMs = 1_779_062_400_000; // 2026-05-18 09:00 KST
  const sessionCloseMs = sessionOpenMs + 23_400_000; // 6h 30m later = 15:30 KST
  const auctionWindowStartMs = sessionOpenMs + 22_800_000; // 6h 20m = 15:20 KST

  const axis = createVirtualAxis([
    { date: '20260518', sessionOpenMs, sessionCloseMs },
  ]);

  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
    // Default mocks: cursor null, no snapshot — safe baseline for non-wiring tests
    vi.mocked(useCursor).mockReturnValue({ tabId: '', code: null, date: null, cursorMs: null });
    vi.mocked(useOrderbookAtCursor).mockReturnValue(undefined);
  });

  it('mask active: shows total-qty-bar-masked and hides fill when cursor is inside auction window', async () => {
    const { CursorSidebarConnected } = await import('../../src/sidebar/CursorSidebar');
    const tabId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().setToggle(tabId, 'auctionWindowMask', true);

    const cursorMs = auctionWindowStartMs + 60_000; // 15:21 KST — inside window
    vi.mocked(useCursor).mockReturnValue({ tabId, code: '005930', date: '20260518', cursorMs });
    vi.mocked(useOrderbookAtCursor).mockReturnValue(snap(12_840, 18_220));

    const { queryByTestId, getByText } = render(<CursorSidebarConnected axis={axis} />);

    expect(queryByTestId('total-qty-bar-masked')).not.toBeNull();
    expect(queryByTestId('total-qty-bar-fill')).toBeNull();
    // Flank numbers remain visible even in masked state
    expect(getByText('12,840')).toBeInTheDocument();
    expect(getByText('18,220')).toBeInTheDocument();
  });

  it('cursor outside window: shows fill and hides masked even when auctionWindowMask=true', async () => {
    const { CursorSidebarConnected } = await import('../../src/sidebar/CursorSidebar');
    const tabId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().setToggle(tabId, 'auctionWindowMask', true);

    const cursorMs = sessionOpenMs + 60_000; // 09:01 KST — well before 15:20
    vi.mocked(useCursor).mockReturnValue({ tabId, code: '005930', date: '20260518', cursorMs });
    vi.mocked(useOrderbookAtCursor).mockReturnValue(snap(12_840, 18_220));

    const { queryByTestId } = render(<CursorSidebarConnected axis={axis} />);

    expect(queryByTestId('total-qty-bar-masked')).toBeNull();
    expect(queryByTestId('total-qty-bar-fill')).not.toBeNull();
  });

  it('toggle off: shows fill even when cursor is inside auction window', async () => {
    const { CursorSidebarConnected } = await import('../../src/sidebar/CursorSidebar');
    const tabId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().setToggle(tabId, 'auctionWindowMask', false);

    const cursorMs = auctionWindowStartMs + 60_000; // 15:21 KST — inside window, but mask off
    vi.mocked(useCursor).mockReturnValue({ tabId, code: '005930', date: '20260518', cursorMs });
    vi.mocked(useOrderbookAtCursor).mockReturnValue(snap(12_840, 18_220));

    const { queryByTestId } = render(<CursorSidebarConnected axis={axis} />);

    expect(queryByTestId('total-qty-bar-masked')).toBeNull();
    expect(queryByTestId('total-qty-bar-fill')).not.toBeNull();
  });
});

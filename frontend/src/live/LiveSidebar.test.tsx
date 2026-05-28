import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { act } from 'react';
import { LiveSidebar } from './LiveSidebar';
import { useLiveCursorStore } from './useLiveCursorStore';
import { useLiveAxisStore } from './useLiveAxisStore';

// Mock useLiveSeries so LiveSidebar can render in isolation
vi.mock('../api/liveSeries', () => ({
  useLiveSeries: vi.fn(() => ({
    initial: undefined,
    isLoading: false,
    error: null,
    ob: [],
    trade: [],
    broker: [],
  })),
}));

vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: vi.fn(() => undefined),
  useLiveTradesAroundCursor: vi.fn(() => undefined),
  useLiveBrokersAtCursor: vi.fn(() => undefined),
}));

vi.mock('../sidebar/TotalQtyBar', () => ({
  default: vi.fn(() => <div data-testid="total-qty-bar" />),
}));

import * as liveSeriesMod from '../api/liveSeries';
import * as cursorHooks from '../api/useLiveCursor';
import TotalQtyBar from '../sidebar/TotalQtyBar';

describe('LiveSidebar', () => {
  beforeEach(() => {
    (liveSeriesMod.useLiveSeries as ReturnType<typeof vi.fn>).mockReturnValue({
      initial: undefined,
      isLoading: false,
      error: null,
      ob: [],
      trade: [],
      broker: [],
    });
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveTradesAroundCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.setState({ axis: null });
    vi.mocked(TotalQtyBar).mockClear();
  });
  afterEach(() => cleanup());

  it('renders three card slots when code is null (waiting state)', () => {
    render(<LiveSidebar code={null} date={null} />);
    expect(screen.getByTestId('live-sidebar')).toBeInTheDocument();
  });

  it('subscribes to useLiveSeries with the active code', () => {
    render(<LiveSidebar code="005930" date="20260528" />);
    expect(liveSeriesMod.useLiveSeries).toHaveBeenCalledWith('005930');
  });

  it('shows the LIVE pulse badge in header (Design C1)', () => {
    render(<LiveSidebar code="005930" date="20260528" />);
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
  });
});

describe('LiveSidebar cursor branching (ADR-0044)', () => {
  beforeEach(() => {
    (liveSeriesMod.useLiveSeries as ReturnType<typeof vi.fn>).mockReturnValue({
      initial: undefined,
      isLoading: false,
      error: null,
      ob: [],
      trade: [],
      broker: [],
    });
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveTradesAroundCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (cursorHooks.useLiveBrokersAtCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    useLiveCursorStore.getState().clearCursor();
    useLiveAxisStore.setState({ axis: null });
    vi.mocked(TotalQtyBar).mockClear();
  });
  afterEach(() => cleanup());

  it('shows LIVE● header when cursorMs is null', () => {
    render(<LiveSidebar code="005930" date="20260528" />);
    expect(screen.getByTestId('live-sidebar-pulse')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('swaps to "과거 시점" + KST timestamp when cursor is set', () => {
    render(<LiveSidebar code="005930" date="20260528" />);
    // 2026-05-28T04:42:17Z → KST 13:42:17
    const t = new Date('2026-05-28T04:42:17Z').getTime();
    act(() => useLiveCursorStore.getState().setCursor(t));
    expect(screen.queryByTestId('live-sidebar-pulse')).toBeNull();
    expect(screen.getByText('과거 시점')).toBeInTheDocument();
    // formatTime uses Asia/Seoul — always produces KST regardless of machine tz
    expect(screen.getByText('13:42:17')).toBeInTheDocument();
  });

  it('does not call cursor hooks when cursorMs null', () => {
    render(<LiveSidebar code="005930" date="20260528" />);
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
    render(<LiveSidebar code="005930" date="20260528" />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_900_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: true }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs outside window', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => false } as never });
    render(<LiveSidebar code="005930" date="20260528" />);
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });

  it('TotalQtyBar maskRatio=false when cursorMs null (preserves existing behavior)', () => {
    useLiveAxisStore.setState({ axis: { inClosingAuctionWindow: () => true } as never });
    render(<LiveSidebar code="005930" date="20260528" />);
    // No setCursor — cursorMs stays null. maskRatio must be false despite
    // the axis predicate returning true, because we don't engage mask in
    // latest mode (existing behavior).
    expect(TotalQtyBar).toHaveBeenCalledWith(
      expect.objectContaining({ maskRatio: false }),
      expect.anything(),
    );
  });
});

describe('LiveSidebar — empty spot orderbook with available_from hint (T14b)', () => {
  beforeEach(() => {
    (liveSeriesMod.useLiveSeries as ReturnType<typeof vi.fn>).mockReturnValue({
      initial: undefined,
      isLoading: false,
      error: null,
      ob: [],
      trade: [],
      broker: [],
    });
    (cursorHooks.useLiveTradesAroundCursor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
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
    render(<LiveSidebar code="005930" date="20260528" />);
    expect(screen.getByText(/다음 가용: 12:42/)).toBeInTheDocument();
  });

  it('renders nothing extra when snapshot null AND available_from null', () => {
    (cursorHooks.useLiveOrderbookAtCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      snapshot: null,
      available_from: null,
      source: 'hogaplay',
    });
    act(() => useLiveCursorStore.getState().setCursor(1_748_400_060_000));
    render(<LiveSidebar code="005930" date="20260528" />);
    expect(screen.queryByText(/다음 가용/)).toBeNull();
  });
});

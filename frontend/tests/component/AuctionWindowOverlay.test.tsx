import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AuctionWindowOverlay from '../../src/chart/AuctionWindowOverlay';
import { createVirtualAxis } from '../../src/util/virtualAxis';
import { useTabsStore } from '../../src/state/tabs';

// KST 09:00 — 15:30. Full-day session length = 6h30m.
const DAY1_OPEN = 1_779_062_400_000;
const FULL_SESSION_MS = 6.5 * 60 * 60 * 1000;
const DAY1_CLOSE = DAY1_OPEN + FULL_SESSION_MS;

const makeMockChart = () => ({
  timeScale: () => ({
    timeToCoordinate: (t: number) => t * 0.001, // 1ms per pixel (deterministic)
    subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn(),
  }),
}) as any;

const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_CLOSE },
]);

// Component now reads prefs via useActivePrefs from the active tab in
// useTabsStore — drive the toggle on the store directly instead of
// wrapping with a context provider.
function setAuctionMask(enabled: boolean): void {
  const id = useTabsStore.getState().activeTabId;
  useTabsStore.getState().setToggle(id, 'auctionWindowMask', enabled);
}

describe('AuctionWindowOverlay', () => {
  beforeEach(() => {
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('renders one shaded band per segment when auctionWindowMask is on', () => {
    setAuctionMask(true);
    const { container } = render(
      <AuctionWindowOverlay chart={makeMockChart()} axis={axis} />,
    );
    expect(container.querySelectorAll('[data-auction-band]')).toHaveLength(1);
    expect(container.querySelector('[data-auction-band="20260518"]')).not.toBeNull();
  });

  it('renders nothing when auctionWindowMask is off', () => {
    setAuctionMask(false);
    const { container } = render(
      <AuctionWindowOverlay chart={makeMockChart()} axis={axis} />,
    );
    expect(container.querySelector('[data-auction-band]')).toBeNull();
  });

  it('renders nothing on an empty axis', () => {
    setAuctionMask(true);
    const empty = createVirtualAxis([]);
    const { container } = render(
      <AuctionWindowOverlay chart={makeMockChart()} axis={empty} />,
    );
    expect(container.querySelector('[data-auction-band]')).toBeNull();
  });
});

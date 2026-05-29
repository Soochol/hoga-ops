import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AuctionWindowOverlay from '../../src/chart/AuctionWindowOverlay';
import { createVirtualAxis } from '../../src/util/virtualAxis';
import { useChartPrefsStore, DEFAULT_PREFS } from '../../src/state/chartPrefs';

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

// Component reads prefs via useActivePrefs, which is a thin wrapper over
// useChartPrefsStore (the per-tab prefs map was removed when /replay
// shipped). Drive the toggle on the global store directly.
function setAuctionMask(enabled: boolean): void {
  useChartPrefsStore.getState().setToggle('auctionWindowMask', enabled);
}

describe('AuctionWindowOverlay', () => {
  beforeEach(() => {
    useChartPrefsStore.setState({ ...DEFAULT_PREFS });
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

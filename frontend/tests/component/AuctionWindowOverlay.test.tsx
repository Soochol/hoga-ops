import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AuctionWindowOverlay from '../../src/chart/AuctionWindowOverlay';
import { createVirtualAxis } from '../../src/util/virtualAxis';
import { ChartPrefsContext } from '../../src/chart/ChartPrefsContext';
import { DEFAULT_PREFS } from '../../src/state/tabs';

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

const enabledPrefs = { ...DEFAULT_PREFS, auctionWindowMask: true };
const disabledPrefs = { ...DEFAULT_PREFS, auctionWindowMask: false };

describe('AuctionWindowOverlay', () => {
  it('renders one shaded band per segment when auctionWindowMask is on', () => {
    const { container } = render(
      <ChartPrefsContext.Provider value={enabledPrefs}>
        <AuctionWindowOverlay chart={makeMockChart()} axis={axis} />
      </ChartPrefsContext.Provider>,
    );
    expect(container.querySelectorAll('[data-auction-band]')).toHaveLength(1);
    expect(container.querySelector('[data-auction-band="20260518"]')).not.toBeNull();
  });

  it('renders nothing when auctionWindowMask is off', () => {
    const { container } = render(
      <ChartPrefsContext.Provider value={disabledPrefs}>
        <AuctionWindowOverlay chart={makeMockChart()} axis={axis} />
      </ChartPrefsContext.Provider>,
    );
    expect(container.querySelector('[data-auction-band]')).toBeNull();
  });

  it('renders nothing on an empty axis', () => {
    const empty = createVirtualAxis([]);
    const { container } = render(
      <ChartPrefsContext.Provider value={enabledPrefs}>
        <AuctionWindowOverlay chart={makeMockChart()} axis={empty} />
      </ChartPrefsContext.Provider>,
    );
    expect(container.querySelector('[data-auction-band]')).toBeNull();
  });
});

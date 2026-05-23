import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RatioPane from '../../src/chart/RatioPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';
import { useTabsStore } from '../../src/state/tabs';

const makeMockChart = () => {
  const series = { setData: vi.fn(), createPriceLine: vi.fn() };
  return {
    chart: { addSeries: vi.fn().mockReturnValue(series), removeSeries: vi.fn() } as any,
    series,
  };
};

describe('RatioPane', () => {
  beforeEach(() => {
    // Reset to a clean single-tab state with empty prefs so each case starts
    // from the default auctionWindowMask=true and doesn't inherit prior state.
    useTabsStore.getState().reset();
    useTabsStore.setState((s) => ({ ...s, prefs: new Map() }));
  });

  it('maps bundle.quote_ratio.points to imbalance values', () => {
    const { chart, series } = makeMockChart();
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: 1779062400000, bid_total: 100, ask_total: 100 }, // balance → 0
          { t: 1779062401000, bid_total: 100, ask_total: 200 }, // sell heavy → +1.0
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs: 1779062400000,
            sessionCloseMs: 1779062400000 + 23400000,
          },
        ])}
      />,
    );
    const passed = series.setData.mock.calls[0][0];
    expect(passed[0].value).toBe(0);
    expect(passed[1].value).toBeCloseTo(1.0, 5);
    // createPriceLine called for the 0-baseline
    expect(series.createPriceLine).toHaveBeenCalled();
  });

  it('drops pre-open auction quote_ratio points', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 100, ask_total: 100 }, // pre-open: drop
          { t: sessionOpenMs,              bid_total: 100, ask_total: 200 }, // keep
          { t: sessionOpenMs + 1000,       bid_total: 150, ask_total: 100 }, // keep
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          {
            date: '20260511',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
          },
        ])}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[1].time).toBe(1);
  });

  it('zeros auction-window ratio values when auctionWindowMask is true (default)', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const auctionStart = sessionOpenMs + (6 * 3600 + 20 * 60) * 1000; // 15:20
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs + 60_000, bid_total: 100, ask_total: 200 }, // 09:01 → +1.0
          { t: auctionStart,           bid_total: 50,  ask_total: 500 }, // 15:20:00 → masked
          { t: auctionStart + 60_000,  bid_total: 100, ask_total: 100 }, // 15:21    → masked
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(3);
    expect(data[0].value).toBeCloseTo(1.0, 5); // normal-band
    expect(data[1].value).toBe(0);             // auction-band → masked
    expect(data[2].value).toBe(0);             // auction-band → masked
  });

  it('passes raw imbalance when auctionWindowMask is false', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const auctionStart = sessionOpenMs + (6 * 3600 + 20 * 60) * 1000;
    // Flip the per-tab flag BEFORE rendering so the component picks it up.
    const activeId = useTabsStore.getState().activeTabId;
    useTabsStore.getState().setToggle(activeId, 'auctionWindowMask', false);

    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: auctionStart,          bid_total: 50,  ask_total: 500 }, // raw: +9
          { t: auctionStart + 60_000, bid_total: 100, ask_total: 100 }, // raw: 0
        ],
      },
    };
    render(
      <RatioPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data[0].value).toBeCloseTo(9, 5);    // 500/50 - 1
    expect(data[1].value).toBe(0);              // raw balance
  });
});

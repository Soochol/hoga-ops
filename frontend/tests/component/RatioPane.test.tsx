import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import RatioPane from '../../src/chart/RatioPane';

const makeMockChart = () => {
  const series = { setData: vi.fn(), createPriceLine: vi.fn() };
  return {
    chart: { addSeries: vi.fn().mockReturnValue(series), removeSeries: vi.fn() } as any,
    series,
  };
};

describe('RatioPane', () => {
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
        segments={[
          {
            date: '20260518',
            sessionOpenMs: 1779062400000,
            sessionCloseMs: 1779062400000 + 23400000,
            virtualStart: 0,
          },
        ]}
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
        segments={[
          {
            date: '20260511',
            sessionOpenMs,
            sessionCloseMs: sessionOpenMs + 23_400_000,
            virtualStart: 0,
          },
        ]}
      />,
    );
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[1].time).toBe(1);
  });
});

import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CandlePane from '../../src/chart/CandlePane';

const makeMockChart = () => {
  const series = { setData: vi.fn(), applyOptions: vi.fn() };
  const addSeries = vi.fn().mockReturnValue(series);
  const removeSeries = vi.fn();
  return { chart: { addSeries, removeSeries } as any, series };
};

describe('CandlePane', () => {
  it('mounts CandlestickSeries on chart with bundle data', () => {
    const { chart, series } = makeMockChart();
    const bundle: any = {
      session_open_ms: 1779062400000,
      candles: [
        {
          ts_ms: 1779062400000,
          open: 70000,
          close: 70100,
          high: 70200,
          low: 69900,
          vol_a: 100,
          vol_b: 0,
        },
      ],
    };
    render(
      <CandlePane
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
    expect(chart.addSeries).toHaveBeenCalled();
    expect(series.setData).toHaveBeenCalled();
    const passed = series.setData.mock.calls[0][0];
    expect(passed[0]).toMatchObject({ open: 70000, close: 70100, high: 70200, low: 69900 });
  });

  it('uses muted color for candles after auction threshold', () => {
    const { chart, series } = makeMockChart();
    const open = 1779062400000;
    const bundle: any = {
      session_open_ms: open,
      candles: [
        {
          ts_ms: open,
          open: 70000,
          close: 70100,
          high: 70200,
          low: 69900,
          vol_a: 100,
          vol_b: 0,
        },
        // 6h 25m after open — past auction threshold (6h 20m).
        {
          ts_ms: open + (6 * 3600 + 25 * 60) * 1000,
          open: 70100,
          close: 70050,
          high: 70150,
          low: 70000,
          vol_a: 50,
          vol_b: 0,
        },
      ],
    };
    render(
      <CandlePane
        chart={chart}
        bundle={bundle}
        segments={[
          {
            date: '20260518',
            sessionOpenMs: open,
            sessionCloseMs: open + 23400000,
            virtualStart: 0,
          },
        ]}
      />,
    );
    const passed = series.setData.mock.calls[0][0];
    expect(passed[0].color).not.toEqual(passed[1].color); // regular ≠ muted
  });
});

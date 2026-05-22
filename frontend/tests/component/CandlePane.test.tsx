import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CandlePane from '../../src/chart/CandlePane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

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
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs: 1779062400000,
            sessionCloseMs: 1779062400000 + 23400000,
          },
        ])}
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
        axis={createVirtualAxis([
          {
            date: '20260518',
            sessionOpenMs: open,
            sessionCloseMs: open + 23400000,
          },
        ])}
      />,
    );
    const passed = series.setData.mock.calls[0][0];
    expect(passed[0].color).not.toEqual(passed[1].color); // regular ≠ muted
  });

  it('drops pre-open auction candles that fall outside any segment', () => {
    const { chart, series } = makeMockChart();
    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      candles: [
        // pre-open auction (8:30 KST, 30 min before sessionOpen) — must be dropped
        { ts_ms: sessionOpenMs - 30 * 60_000, open: 27050, close: 27050, high: 27050, low: 27050, vol_a: 111, vol_b: 0 },
        // session-open candle — kept
        { ts_ms: sessionOpenMs, open: 27050, close: 27100, high: 27100, low: 27050, vol_a: 200, vol_b: 50 },
        // mid-session candle — kept
        { ts_ms: sessionOpenMs + 60_000, open: 27100, close: 27090, high: 27110, low: 27080, vol_a: 50, vol_b: 80 },
      ],
    };
    render(
      <CandlePane
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
    expect(series.setData).toHaveBeenCalledTimes(1);
    const data = series.setData.mock.calls[0][0];
    expect(data).toHaveLength(2); // pre-open dropped
    // Times must be strictly ascending and non-zero-duplicate
    expect(data[0].time).toBe(0);                    // session-open at virtualStart=0
    expect(data[1].time).toBe(60);                   // +60s in virtual axis (seconds)
    expect(data[0].time).toBeLessThan(data[1].time); // ASC ordered
  });
});

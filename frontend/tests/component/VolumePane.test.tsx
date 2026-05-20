import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import VolumePane from '../../src/chart/VolumePane';

const makeMockChart = () => {
  const series = { setData: vi.fn() };
  return {
    chart: { addSeries: vi.fn().mockReturnValue(series), removeSeries: vi.fn() } as any,
    series,
  };
};

describe('VolumePane', () => {
  it('sets HistogramSeries data; up candle → up color, down candle → down color', () => {
    const { chart, series } = makeMockChart();
    const bundle: any = {
      session_open_ms: 1779062400000,
      candles: [
        { ts_ms: 100, open: 70000, close: 70100, high: 70200, low: 69900, vol_a: 50, vol_b: 50 },
        { ts_ms: 200, open: 70100, close: 69900, high: 70150, low: 69900, vol_a: 80, vol_b: 20 },
      ],
    };
    render(
      <VolumePane
        chart={chart}
        bundle={bundle}
        segments={[
          { date: '20260518', sessionOpenMs: 0, sessionCloseMs: 1000, virtualStart: 0 },
        ]}
      />,
    );
    const passed = series.setData.mock.calls[0][0];
    expect(passed).toHaveLength(2);
    expect(passed[0].value).toBe(100);
    expect(passed[1].value).toBe(100);
    expect(passed[0].color).not.toEqual(passed[1].color); // up ≠ down
  });
});

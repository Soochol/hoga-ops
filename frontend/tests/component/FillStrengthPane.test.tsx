import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import FillStrengthPane from '../../src/chart/FillStrengthPane';

const makeMockChart = () => {
  const series1 = { setData: vi.fn() };
  const series2 = { setData: vi.fn() };
  let call = 0;
  const addSeries = vi.fn(() => (call++ === 0 ? series1 : series2));
  return { chart: { addSeries, removeSeries: vi.fn() } as any, series1, series2 };
};

describe('FillStrengthPane', () => {
  it('adds two series; sell values are negated', () => {
    const { chart, series1, series2 } = makeMockChart();
    const bundle: any = {
      fill_strength: {
        bucket_ms: 60000,
        points: [
          { t: 1779062400000, buy_qty: 500, sell_qty: 200 },
          { t: 1779062460000, buy_qty: 300, sell_qty: 700 },
        ],
      },
    };
    render(
      <FillStrengthPane
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
    expect(chart.addSeries).toHaveBeenCalledTimes(2);
    const buyData = series1.setData.mock.calls[0][0];
    const sellData = series2.setData.mock.calls[0][0];
    expect(buyData[0].value).toBe(500);
    expect(buyData[1].value).toBe(300);
    expect(sellData[0].value).toBe(-200);
    expect(sellData[1].value).toBe(-700);
  });
});

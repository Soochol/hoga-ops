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

  it('drops pre-open auction points from both buy and sell series', () => {
    // Two addSeries calls (buy, sell) — capture both series mocks.
    const buySeries = { setData: vi.fn(), applyOptions: vi.fn() };
    const sellSeries = { setData: vi.fn(), applyOptions: vi.fn() };
    const addSeries = vi.fn().mockReturnValueOnce(buySeries).mockReturnValueOnce(sellSeries);
    const chart: any = { addSeries, removeSeries: vi.fn() };

    const sessionOpenMs = 1_778_457_600_000;
    const bundle: any = {
      session_open_ms: sessionOpenMs,
      fill_strength: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs - 30 * 60_000, buy_qty: 10, sell_qty: 5 }, // pre-open: drop
          { t: sessionOpenMs,              buy_qty: 20, sell_qty: 8 }, // keep
          { t: sessionOpenMs + 1000,       buy_qty: 30, sell_qty: 12 }, // keep
        ],
      },
    };
    render(
      <FillStrengthPane
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
    const buyData = buySeries.setData.mock.calls[0][0];
    const sellData = sellSeries.setData.mock.calls[0][0];
    expect(buyData).toHaveLength(2);
    expect(sellData).toHaveLength(2);
    expect(buyData[0].time).toBe(0);
    expect(buyData[1].time).toBe(1);
    // sell series uses negative value
    expect(sellData[0].value).toBe(-8);
    expect(sellData[1].value).toBe(-12);
  });
});

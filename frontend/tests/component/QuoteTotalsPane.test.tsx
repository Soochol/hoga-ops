import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import QuoteTotalsPane from '../../src/chart/QuoteTotalsPane';
import { createVirtualAxis } from '../../src/util/virtualAxis';

const makeMockChart = () => {
  const seriesList: Array<{ setData: ReturnType<typeof vi.fn> }> = [];
  return {
    chart: {
      addSeries: vi.fn(() => {
        const s = { setData: vi.fn() };
        seriesList.push(s);
        return s;
      }),
      removeSeries: vi.fn(),
    } as any,
    seriesList,
  };
};

describe('QuoteTotalsPane', () => {
  it('adds two LineSeries on the same paneIndex and maps bid/ask totals', () => {
    const { chart, seriesList } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    render(
      <QuoteTotalsPane
        chart={chart}
        bundle={bundle}
        paneIndex={3}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    expect(chart.addSeries).toHaveBeenCalledTimes(2);
    expect(chart.addSeries.mock.calls[0][2]).toBe(3);
    expect(chart.addSeries.mock.calls[1][2]).toBe(3);
    const bidData = seriesList[0].setData.mock.calls[0][0];
    const askData = seriesList[1].setData.mock.calls[0][0];
    expect(bidData.map((d: any) => d.value)).toEqual([100, 150]);
    expect(askData.map((d: any) => d.value)).toEqual([200, 180]);
    expect(bidData[0].time).toBe(0);
    expect(askData[0].time).toBe(0);
    expect(bidData[1].time).toBe(1);
  });

  it('drops pre-open auction quote_ratio points via axis.contains', () => {
    const { chart, seriesList } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const bundle: any = {
      quote_ratio: {
        bucket_ms: 1000,
        points: [
          { t: sessionOpenMs - 30 * 60_000, bid_total: 99, ask_total: 99 },
          { t: sessionOpenMs, bid_total: 100, ask_total: 200 },
          { t: sessionOpenMs + 1000, bid_total: 150, ask_total: 180 },
        ],
      },
    };
    render(
      <QuoteTotalsPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    const bidData = seriesList[0].setData.mock.calls[0][0];
    const askData = seriesList[1].setData.mock.calls[0][0];
    expect(bidData).toHaveLength(2);
    expect(askData).toHaveLength(2);
    expect(bidData[0].value).toBe(100);
    expect(askData[0].value).toBe(200);
  });

  it('removes both series on unmount', () => {
    const { chart, seriesList } = makeMockChart();
    const sessionOpenMs = 1_779_062_400_000;
    const bundle: any = {
      quote_ratio: { bucket_ms: 1000, points: [{ t: sessionOpenMs, bid_total: 100, ask_total: 200 }] },
    };
    const { unmount } = render(
      <QuoteTotalsPane
        chart={chart}
        bundle={bundle}
        axis={createVirtualAxis([
          { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
        ])}
      />,
    );
    unmount();
    expect(chart.removeSeries).toHaveBeenCalledTimes(2);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[0]);
    expect(chart.removeSeries).toHaveBeenCalledWith(seriesList[1]);
  });
});

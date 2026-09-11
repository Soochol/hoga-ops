import { test, expect } from '@playwright/test';
import { retainRightPriceScaleWidth } from '../../src/chart/util/retainRightPriceScaleWidth';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';

const library = join(dirname(fileURLToPath(import.meta.resolve('lightweight-charts'))), 'lightweight-charts.standalone.development.js');

declare global {
  interface Window {
    LightweightCharts: typeof import('lightweight-charts');
    retainRightPriceScaleWidth: typeof retainRightPriceScaleWidth;
    axisWidthTest: { chart: IChartApi; volume: ISeriesApi<'Histogram'>; cleanup?: () => void };
  }
}

// Real canvas/layout regression. React/jsdom chart mocks cannot reproduce the
// feedback between axis text width, visible bars and histogram autoscale.
test('volume digit boundary settles without alternating axis widths', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.setContent('<div id="chart" style="width:900px;height:600px"></div>');
  await page.addScriptTag({ path: library });
  await page.addScriptTag({ content: `window.retainRightPriceScaleWidth = ${retainRightPriceScaleWidth.toString()}` });
  await page.evaluate(() => {
    const lib = window.LightweightCharts;
    const chart = lib.createChart(document.getElementById('chart')!, {
      width: 900, height: 600, crosshair: { mode: 0 },
      rightPriceScale: { borderVisible: false },
      layout: { attributionLogo: false }, timeScale: { barSpacing: 12 },
    });
    const candle = chart.addSeries(lib.CandlestickSeries);
    const volume = chart.addSeries(lib.HistogramSeries, {
      priceFormat: { type: 'custom', formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'), minMove: 1 },
      priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false,
    }, 1);
    candle.setData(Array.from({ length: 120 }, (_, i) => ({
      time: (1700000000 + i * 86400) as UTCTimestamp, open: 100, high: 110, low: 90, close: 105,
    })));
    chart.panes()[0].setStretchFactor(1);
    chart.panes()[1].setStretchFactor(0.3);
    window.axisWidthTest = { chart, volume, cleanup: window.retainRightPriceScaleWidth(chart) };
  });

  const traces = [];
  // First show the large bar, then put it exactly outside the left boundary.
  for (const from of [39.98, 40]) {
    traces.push(await page.evaluate(async from => {
      const { chart, volume } = window.axisWidthTest;
      volume.setData(Array.from({ length: 120 }, (_, i) => ({
        time: (1700000000 + i * 86400) as UTCTimestamp,
        value: i === 39 ? 10000000 : i === 60 ? 900000 : 100000,
      })));
      chart.timeScale().setVisibleLogicalRange({ from, to: 110 });
      const samples = [];
      for (let i = 0; i < 16; i++) {
        // Force repeated layouts, independently of live data or hover timing.
        chart.applyOptions({});
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push({ width: chart.priceScale('right').width(), from: chart.timeScale().getVisibleLogicalRange()!.from });
      }
      return samples.slice(8);
    }, from));
  }
  for (const samples of traces) {
    expect(new Set(samples.map(s => s.width)).size, JSON.stringify(samples)).toBe(1);
    expect(new Set(samples.map(s => s.from)).size, JSON.stringify(samples)).toBe(1);
  }
  await page.evaluate(() => {
    window.axisWidthTest.cleanup?.();
    window.axisWidthTest.chart.remove();
  });
});

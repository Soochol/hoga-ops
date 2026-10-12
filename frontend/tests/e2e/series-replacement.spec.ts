import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { replaceSeriesData } from '../../src/chart/replaceSeriesData';

const library = join(dirname(fileURLToPath(import.meta.resolve('lightweight-charts'))), 'lightweight-charts.standalone.development.js');

declare global {
  interface Window {
    replaceSeriesData: typeof replaceSeriesData;
  }
}

// Actual lwc hit-testing is required: mocked setData cannot expose stale
// render-item indices while another series reindexes the shared time scale.
test('replacing stock data with pending line options does not hit-test stale bars', async ({ page }) => {
  // Load the actual module, including its adapter ownership dependency. A
  // stringified function silently loses imports as production code evolves.
  await page.route('**/__series-replacement', route => route.fulfill({
    contentType: 'text/html', body: '<div id="chart"></div>',
  }));
  await page.goto('/__series-replacement');
  await page.addScriptTag({ path: library });
  await page.evaluate(async () => {
    const path = '/src/chart/replaceSeriesData.ts';
    window.replaceSeriesData = (await import(path)).replaceSeriesData;
  });
  const result = await page.evaluate(async () => {
    const { createChart, LineSeries } = window.LightweightCharts;
    const chart = createChart(document.getElementById('chart')!, { width: 900, height: 500 });
    const lines = Array.from({ length: 2 }, () => chart.addSeries(LineSeries));
    const rows = (offset: number, count: number) => Array.from({ length: count }, (_, i) => ({
      time: (1700000000 + offset + i * 60) as import('lightweight-charts').UTCTimestamp,
      value: 100 + i,
    }));
    try {
      const previous = lines.map((series, i) => {
        const data = rows(i * 600, 100 - i * 10);
        series.setData(data);
        return data;
      });
      chart.timeScale().fitContent();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      chart.setCrosshairPosition(150, 1700003000 as import('lightweight-charts').UTCTimestamp, lines[0]);
      lines.forEach(series => series.applyOptions({ color: 'blue' }));
      lines.forEach((series, i) => window.replaceSeriesData(chart, series, rows(3600, 20), previous[i]));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      return { error: null, lengths: lines.map(series => series.data().length) };
    } catch (error) {
      return { error: String(error), lengths: [] };
    } finally {
      chart.remove();
    }
  });
  expect(result.error).toBeNull();
  expect(result.lengths).toEqual([20, 20]);
});

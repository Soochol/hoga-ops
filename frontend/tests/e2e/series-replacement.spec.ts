import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceSeriesData } from '../../src/chart/replaceSeriesData';

const library = join(dirname(fileURLToPath(import.meta.resolve('lightweight-charts'))), 'lightweight-charts.standalone.development.js');

declare global {
  interface Window {
    replaceSeriesData: typeof replaceSeriesData;
  }
}

// Actual lwc hit-testing is required: mocked setData cannot expose stale
// render-item indices while another series reindexes the shared time scale.
test('replacing stock data with pending line options does not hit-test stale bars', async ({ page }) => {
  await page.setContent('<div id="chart"></div>');
  await page.addScriptTag({ path: library });
  await page.addScriptTag({ content: `window.replaceSeriesData = ${replaceSeriesData.toString()}` });
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

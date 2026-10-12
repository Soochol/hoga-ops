import { test, expect, type Page } from '@playwright/test';
import type { CandlestickData, IChartApi, Time } from 'lightweight-charts';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';

type ChartWindow = Window & { __liveCharts: Map<string, IChartApi> };

async function hoverPixels(page: Page) {
  return page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const tops = [...chart.chartElement().querySelectorAll('canvas')].filter(c => c.style.zIndex === '2');
    const plot = [...chart.panes()[0].getHTMLElement()!.querySelectorAll('canvas')]
      .find(c => c.style.zIndex === '2' && Math.abs(c.clientWidth - chart.timeScale().width()) < 1)!;
    const ink = (c: HTMLCanvasElement) => {
      const rgba = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const columns = new Uint32Array(c.width);
      let total = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) { total++; columns[((i - 3) / 4) % c.width]++; }
      let x = 0;
      for (let i = 1; i < columns.length; i++) if (columns[i] > columns[x]) x = i;
      return { total, x: x * c.clientWidth / c.width };
    };
    return { plot: ink(plot),
      price: tops.filter(c => c.clientWidth < 150 && c.clientHeight > 50).reduce((n, c) => n + ink(c).total, 0),
      time: tops.filter(c => c.clientWidth > 150 && c.clientHeight < 50).reduce((n, c) => n + ink(c).total, 0),
    };
  });
}

async function settleDraw(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('stationary crosshair and axis labels survive data updates, rewindowing and whitespace hover', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-10-01T17:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const end = Date.UTC(2026, 9, 1);
  const candles = Array.from({ length: 30 }, (_, d) => end - (29 - d) * 86400000)
    .filter(ms => ![0, 6].includes(new Date(ms).getUTCDay()))
    .flatMap((ms, d) => Array.from({ length: 390 }, (_, i) => {
      const close = 35000 + d * 10 + i / 100;
      return { t_ms: ms + i * 60000, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
    }));
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: '098460', date: '20261001', session_open_ms: end, session_close_ms: end + 390 * 60000,
    is_open: false, snapshots: [], trades: [], brokers: [],
  } }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '098460', from: '20260902', to: '20261001', bucket_ms: 60000, candles,
    cached_dates: [], fresh_dates: [], data_warnings: [],
  } }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/live?code=098460');
  await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
  await expect(page.locator('[data-drawing-overlay]').first()).toHaveAttribute('data-day-extremes-ready', 'true');
  await page.waitForFunction(() => [...((window as unknown as ChartWindow).__liveCharts?.values() ?? [])]
    .some(c => c.panes()[0].getSeries().some(s => s.seriesType() === 'Candlestick' && s.data().length > 4000)));
  await page.evaluate(async () => { await document.fonts.ready; });
  await settleDraw(page);
  const box = await page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    chart.timeScale().setVisibleLogicalRange({ from: 1000, to: 1150 });
    const rect = chart.panes()[0].getHTMLElement()!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: chart.timeScale().width(), height: rect.height };
  });
  await settleDraw(page);
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .6);
  // Plot and axis canvases can finish on different draws during auto-sizing.
  // Establish all three surfaces before sampling the stationary baseline.
  await expect.poll(async () => {
    const hover = await hoverPixels(page);
    return hover.plot.total > 100 && hover.price > 0 && hover.time > 0;
  }).toBe(true);
  const before = await hoverPixels(page);
  expect(before.price).toBeGreaterThan(0);
  expect(before.time).toBeGreaterThan(0);

  // Change real adapter data without any new physical mouse input. Cover both
  // a cheap tail update and a full replacement that keeps the time grid.
  for (const mode of ['tail', 'values', 'grid', 'rewindow'] as const) {
    await page.evaluate(async mode => {
      const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
      const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
      const rows = series.data() as CandlestickData<Time>[];
      if (mode === 'tail') series.update({ ...rows.at(-1)!, close: rows.at(-1)!.close + .1 });
      if (mode === 'values') series.setData(rows.map(p => 'close' in p ? { ...p, close: p.close + .1 } : p));
      if (mode === 'grid') {
        const path = '/src/chart/replaceSeriesData.ts';
        const { replaceSeriesData } = await import(path);
        replaceSeriesData(chart, series, rows.filter((_, i) => i !== 1050), rows);
      }
      if (mode === 'rewindow') chart.timeScale().setVisibleLogicalRange({ from: 1600, to: 1750 });
      const path = '/src/chart/windowedChart.ts';
      const { flushWindowedChart } = await import(path);
      flushWindowedChart(chart);
    }, mode);
    await settleDraw(page);
    const after = await hoverPixels(page);
    expect(after.plot.total, mode).toBeGreaterThan(100);
    expect(Math.abs(after.plot.x - before.plot.x), mode).toBeLessThan(1);
    expect(after.price, mode).toBeGreaterThan(0);
    expect(after.time, mode).toBeGreaterThan(0);
  }

  // Beyond the final candle, time is undefined. Preserve the actual pixel,
  // rather than snapping a sync crosshair to the last available Time.
  await page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const last = chart.timeScale().timeToIndex(series.data().at(-1)!.time)!;
    chart.timeScale().setVisibleLogicalRange({ from: last - 100, to: last + 100 });
  });
  await settleDraw(page);
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .6);
  await settleDraw(page);
  const blank = await hoverPixels(page);
  await page.evaluate(async () => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    const path = '/src/chart/replaceSeriesData.ts';
    const { replaceSeriesData } = await import(path);
    const rows = series.data();
    replaceSeriesData(chart, series, rows.filter((_, i) => i !== rows.length - 50), rows);
  });
  await settleDraw(page);
  const afterBlank = await hoverPixels(page);
  expect(afterBlank.plot.total).toBeGreaterThan(100);
  expect(Math.abs(afterBlank.plot.x - blank.plot.x)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('stationary-crosshair.png') });

  // A real leave wins over data refresh and must not resurrect the crosshair.
  await page.mouse.move(1, 1);
  await page.evaluate(() => {
    const chart = [...(window as unknown as ChartWindow).__liveCharts.values()][0];
    const series = chart.panes()[0].getSeries().find(s => s.seriesType() === 'Candlestick')!;
    series.setData(series.data().slice(1));
  });
  await settleDraw(page);
  expect((await hoverPixels(page)).plot.total).toBe(0);
  expect(errors).toEqual([]);
});

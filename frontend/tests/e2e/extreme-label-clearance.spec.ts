import { expect, test } from '@playwright/test';

test('extreme labels preserve candle visibility through resize, pan and crowded fallback', async ({ page }, testInfo) => {
  // Isolated same-origin canvas: production primitive + real chart renderer,
  // deterministic candles, no vendor requests or changes to saved workspaces.
  await page.route('**/extreme-label-harness', route => route.fulfill({
    contentType: 'text/html', body: '<html><body style="margin:0;background:#121216"><div id="chart"></div></body></html>',
  }));
  await page.goto('/extreme-label-harness');
  await page.evaluate(async () => {
    const libraryUrl = '/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs';
    const primitiveUrl = '/src/chart/HighLowLabelsPrimitive.ts';
    const axisUrl = '/src/util/virtualAxis.ts';
    const [{ createChart, CandlestickSeries }, { HighLowLabelsPrimitive }, { createVirtualAxis }] = await Promise.all([
      import(libraryUrl), import(primitiveUrl), import(axisUrl),
    ]);
    const open = Date.UTC(2026, 8, 8, 0);
    const axis = createVirtualAxis([{ date: '20260908', sessionOpenMs: open, sessionCloseMs: open + 23400000 }], open);
    const candles = Array.from({ length: 20 }, (_, i) => ({
      ts_ms: open + i * 60000, open: 110 + i % 5, close: 113 + i % 5,
      high: i === 6 ? 140 : 120 + i % 5, low: i === 13 ? 80 : 105 + i % 5, vol_a: 0, vol_b: 0,
    }));
    const chart = createChart(document.getElementById('chart'), {
      width: 600, height: 160,
      layout: { background: { color: '#121216' }, textColor: '#ddd' },
      rightPriceScale: { scaleMargins: { top: 0.02, bottom: 0.02 } },
      timeScale: { barSpacing: 22 },
    });
    const series = chart.addSeries(CandlestickSeries, { borderVisible: false, priceLineVisible: false, lastValueVisible: false });
    series.setData(candles.map(c => ({ ...c, time: axis.toVirtual(c.ts_ms) / 1000 })));
    chart.timeScale().fitContent();
    const line = { on: false, color: '', width: 1 };
    const snapshot = { candles, axis, avoidWallLabels: [], avoidRankArrows: [], avoidRankArrowLimit: 0, legendRects: [], levelLines: { high: line, low: line }, priorDayLines: { high: line, low: line } };
    const primitive = new HighLowLabelsPrimitive(() => snapshot);
    let details: { rect: { left: number; right: number; top: number; bottom: number }; text: string }[] = [];
    let generation = 0;
    const original = primitive.setDetails.bind(primitive);
    primitive.setDetails = (next: typeof details) => { details = next; if (next.length) generation++; original(next); };
    series.attachPrimitive(primitive);
    Object.assign(window, { extremeProbe: {
      check: () => ({
        count: details.length, generation,
        overlaps: details.filter(d => d.rect.right - d.rect.left > 12).some(d => candles.some(c => {
          const x = chart.timeScale().timeToCoordinate(axis.toVirtual(c.ts_ms) / 1000);
          const high = series.priceToCoordinate(c.high), low = series.priceToCoordinate(c.low);
          const half = chart.timeScale().options().barSpacing / 2;
          return x !== null && high !== null && low !== null && d.rect.left < x + half && d.rect.right > x - half && d.rect.top < low && d.rect.bottom > high;
        })),
        markers: details.filter(d => d.rect.right - d.rect.left === 12).length,
      }),
      pan: () => { chart.resize(380, 130); chart.timeScale().setVisibleLogicalRange({ from: 3, to: 16 }); },
      crowd: () => { Object.assign(snapshot, { legendRects: [{ left: 0, right: 600, top: 0, bottom: 160 }] }); primitive.requestUpdate(); },
    } });
  });
  const check = () => page.evaluate(() => (window as unknown as { extremeProbe: { check(): {count: number; generation: number; overlaps: boolean; markers: number} } }).extremeProbe.check());
  await expect.poll(async () => (await check()).count).toBe(2);
  expect((await check()).overlaps).toBe(false);
  await page.locator('#chart').screenshot({ path: testInfo.outputPath('extreme-label-clearance.png') });
  const beforePan = (await check()).generation;
  await page.evaluate(() => (window as unknown as { extremeProbe: { pan(): void } }).extremeProbe.pan());
  await expect.poll(async () => (await check()).count).toBe(2);
  await expect.poll(async () => (await check()).generation).toBeGreaterThan(beforePan);
  expect((await check()).overlaps).toBe(false);
  await page.evaluate(() => (window as unknown as { extremeProbe: { crowd(): void } }).extremeProbe.crowd());
  await expect.poll(async () => (await check()).markers).toBe(2);
});

import { test, expect } from '@playwright/test';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { IChartApi } from 'lightweight-charts';

test.use({ deviceScaleFactor: 1.35 });

test('stationary hover snapshots do not enlarge the scrollable chart surface', async ({ page }, info) => {
  await page.setViewportSize({ width: 2766, height: 1406 });
  await page.route(url => url.pathname === '/', r => r.fulfill({ contentType: 'text/html', body:
    '<html><head><style>*::-webkit-scrollbar{width:8px;height:8px}</style></head><body style="margin:0"><script>window.$RefreshSig$=()=>type=>type;window.$RefreshReg$=()=>{};window.__vite_plugin_react_preamble_installed=true;</script></body></html>' }));
  await page.goto('/');
  await page.evaluate(async () => {
    const path = '/node_modules/lightweight-charts/dist/lightweight-charts.development.mjs';
    const { createChart, CandlestickSeries, HistogramSeries } = await import(path);
    const crosshairPath = '/src/chart/persistentCrosshair.ts';
    const { createPersistentCrosshairChart } = await import(crosshairPath);
    const viewport = document.createElement('div'); viewport.id = 'scrollbar-viewport';
    Object.assign(viewport.style, { width: '2410.01px', height: '1292.05px', overflowY: 'auto', overflowX: 'hidden' });
    const surface = document.createElement('div');
    Object.assign(surface.style, { position: 'relative', width: '100%', height: '100%', minHeight: '209px' });
    const host = document.createElement('div');
    Object.assign(host.style, { width: '100%', height: '100%' });
    viewport.append(surface); surface.append(host); document.body.append(viewport);
    const chart = createPersistentCrosshairChart(createChart(host, { autoSize: true, layout: { attributionLogo: false } }));
    const candles = chart.addSeries(CandlestickSeries);
    const volume = chart.addSeries(HistogramSeries, {}, 1);
    const rows = Array.from({ length: 300 }, (_, i) => ({ time: 1700000000 + i * 180, open: 100, high: 101, low: 99, close: 100 }));
    candles.setData(rows); volume.setData(rows.map(r => ({ time: r.time, value: 10 })));
    chart.panes()[0].setStretchFactor(2); chart.panes()[1].setStretchFactor(1);
    chart.timeScale().setVisibleLogicalRange({ from: 100, to: 250 });
    (window as unknown as { scrollbarChart: typeof chart }).scrollbarChart = chart;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.mouse.move(1200, 400);
  const result = await page.evaluate(async () => {
    const path = '/src/chart/persistentCrosshair.ts';
    const { preserveCrosshairDuringDataChange } = await import(path);
    const viewport = document.getElementById('scrollbar-viewport')!;
    const chart = (window as unknown as { scrollbarChart: import('lightweight-charts').IChartApi }).scrollbarChart;
    const read = () => ({ h: viewport.clientHeight, sh: viewport.scrollHeight, w: viewport.clientWidth,
      copies: viewport.querySelectorAll('[data-persistent-crosshair] canvas').length });
    const before = read();
    let during = before;
    preserveCrosshairDuringDataChange(chart, () => { during = read(); });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { before, during, after: read() };
  });
  await info.attach('scrollbar-geometry', { body: JSON.stringify(result), contentType: 'application/json' });
  console.log(JSON.stringify(result));
  expect(result.during.copies).toBeGreaterThan(0);
  expect(result.during.sh).toBe(result.before.sh);
  expect(result.during.w).toBe(result.before.w);
});

test('maximized LiveChartRoot keeps its scroll geometry while wheeling over a stationary crosshair', async ({ page }, info) => {
  await page.setViewportSize({ width: 2766, height: 1486 });
  await page.clock.setFixedTime(new Date('2026-10-15T22:00:00+09:00'));
  await installLiveMocks(page);
  await page.routeWebSocket(/\/api\/ws/, () => {});
  const end = Date.UTC(2026, 9, 15);
  const day = 86400000;
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
  const from = ymd(end - 60 * day);
  const candles = Array.from({ length: 60 }, (_, d) => end - (59 - d) * day)
    .filter(ms => ![0, 6].includes(new Date(ms).getUTCDay()))
    .flatMap((ms, d) => Array.from({ length: 130 }, (_, i) => ({ t_ms: ms + i * 180000,
      open: 61000 + d * 10, high: 61100 + d * 10, low: 60900 + d * 10,
      close: 61000 + d * 10, volume: 100 + i })));
  await page.route(apiExact('live/series'), route => route.fulfill({ json: {
    code: '034020', date: '20261015', session_open_ms: end, session_close_ms: end + 390 * 60000,
    is_open: false, snapshots: [], trades: [], brokers: [],
  } }));
  await page.route(apiExact('live/past-candles'), route => route.fulfill({ json: {
    code: '034020', from, to: '20261015', bucket_ms: 180000, candles,
    cached_dates: [], fresh_dates: [], data_warnings: [],
  } }));
  await page.goto('/live?code=034020');
  const id = await page.evaluate(async () => {
    const path = '/src/state/workspace.ts';
    const { useWorkspaceStore: store } = await import(path);
    const win = store.getState().windows.find((w: { kind: string }) => w.kind === 'chart');
    store.getState().setChartTimeframe(win.id, '3m');
    store.getState().toggleMaximize(win.id);
    return win.id as string;
  });
  type MeasuredWindow = Window & { __liveCharts: Map<string, IChartApi>;
    scrollbarEvidence: { samples: { h: number; sh: number; w: number; copies: number }[]; stop: () => void } };
  await expect.poll(() => page.evaluate(id => (window as unknown as MeasuredWindow).__liveCharts?.get(id)?.panes()[0]
    .getSeries().find(s => s.seriesType() === 'Candlestick')?.data().length ?? 0, id)).toBeGreaterThan(4000);
  await expect(page.getByTestId('chart-reveal-cover').first()).toHaveCSS('opacity', '0');
  const evidence = [];
  for (const height of [1486, 1424]) {
    await page.setViewportSize({ width: 2766, height });
    const point = await page.evaluate(async id => {
      const c = (window as unknown as MeasuredWindow).__liveCharts.get(id)!;
      c.timeScale().setVisibleLogicalRange({ from: 1800, to: 1950 });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const rect = c.panes()[0].getHTMLElement()!.getBoundingClientRect();
      const root = c.chartElement().closest('[data-testid="live-chart-root"]') as HTMLElement;
      const samples: MeasuredWindow['scrollbarEvidence']['samples'] = [];
      const read = () => samples.push({ h: root.clientHeight, sh: root.scrollHeight, w: root.clientWidth,
        copies: root.querySelectorAll('[data-persistent-crosshair]').length });
      const observer = new MutationObserver(read);
      observer.observe(root, { subtree: true, childList: true });
      (window as unknown as MeasuredWindow).scrollbarEvidence = { samples, stop: () => observer.disconnect() };
      read();
      return { x: rect.x + c.timeScale().width() * .55, y: rect.y + rect.height * .5 };
    }, id);
    await page.mouse.move(point.x, point.y);
    for (const delta of [3000, -3000, 500, 500, -500, -500, 1000, -1000, 120, -120]) {
      await page.mouse.wheel(0, delta);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    const samples = await page.evaluate(() => {
      const e = (window as unknown as MeasuredWindow).scrollbarEvidence;
      e.stop(); return e.samples;
    });
    evidence.push({ height, samples });
    console.log(JSON.stringify({ height, samples }));
    expect(samples.every(s => s.sh <= s.h), JSON.stringify(samples)).toBe(true);
    expect(new Set(samples.map(s => s.w)).size).toBe(1);
  }
  expect(evidence.some(e => e.samples.some(s => s.copies > 0))).toBe(true);
  await info.attach('maximized-wheel-scrollbar', { body: JSON.stringify(evidence), contentType: 'application/json' });
});

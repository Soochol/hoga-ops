/** Opt-in, fixed-delay regression workload. This is not a vendor latency forecast.
 * HOGA_RUN_COLD_BENCHMARK=1 HOGA_COLD_BENCH_LABEL=before npx playwright test live-cold-switch-benchmark
 */
import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installLiveMocks } from './helpers/liveMocks';
import { apiExact } from './helpers/apiRoutes';
import type { WorkspaceWindow } from '../../src/state/workspace';
import type { IChartApi } from 'lightweight-charts';

const legacy = process.env.HOGA_COLD_BENCH_LEGACY === '1';

test('cold switch and latest-book revisit @benchmark', async ({ browser }, info) => {
  test.skip(process.env.HOGA_RUN_COLD_BENCHMARK !== '1', 'opt-in performance experiment');
  test.setTimeout(120000);
  const results = [];
  const errors: string[] = [];
  const updateWarnings: string[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.text().includes('Maximum update depth exceeded')) updateWarnings.push(message.text());
    });
    await page.clock.install({ time: new Date('2026-10-19T10:00:00+09:00') });
    await installLiveMocks(page);
    if (legacy) {
      // Test-served counterfactual only: restore the original three decisions.
      // Production has no performance-policy override or query parameter.
      await page.route(/\/src\/live\/LiveChartRoot\.tsx(?:\?.*)?$/, async route => {
        const response = await route.fetch();
        let body = await response.text();
        const changes = [
          ['const SIDECAR_REVEAL_CAP_MS = 200;', 'const SIDECAR_REVEAL_CAP_MS = 700;'],
          ['const waitingOnSidecar = (isSidecarLoading || isHogaLoading) && !isPastCandlesLoading;',
            'const waitingOnSidecar = isSidecarLoading && !isPastCandlesLoading && !isHogaLoading;'],
          ['if ((!isHogaLoading || sidecarCapReached) && !sidecarBlocking) reveal();',
            'if (!isHogaLoading && !sidecarBlocking) reveal();'],
        ];
        for (const [before, after] of changes) { expect(body).toContain(before); body = body.replace(before, after); }
        await route.fulfill({ response, body });
      });
      await page.route(/\/src\/api\/sharedLiveSeries\.ts(?:\?.*)?$/, async route => {
        const response = await route.fetch();
        const body = await response.text();
        expect(body).toContain('const saved = retainedBooks.get(key);');
        await route.fulfill({ response, body: body.replace('const saved = retainedBooks.get(key);', 'const saved = undefined;') });
      });
    }
    const codes = ['005930', '000660', '035420'];
    const price = (code: string) => 10000 + Number(code);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const days = Array.from({ length: 80 }, (_, i) => Date.UTC(2026, 9, 19 - i))
      .filter(ms => ![0, 6].includes(new Date(ms).getUTCDay())).reverse();
    const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
    let pending = 0;
    let lastFinish = 0;
    const requests: { code: string; path: string }[] = [];
    await page.routeWebSocket(/\/api\/ws/, ws => {
      ws.onMessage(async raw => {
        const message = JSON.parse(String(raw));
        if (message.action !== 'subscribe' || !message.code) return;
        const code = String(message.code);
        await wait(1000);
        if (page.isClosed()) return;
        ws.send(JSON.stringify({ ch: 'live_batch', code, data: [], dropped: 0, latest: [{
          kind: 'ob', venue: 'KRX', seq: Date.now(), t_ms: new Date('2026-10-19T10:00:00+09:00').getTime(),
          asks: [{ price: price(code) + 1, qty: 100 }], bids: [{ price: price(code) - 1, qty: 200 }],
        }] }));
      });
    });
    await page.route(apiExact('live/settings'), r => r.fulfill({ json: { rest_bypass_enabled: false, krx_prefer_hogaplay: false } }));
    await page.route(apiExact('symbols/all'), r => r.fulfill({ json: { status: 'fresh', symbols: codes.map(code => ({
      code, name: `Bench ${code}`, market: 'KOSPI', nxt_enabled: false,
    })) } }));
    for (const path of ['live/past-candles', 'live/past-daily-candles', 'live/series', 'range']) {
      await page.route(apiExact(path), async route => {
        const url = new URL(route.request().url());
        const code = url.searchParams.get('code') ?? '005930';
        const from = url.searchParams.get('from') ?? '20261019';
        const to = url.searchParams.get('to') ?? '20261019';
        const bucket = Number(url.searchParams.get('bucket_ms') ?? 180000);
        const sessions = days.filter(ms => ymd(ms) >= from && ymd(ms) <= to);
        const base = price(code);
        pending++;
        requests.push({ code, path: `${path}:${url.searchParams.get('mode') ?? ''}` });
        try {
          await wait(path === 'range' ? (url.searchParams.get('mode') === 'hoga' ? 900 : 1400)
            : path === 'live/past-candles' ? 80 : 120);
          const candles = sessions.flatMap(ms => Array.from({ length: path === 'live/past-daily-candles' ? 1 : Math.floor(23400000 / bucket) }, (_, i) => ({
            t_ms: ms + i * bucket, open: base, high: base + 2, low: base - 2, close: base + .5, volume: 100,
          })));
          const body = path === 'live/series' ? { code, date: '20261019', snapshots: [], trades: [], brokers: [],
            session_open_ms: Date.UTC(2026, 9, 19), session_close_ms: null, is_open: true, last_ob: null }
            : path === 'range' ? { code, from_date: from, to_date: to, bucket_ms: bucket,
              segments: sessions.map(ms => ({ date: ymd(ms), session_open_ms: ms, session_close_ms: ms + 23400000, source: 'kiwoom_live' })),
              candles: [], quote_ratio: { bucket_ms: bucket, points: [] }, fill_strength: { bucket_ms: bucket, points: [] },
              volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
              volume_profile_by_day: [], volume_distributions: [], investorPoints: [], ask_peaks: [], bid_peaks: [],
              trade_volume_pocs: [], broker_late_entries: [], excluded_dates: [], missing_dates: [], data_warnings: [] }
            : { code, from, to, bucket_ms: bucket, candles, cached_dates: sessions.map(ymd), fresh_dates: [], data_warnings: [] };
          await route.fulfill({ json: body });
        } finally { pending--; lastFinish = Date.now(); }
      });
    }
    await page.goto('/live?code=005930');
    const id = await page.evaluate(async () => {
      const path = '/src/state/workspace.ts';
      const { useWorkspaceStore: store } = await import(path);
      for (const win of [...store.getState().windows]) if (win.kind !== 'chart') store.getState().closeWindow(win.id);
      const first = store.getState().windows[0];
      store.getState().setChartTimeframe(first.id, '3m');
      const daily = store.getState().addWindow('chart');
      store.getState().setChartTimeframe(daily, 'D');
      for (const kind of ['investor', 'investor-daily', 'program', 'vdist', 'order']) store.getState().addWindow(kind);
      const windows = store.getState().windows.map((w: WorkspaceWindow, i: number) => ({ ...w, group: 1,
        rect: { x: i < 2 ? 0 : .65, y: i < 2 ? i * .45 : (i - 2) * .19, w: i < 2 ? .65 : .35, h: i < 2 ? .45 : .19 } }));
      store.getState().applyWorkspaceSnapshot({ windows, zOrder: [...windows.map((w: WorkspaceWindow) => w.id).filter((id: string) => id !== first.id), first.id], maximizedId: null });
      return first.id as string;
    });
    await expect.poll(() => pending).toBe(0);
    for (const [code, phase] of [['000660', 'cold'], ['035420', 'cold'], ['000660', 'revisit']] as const) {
      const started = Date.now();
      const beforeRequests = requests.length;
      const { chartMs, bookMs } = await page.evaluate(async ({ id, code, expectedPrice }) => {
        const path = '/src/state/workspace.ts';
        const { useWorkspaceStore: store } = await import(path);
        const started = performance.now();
        store.getState().setWindowSymbol(id, { code, name: `Bench ${code}`, kind: 'stock' });
        const charts = (window as unknown as { __liveCharts: Map<string, IChartApi> }).__liveCharts;
        return new Promise<{ chartMs: number; bookMs: number }>((resolve, reject) => {
          let chartMs: number | null = null;
          let bookMs: number | null = null;
          const check = () => {
            const elapsed = performance.now() - started;
            const chart = charts?.get(id);
            const series = chart?.panes()[0]?.getSeries().find(series => series.seriesType() === 'Candlestick');
            const last = series?.data().at(-1);
            const cover = document.querySelector('[data-testid="live-chart-root"] [data-testid="chart-reveal-cover"]');
            if (chartMs === null && last && 'close' in last && last.close === expectedPrice + .5
              && cover && getComputedStyle(cover).opacity === '0') chartMs = elapsed;
            if (bookMs === null && document.querySelector(`[data-testid="order-window"] [data-order-price="${expectedPrice + 1}"]`)) bookMs = elapsed;
            if (chartMs !== null && bookMs !== null) resolve({ chartMs, bookMs });
            else if (elapsed > 20000) reject(new Error(`readiness timeout for ${code}`));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
      }, { id, code, expectedPrice: price(code) });
      if (!legacy && repeat === 0 && code === '000660' && phase === 'cold') {
        const folder = resolve(process.env.HOGA_COLD_BENCH_OUTPUT ?? info.outputPath('cold-switch.json'), '..');
        await mkdir(folder, { recursive: true });
        await page.screenshot({ path: resolve(folder, 'improved-layout.png') });
      }
      await expect.poll(() => pending === 0 && Date.now() - lastFinish > 100).toBe(true);
      // Use the actual last completion timestamp; reporting the poll completion
      // would bias this metric when earlier chart/book waits change duration.
      const allResponsesMs = Math.max(lastFinish - started, chartMs, bookMs);
      results.push({ repeat, code, phase, chartMs, bookMs, allResponsesMs, requests: requests.length - beforeRequests });
    }
    await context.close();
  }
  const output = resolve(process.env.HOGA_COLD_BENCH_OUTPUT ?? info.outputPath('cold-switch.json'));
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify({ label: process.env.HOGA_COLD_BENCH_LABEL, browser: browser.version(),
    workload: { legacy, sevenWindows: true, candleMs: 80, hogaMs: 900, sidecarMs: 1400, latestBookAfterSubscribeMs: 1000,
      scope: 'synthetic transport delays; empty auxiliary cards; public book only; not real vendor/server load' }, results, errors, updateWarnings }, null, 2));
  expect(errors).toEqual([]);
  expect(updateWarnings).toEqual([]);
});
